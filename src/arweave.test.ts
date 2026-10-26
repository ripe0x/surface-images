import { strict as assert } from "node:assert"
import { test } from "node:test"
import { createHash } from "node:crypto"
import Arweave from "arweave"
import { CaptureFault, CaptureUploadExpired, createNativeArweaveUploader, sha256Hex } from "./arweave.ts"


const keyPromise = Arweave.init({}).wallets.generate()

const blockHash = (height: number) => createHash("sha384").update(String(height)).digest("base64url")

async function fixture(minConfirmations = 20) {
  const key = await keyPromise
  const client = Arweave.init({ host: "arweave.net", port: 443, protocol: "https" })
  const address = await client.wallets.jwkToAddress(key)
  client.transactions.getPrice = async () => "100"
  client.transactions.getTransactionAnchor = async () => blockHash(100)
  client.wallets.getBalance = async () => "1000"
  const activity = { reads: 0, signs: 0, blockReads: 0 }
  let tipHeight = 105
  const blockTransactions = new Map<number, string[]>()
  client.api.get = (async (path: string) => {
    activity.reads++
    if (path === "info") return { status: 200, data: { height: tipHeight, current: blockHash(tipHeight) } }
    activity.blockReads++
    const height = path.startsWith("block/height/") ? Number(path.slice("block/height/".length))
      : Array.from({ length: tipHeight + 1 }, (_, i) => i).find(i => blockHash(i) === path.slice("block/hash/".length))
    if (height === undefined || !Number.isSafeInteger(height)) return { status: 404 }
    return { status: 200, data: { height, indep_hash: blockHash(height), previous_block: blockHash(height - 1), txs: blockTransactions.get(height) ?? [] } }
  }) as typeof client.api.get
  const sign = client.transactions.sign.bind(client.transactions)
  client.transactions.sign = async (...args) => { activity.signs++; await sign(...args) }
  let status = 404
  let confirmations = 0
  let served: Buffer | undefined
  const posts: { path: string; id?: string }[] = []
  client.transactions.getStatus = async () => { activity.reads++; return { status, confirmed: status === 200 ? { number_of_confirmations: confirmations, block_height: 10, block_indep_hash: "block" } : null } }
  client.api.post = (async (path: string, transaction: { id?: string }) => {
    posts.push({ path, id: transaction.id })
    status = 202
    return { status: 200, statusText: "OK", data: {} }
  }) as typeof client.api.post
  const uploader = await createNativeArweaveUploader({
    jwkJson: JSON.stringify(key), expectedAddress: address, client, minConfirmations,
    fetchFn: async () => { activity.reads++; return served ? new Response(new Uint8Array(served)) : new Response(null, { status: 404 }) },
  })
  return { uploader, client, key, address, posts, activity, setTip: (height: number) => { tipHeight = height }, putInBlock: (height: number, id: string) => { blockTransactions.set(height, [id]) }, setStatus: (s: number, c = 0) => { status = s; confirmations = c }, serve: (data: Buffer) => { served = data } }
}

const tags = [{ name: "Content-Type", value: "image/png" }]

test("native upload signs once, persists only public signed data, and reuses accepted uploads", async () => {
  const f = await fixture()
  const png = Buffer.from("deterministic PNG")
  const prepared = await f.uploader.prepare(png, tags, 100n)
  assert.match(prepared.id, /^[\w-]{43}$/)
  assert.equal(prepared.signedTransaction.includes(Buffer.from(f.key.d!)), false)
  await f.uploader.upload(prepared.signedTransaction)
  assert.equal(f.posts.length, 1)
  assert.equal(f.posts[0].id, prepared.id)
  f.serve(png)
  await f.uploader.upload(prepared.signedTransaction)
  assert.equal(f.posts.length, 1)
})

test("lost accepted header response resumes chunks without a new signature or payment", async () => {
  const f = await fixture()
  const png = Buffer.alloc(300_000, 42)
  const prepared = await f.uploader.prepare(png, tags, 100n)
  let loseHeader = true
  f.client.api.post = (async (path: string, transaction: { id?: string }) => {
    f.posts.push({ path, id: transaction.id })
    if (path === "tx" && loseHeader) {
      loseHeader = false
      f.setStatus(202)
      throw new Error("response lost")
    }
    return { status: 200, statusText: "OK", data: {} }
  }) as typeof f.client.api.post
  await assert.rejects(f.uploader.upload(prepared.signedTransaction), /retry saved transaction/)
  f.client.wallets.getBalance = async () => { throw new Error("balance spent by accepted transaction") }
  await f.uploader.upload(prepared.signedTransaction)
  assert.equal(f.activity.signs, 1)
  assert.equal(f.posts.filter(p => p.path === "tx").length, 1)
  assert.ok(f.posts.some(p => p.path === "chunk"))
})

test("native upload requires expected wallet, fee cap, and balance before signing", async () => {
  const f = await fixture()
  await assert.rejects(createNativeArweaveUploader({ jwkJson: JSON.stringify(f.key), expectedAddress: "x".repeat(43), client: f.client }), /address mismatch/)
  await assert.rejects(createNativeArweaveUploader({ jwkJson: "invalid", expectedAddress: f.address, client: f.client }), /invalid Arweave JWK/)
  await assert.rejects(f.uploader.prepare(Buffer.from("PNG"), tags, 99n), /exceeds budget/)
  f.client.wallets.getBalance = async () => "99"
  await assert.rejects(f.uploader.prepare(Buffer.from("PNG"), tags, 100n), /underfunded/)
  assert.equal(f.posts.length, 0)
})

test("saved uploads reject byte, signed root, reward, transfer, and owner tampering", async () => {
  const f = await fixture()
  const prepared = await f.uploader.prepare(Buffer.from("PNG"), tags, 100n)
  for (const edit of [
    (saved: { transaction: Record<string, string> }) => { saved.transaction.data = Buffer.from("other").toString("base64url") },
    (saved: { transaction: Record<string, string> }) => { saved.transaction.data_root = "x".repeat(43) },
    (saved: { transaction: Record<string, string> }) => { saved.transaction.reward = "101" },
    (saved: { transaction: Record<string, string> }) => { saved.transaction.target = "x".repeat(43); saved.transaction.quantity = "1" },
    (saved: { transaction: Record<string, string> }) => { saved.transaction.owner = "x".repeat(43) },
    (saved: { transaction: Record<string, string> }) => { saved.transaction.signature = "x".repeat(100) },
  ]) {
    const saved = JSON.parse(prepared.signedTransaction.toString())
    edit(saved)
    await assert.rejects(f.uploader.upload(Buffer.from(JSON.stringify(saved))))
  }
  assert.equal(f.posts.length, 0)
})

test("verification gates publication on confirmations and exact gateway bytes", async () => {
  const f = await fixture()
  const png = Buffer.from("PNG")
  const { id } = await f.uploader.prepare(png, tags, 100n)
  const hash = sha256Hex(png)
  f.serve(png)
  assert.equal(await f.uploader.verify(id, hash), false)
  f.setStatus(202)
  assert.equal(await f.uploader.verify(id, hash), false)
  f.setStatus(200, 19)
  assert.equal(await f.uploader.verify(id, hash), false)
  f.setStatus(200, 20)
  assert.equal(await f.uploader.verify(id, hash), true)
  f.serve(Buffer.from("wrong PNG"))
  await assert.rejects(f.uploader.verify(id, hash), /byte mismatch/)
  f.setStatus(503)
  await assert.rejects(f.uploader.verify(id, hash), /status unavailable/)
  for (const count of [NaN, Infinity, 20.5]) {
    f.client.transactions.getStatus = async () => ({ status: 200, confirmed: {
      number_of_confirmations: count, block_height: 10, block_indep_hash: "block",
    } })
    assert.equal(await f.uploader.verify(id, hash), false, "malformed confirmation evidence cannot publish")
  }
})


test("saved upload enforces the current budget and expected job before any network request", async () => {
  const f = await fixture()
  const png = Buffer.from("PNG")
  const prepared = await f.uploader.prepare(png, tags, 100n)
  const expected = { id: prepared.id, sha256: sha256Hex(png), maxUploadWinston: 100n }
  const reads = f.activity.reads
  await assert.rejects(f.uploader.upload(prepared.signedTransaction, { ...expected, maxUploadWinston: 99n }), (error: unknown) => error instanceof CaptureFault && /current upload budget/.test(error.message))
  await assert.rejects(f.uploader.upload(prepared.signedTransaction, { ...expected, id: "x".repeat(43) }), /does not match capture job/)
  await assert.rejects(f.uploader.upload(prepared.signedTransaction, { ...expected, sha256: "0".repeat(64) }), /does not match capture job/)
  assert.equal(f.activity.reads, reads)
  assert.equal(f.posts.length, 0)
  await f.uploader.upload(prepared.signedTransaction, expected)
  assert.equal(f.posts.length, 1)
})


for (const status of [404, 202]) {
  test(`expired ${status === 404 ? "unposted" : "accepted but unmined"} upload produces a complete bounded absence proof without posting`, async () => {
    const f = await fixture()
    const png = Buffer.from("PNG")
    const prepared = await f.uploader.prepare(png, tags, 100n)
    f.setStatus(status)
    f.setTip(170)
    await assert.rejects(f.uploader.upload(prepared.signedTransaction), (error: unknown) => {
      assert.ok(error instanceof CaptureUploadExpired)
      assert.equal(error.proof.anchor, blockHash(100))
      assert.equal(error.proof.anchorHeight, 100)
      assert.equal(error.proof.checkedThroughHeight, 150)
      assert.equal(error.proof.tipHeight, 170)
      assert.equal(error.proof.tipHash, blockHash(170))
      assert.deepEqual(error.proof.blocks, Array.from({ length: 51 }, (_, i) => ({ height: 100 + i, hash: blockHash(100 + i) })))
      return true
    })
    assert.ok(f.activity.blockReads < 70)
    assert.equal(f.posts.length, 0)
    assert.equal(f.activity.signs, 1)
    await assert.rejects(f.uploader.verify(prepared.id, sha256Hex(png), prepared.signedTransaction), CaptureUploadExpired)
  })
}

test("canonical inclusion recovers a lost mined status, uploads chunks without reposting, and prevents replacement", async () => {
  const f = await fixture()
  const png = Buffer.alloc(300_000, 42)
  const prepared = await f.uploader.prepare(png, tags, 100n)
  f.setStatus(404)
  f.setTip(170)
  f.putInBlock(150, prepared.id)
  f.client.wallets.getBalance = async () => { throw new Error("already spent") }
  await f.uploader.upload(prepared.signedTransaction)
  assert.equal(f.posts.filter(post => post.path === "tx").length, 0)
  assert.ok(f.posts.some(post => post.path === "chunk"))
  assert.equal(f.activity.signs, 1)
  f.setStatus(404)
  f.serve(png)
  assert.equal(await f.uploader.verify(prepared.id, sha256Hex(png), prepared.signedTransaction), true)
})

for (const [required, tipHeight] of [[1, 169], [30, 179]]) {
  test(`expiry recovery waits for at least 20 and configured ${required} confirmations`, async () => {
    const f = await fixture(required)
    const prepared = await f.uploader.prepare(Buffer.from("PNG"), tags, 100n)
    f.setTip(tipHeight)
    await f.uploader.upload(prepared.signedTransaction)
    assert.equal(f.posts.length, 1)
    assert.ok(f.activity.blockReads < 10)
    assert.equal(await f.uploader.verify(prepared.id, sha256Hex(Buffer.from("PNG")), prepared.signedTransaction), false)
  })
}

test("missing, malformed, orphaned, discontinuous, or changing chain evidence never authorizes a replacement", async () => {
  for (const failure of ["unavailable", "malformed", "orphaned", "discontinuous", "changed checkpoint", "changed tip"]) {
    const f = await fixture()
    const prepared = await f.uploader.prepare(Buffer.from("PNG"), tags, 100n)
    f.setTip(170)
    const get = f.client.api.get.bind(f.client.api)
    let checkpointReads = 0
    f.client.api.get = (async (path: string) => {
      const response = await get(path)
      if (path === "block/height/150") checkpointReads++
      if (failure === "unavailable" && path === "block/height/125") return { status: 503 }
      if (failure === "malformed" && path === "block/height/125") return { status: 200, data: { ...response.data as object, txs: undefined } }
      if ((failure === "orphaned" && path === "block/height/100")
        || (failure === "changed checkpoint" && path === "block/height/150" && checkpointReads === 2)
        || (failure === "changed tip" && path === "block/height/170")) {
        return { status: 200, data: { ...response.data as object, indep_hash: blockHash(999) } }
      }
      if (failure === "discontinuous" && path === "block/height/125") return { status: 200, data: { ...response.data as object, previous_block: blockHash(999) } }
      return response
    }) as typeof f.client.api.get
    await assert.rejects(f.uploader.upload(prepared.signedTransaction), (error: unknown) => {
      assert.ok(error instanceof CaptureFault)
      assert.equal(error instanceof CaptureUploadExpired, false, failure)
      return true
    })
    assert.equal(f.posts.length, 0, failure)
    assert.equal(f.activity.signs, 1, failure)
  }
})
