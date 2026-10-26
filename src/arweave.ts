import Arweave from "arweave"
import { createHash } from "node:crypto"

export const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex")

/** Safe-to-log failure: its message never carries provider URLs or key material. */
export class CaptureFault extends Error {}

/** Public evidence that a block-anchored upload can no longer be included. */
export interface ArweaveExpiryProof {
  anchor: string
  anchorHeight: number
  checkedThroughHeight: number
  tipHeight: number
  tipHash: string
  blocks: { height: number; hash: string }[]
}

export class CaptureUploadExpired extends CaptureFault {
  readonly proof: ArweaveExpiryProof
  constructor(proof: ArweaveExpiryProof) {
    super("Arweave anchor expired without canonical inclusion; retrying the saved PNG")
    this.proof = proof
  }
}

export const NATIVE_ARWEAVE_GATEWAY = "https://arweave.net"
const ID = /^[A-Za-z0-9_-]{43}$/
const BLOCK_HASH = /^[A-Za-z0-9_-]{64}$/
// A block at H can anchor inclusion through H+50; wait a further confirmation margin.
const MAX_ANCHOR_DEPTH = 50
type ArweaveBlock = { height: number; indep_hash: string; previous_block: string; txs: string[] }
type Jwk = Exclude<Parameters<Arweave["wallets"]["jwkToAddress"]>[0], string | undefined>

export interface NativeArweaveOptions {
  jwkJson: string
  expectedAddress: string
  gateway?: string
  minConfirmations?: number
  client?: Arweave
  fetchFn?: typeof fetch
}

export interface NativeArweaveExpectedUpload {
  id: string
  sha256: string
  maxUploadWinston: bigint
}

interface SavedUpload {
  version: 1
  address: string
  sha256: string
  maxUploadWinston: string
  transaction: ReturnType<Awaited<ReturnType<Arweave["createTransaction"]>>["toJSON"]>
}

// Private wallet material is held only in memory; persisted uploads contain public signed transactions.
export async function createNativeArweaveUploader(options: NativeArweaveOptions) {
  let jwk: Jwk
  try { jwk = JSON.parse(options.jwkJson) }
  catch { throw new CaptureFault("invalid Arweave JWK JSON") }
  if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.d) throw new CaptureFault("Arweave signing JWK required")
  const gateway = new URL(options.gateway ?? NATIVE_ARWEAVE_GATEWAY)
  if (gateway.protocol !== "https:" || gateway.username || gateway.password || gateway.pathname !== "/" || gateway.search || gateway.hash) {
    throw new CaptureFault("Arweave gateway must be an HTTPS origin")
  }
  const client = options.client ?? Arweave.init({ host: gateway.hostname, port: Number(gateway.port || 443), protocol: "https", timeout: 30_000, logging: false })
  const address = await client.wallets.jwkToAddress(jwk)
  if (!ID.test(options.expectedAddress) || address !== options.expectedAddress) throw new CaptureFault("Arweave uploader address mismatch")
  const confirmations = options.minConfirmations ?? 20
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new CaptureFault("Arweave confirmations must be positive")
  const fetchFn = options.fetchFn ?? fetch

  async function bytesMatch(id: string, sha256: string): Promise<boolean> {
    if (!ID.test(id) || !/^[a-f0-9]{64}$/.test(sha256)) throw new CaptureFault("invalid Arweave verification input")
    const response = await fetchFn(`${gateway.origin}/${id}`, { signal: AbortSignal.timeout(30_000) })
    if (response.status === 404 || response.status === 202) return false
    if (!response.ok) throw new CaptureFault("Arweave data gateway unavailable")
    if (sha256Hex(Buffer.from(await response.arrayBuffer())) !== sha256) throw new CaptureFault("Arweave uploaded byte mismatch")
    return true
  }

  async function restore(saved: Buffer) {
    let envelope: SavedUpload
    try { envelope = JSON.parse(saved.toString("utf8")) }
    catch { throw new CaptureFault("invalid saved Arweave transaction") }
    if (!envelope || envelope.version !== 1 || envelope.address !== address || !envelope.transaction) throw new CaptureFault("saved Arweave uploader mismatch")
    const transaction = client.transactions.fromRaw(envelope.transaction)
    if (!ID.test(transaction.id) || transaction.owner !== jwk.n || transaction.quantity !== "0" || transaction.target !== "" || transaction.format !== 2) {
      throw new CaptureFault("saved Arweave transaction is not this wallet's data upload")
    }
    if (!/^\d+$/.test(transaction.reward) || !/^\d+$/.test(envelope.maxUploadWinston) || BigInt(transaction.reward) > BigInt(envelope.maxUploadWinston)) {
      throw new CaptureFault("saved Arweave transaction exceeds upload budget")
    }
    if (sha256Hex(Buffer.from(transaction.data)) !== envelope.sha256 || transaction.data_size !== String(transaction.data.length)) throw new CaptureFault("saved Arweave data mismatch")
    const signedRoot = transaction.data_root
    await transaction.prepareChunks(transaction.data)
    if (transaction.data_root !== signedRoot || !await client.transactions.verify(transaction)) throw new CaptureFault("saved Arweave transaction signature or data root mismatch")
    return { transaction, sha256: envelope.sha256 }
  }

  async function block(path: string): Promise<ArweaveBlock> {
    const response = await client.api.get<ArweaveBlock>(path)
    const value = response.data
    if (response.status !== 200 || !value || !Number.isSafeInteger(value.height) || value.height < 0
      || !BLOCK_HASH.test(value.indep_hash) || !BLOCK_HASH.test(value.previous_block)
      || !Array.isArray(value.txs) || !value.txs.every(id => typeof id === "string" && ID.test(id))) {
      throw new CaptureFault("Arweave expiry evidence unavailable or malformed")
    }
    return value
  }

  async function checkExpiry(transaction: Awaited<ReturnType<Arweave["createTransaction"]>>): Promise<boolean> {
    // Wallet anchors have different validity rules; never infer expiry for an unknown anchor type.
    if (!BLOCK_HASH.test(transaction.last_tx)) throw new CaptureFault("Arweave upload block anchor required for expiry recovery")
    const anchor = await block(`block/hash/${transaction.last_tx}`)
    if (anchor.indep_hash !== transaction.last_tx) throw new CaptureFault("Arweave anchor evidence mismatch")
    const canonicalAnchor = await block(`block/height/${anchor.height}`)
    if (canonicalAnchor.height !== anchor.height || canonicalAnchor.indep_hash !== anchor.indep_hash) throw new CaptureFault("Arweave anchor is not canonical; retain signed upload")
    const info = await client.api.get<{ height: number; current: string }>("info")
    if (info.status !== 200 || !info.data || !Number.isSafeInteger(info.data.height) || !BLOCK_HASH.test(info.data.current)) throw new CaptureFault("Arweave chain tip unavailable")
    const tip = await block(`block/hash/${info.data.current}`)
    if (tip.height !== info.data.height || tip.indep_hash !== info.data.current) throw new CaptureFault("Arweave chain tip mismatch")
    const checkedThroughHeight = anchor.height + MAX_ANCHOR_DEPTH
    if (!Number.isSafeInteger(checkedThroughHeight) || tip.height < checkedThroughHeight + Math.max(20, confirmations)) return false
    async function assertStable(checkpoint: ArweaveBlock): Promise<void> {
      const stableTip = await block(`block/height/${tip.height}`)
      const stableCheckpoint = await block(`block/height/${checkpoint.height}`)
      if (stableTip.height !== tip.height || stableTip.indep_hash !== tip.indep_hash
        || stableCheckpoint.height !== checkpoint.height || stableCheckpoint.indep_hash !== checkpoint.indep_hash) {
        throw new CaptureFault("Arweave expiry evidence chain changed; retain signed upload")
      }
    }
    const blocks: ArweaveExpiryProof["blocks"] = [{ height: anchor.height, hash: anchor.indep_hash }]
    if (canonicalAnchor.txs.includes(transaction.id)) { await assertStable(canonicalAnchor); return true }
    let previous = canonicalAnchor
    for (let height = anchor.height + 1; height <= checkedThroughHeight; height++) {
      const next = await block(`block/height/${height}`)
      if (next.height !== height || next.previous_block !== previous.indep_hash) throw new CaptureFault("Arweave expiry evidence chain changed; retain signed upload")
      if (next.txs.includes(transaction.id)) { await assertStable(next); return true }
      blocks.push({ height, hash: next.indep_hash })
      previous = next
    }
    // Re-read the original tip and scanned checkpoint by height; advancing tips are safe, reorganizations are not.
    await assertStable(previous)
    throw new CaptureUploadExpired({ anchor: anchor.indep_hash, anchorHeight: anchor.height,
      checkedThroughHeight, tipHeight: tip.height, tipHash: tip.indep_hash, blocks })
  }

  return {
    address,
    async prepare(data: Buffer, tags: { name: string; value: string }[], maxUploadWinston: bigint): Promise<{ id: string; signedTransaction: Buffer }> {
      if (!data.length || maxUploadWinston <= 0n) throw new CaptureFault("nonempty Arweave upload and positive budget required")
      const transaction = await client.createTransaction({ data }, jwk)
      if (!/^\d+$/.test(transaction.reward) || BigInt(transaction.reward) > maxUploadWinston) throw new CaptureFault("Arweave upload exceeds budget")
      if (BigInt(await client.wallets.getBalance(address)) < BigInt(transaction.reward)) throw new CaptureFault("Arweave upload wallet underfunded")
      for (const tag of tags) transaction.addTag(tag.name, tag.value)
      await client.transactions.sign(transaction, jwk)
      const signedTransaction = Buffer.from(JSON.stringify({ version: 1, address, sha256: sha256Hex(data), maxUploadWinston: String(maxUploadWinston), transaction: transaction.toJSON() } satisfies SavedUpload))
      await restore(signedTransaction)
      return { id: transaction.id, signedTransaction }
    },
    async upload(saved: Buffer, expected?: NativeArweaveExpectedUpload): Promise<void> {
      const { transaction, sha256 } = await restore(saved)
      if (expected) {
        if (transaction.id !== expected.id || sha256 !== expected.sha256) throw new CaptureFault("saved Arweave upload does not match capture job")
        if (expected.maxUploadWinston <= 0n || BigInt(transaction.reward) > expected.maxUploadWinston) throw new CaptureFault("saved Arweave transaction exceeds current upload budget")
      }
      // Always replay the saved signature, even if a prior accepted response was lost.
      if (await bytesMatch(transaction.id, sha256)) return
      const status = await client.transactions.getStatus(transaction.id)
      if (![200, 202, 404].includes(status.status)) throw new CaptureFault("Arweave transaction status unavailable")
      const mined = (status.status === 404 || status.status === 202) ? await checkExpiry(transaction) : true
      // Replaying all chunks is safe. An accepted header must not be posted again.
      const uploader = await client.transactions.getUploader(status.status === 404 && !mined ? transaction : {
        transaction: transaction.toJSON(), txPosted: true, chunkIndex: 0,
        lastRequestTimeEnd: 0, lastResponseStatus: 0, lastResponseError: "",
      }, transaction.data)
      try {
        while (!uploader.isComplete) {
          await uploader.uploadChunk()
          // Let the durable queue retry instead of spending an hour in SDK retry sleeps.
          if (uploader.lastResponseError) throw new CaptureFault("Arweave chunk upload failed")
        }
      } catch {
        if (!await bytesMatch(transaction.id, sha256)) throw new CaptureFault("Arweave upload incomplete; retry saved transaction")
      }
    },
    async verify(id: string, sha256: string, saved?: Buffer): Promise<boolean> {
      if (!ID.test(id)) throw new CaptureFault("invalid Arweave transaction id")
      const status = await client.transactions.getStatus(id)
      if (status.status === 202 || status.status === 404) {
        if (saved) {
          const restored = await restore(saved)
          if (restored.transaction.id !== id || restored.sha256 !== sha256) throw new CaptureFault("saved Arweave upload does not match capture job")
          if (await checkExpiry(restored.transaction)) return bytesMatch(id, sha256)
        }
        return false
      }
      if (status.status !== 200) throw new CaptureFault("Arweave transaction status unavailable")
      if (!status.confirmed || !Number.isSafeInteger(status.confirmed.number_of_confirmations)
        || status.confirmed.number_of_confirmations < confirmations) return false
      return bytesMatch(id, sha256)
    },
  }
}
