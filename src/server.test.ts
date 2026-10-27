import { strict as assert } from "node:assert"
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createImageServer, discover, loadConfig, openImageCache, renderMissing, type Watched } from "./server.ts"

const A = `0x${"ab".repeat(20)}`
const watching = (cache: Watched["cache"], latestMinted: bigint) => new Map([[A, { cache, minted: latestMinted, latestMinted }]])

async function listen(server: ReturnType<typeof createImageServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

test("serves cached PNGs as immutable, minted-but-pending tokens as a pending image, unminted ids and unwatched collections as 404", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"))
  writeFileSync(join(dir, "7.png"), Buffer.from("png-7"))
  const cache = openImageCache(dir)
  for (const placeholder of ["https://arweave.net/cover", undefined]) {
    const server = createImageServer(watching(cache, 9n), placeholder, () => ({ minted: "9" }))
    const base = await listen(server)
    try {
      const hit = await fetch(`${base}/${A}/7.png`)
      assert.equal(hit.status, 200)
      assert.equal(hit.headers.get("content-type"), "image/png")
      assert.match(hit.headers.get("cache-control")!, /immutable/)
      assert.equal(hit.headers.get("access-control-allow-origin"), "*")
      assert.equal(Buffer.from(await hit.arrayBuffer()).toString(), "png-7")
      const pending = await fetch(`${base}/${A}/8.png`, { redirect: "manual" })
      assert.equal(pending.headers.get("cache-control"), "no-cache")
      if (placeholder) {
        assert.equal(pending.status, 302)
        assert.equal(pending.headers.get("location"), placeholder)
      } else {
        assert.equal(pending.status, 200)
        assert.equal(pending.headers.get("content-type"), "image/svg+xml")
        assert.match(await pending.text(), /Rendering/)
      }
      assert.equal((await fetch(`${base}/${A}/10.png`, { redirect: "manual" })).status, 404, "unminted")
      assert.equal((await fetch(`${base}/${A.toUpperCase().replace("0X", "0x")}/7.png`)).status, 200, "address case does not matter")
      for (const path of [`/${"cd".repeat(20)}/7.png`, `/0x${"cd".repeat(20)}/7.png`, "/7.png", `/${A}/07.png`, `/${A}/0.png`, `/${A}/7.jpg`, `/${A}/7.png/x`, `/${A}/7.png.tmp`]) {
        assert.equal((await fetch(`${base}${path}`, { redirect: "manual" })).status, 404, path)
      }
      assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true, minted: "9" })
      assert.equal((await fetch(`${base}/${A}/7.png`, { method: "POST" })).status, 405)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  }
})

test("cache persists across restarts and never exposes a partial write", () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"))
  openImageCache(dir).put("3", Buffer.from("png-3"))
  writeFileSync(join(dir, "4.png.tmp"), "partial")
  const reopened = openImageCache(dir)
  assert.equal(reopened.get("3")?.toString(), "png-3")
  assert.equal(reopened.has("4"), false)
  assert.deepEqual(readdirSync(dir).sort(), ["3.png", "4.png.tmp"])
})

test("render loop renders each confirmed uncached token once, in order, and retries failures next pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"))
  const cache = openImageCache(dir)
  cache.put("2", Buffer.from("already"))
  const rendered: string[] = []
  let failFour = true
  const deps = {
    cache,
    snapshot: async () => ({ minted: 4n, documentOf: async (id: bigint) => String(id) }),
    render: async (html: string) => {
      const id = html
      if (id === "4" && failFour) throw new Error("webgl lost")
      rendered.push(id)
      return Buffer.from(`png-${id}`)
    },
  }
  let latest = 0n
  assert.deepEqual(await renderMissing(deps, () => false, 1, (n) => { latest = n }), { minted: 4n, rendered: 2, failed: 1 })
  assert.equal(latest, 4n, "latest minted falls back to the confirmed count")
  assert.deepEqual(rendered, ["1", "3"])
  failFour = false
  assert.deepEqual(await renderMissing(deps), { minted: 4n, rendered: 1, failed: 0 })
  assert.deepEqual(await renderMissing(deps), { minted: 4n, rendered: 0, failed: 0 }, "nothing re-renders")
  assert.equal(cache.get("4")?.toString(), "png-4")
  let calls = 0
  await renderMissing({ ...deps, render: async () => { calls++; return Buffer.from("x") }, snapshot: async () => ({ minted: 9n, documentOf: async () => "" }) }, () => true)
  assert.equal(calls, 0, "shutdown stops before the next render")
})

test("parallel rendering covers every token exactly once, each slot rendering one at a time", async () => {
  const cache = openImageCache(mkdtempSync(join(tmpdir(), "capture-")))
  const busy = new Set<number>()
  const seen: string[] = []
  const deps = {
    cache,
    snapshot: async () => ({ minted: 20n, documentOf: async (id: bigint) => String(id) }),
    render: async (html: string, slot: number) => {
      assert.equal(busy.has(slot), false, "a slot renders one token at a time")
      busy.add(slot)
      await new Promise((resolve) => setTimeout(resolve, 5))
      busy.delete(slot)
      seen.push(html)
      return Buffer.from("png")
    },
  }
  assert.deepEqual(await renderMissing(deps, () => false, 8), { minted: 20n, rendered: 20, failed: 0 })
  assert.deepEqual(seen.map(Number).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1))
})

test("a burst of requests during rendering is served without errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"))
  const cache = openImageCache(dir)
  const png = Buffer.alloc(700_000, 1)
  for (let id = 1; id <= 50; id++) cache.put(String(id), png)
  const server = createImageServer(watching(cache, 100n), "https://arweave.net/cover", () => ({}))
  const base = await listen(server)
  try {
    const statuses = await Promise.all(Array.from({ length: 1000 }, (_, i) =>
      fetch(`${base}/${A}/${(i % 100) + 1}.png`, { redirect: "manual" }).then(async (r) => { await r.arrayBuffer(); return r.status })))
    assert.equal(statuses.filter((s) => s === 200).length, 500)
    assert.equal(statuses.filter((s) => s === 302).length, 500)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("discovery watches factory instances pointed at the renderer, once each, and resumes from the last chunk", async () => {
  const real = `0x${"11".repeat(20)}`, fake = `0x${"22".repeat(20)}`, later = `0x${"33".repeat(20)}`
  const emitted: Record<string, string[]> = { "100": [real, fake], "10150": [real], "25000": [later] }
  const ranges: string[] = []
  let failAt: bigint | undefined
  const deps = {
    logs: async (from: bigint, to: bigint) => {
      if (failAt !== undefined && from >= failAt) throw new Error("rpc down")
      ranges.push(`${from}-${to}`)
      return Object.entries(emitted).filter(([block]) => BigInt(block) >= from && BigInt(block) <= to).flatMap(([, list]) => list) as `0x${string}`[]
    },
    isInstance: async (address: string) => address !== fake,
  }
  const state = { scannedTo: 99n, collections: [] as `0x${string}`[] }
  failAt = 20_100n
  await assert.rejects(discover(state, 30_000n, deps), /rpc down/)
  assert.equal(state.scannedTo, 20_099n, "advanced through the chunks that succeeded")
  assert.deepEqual(state.collections.map((a) => a.toLowerCase()), [real], "a collection found before the failure is kept")
  failAt = undefined
  ranges.length = 0
  await discover(state, 30_000n, deps)
  assert.deepEqual(ranges, ["20100-30000"], "resumes after the last good chunk")
  assert.deepEqual(state.collections.map((a) => a.toLowerCase()), [real, later], "the impostor is skipped and a repeat RendererSet is not a new collection")
  ranges.length = 0
  await discover(state, 30_000n, deps)
  assert.deepEqual(ranges, [], "nothing left to scan")
  const fresh = { scannedTo: 99n, collections: [] as `0x${string}`[] }
  await discover(fresh, 30_000n, deps)
  assert.deepEqual(ranges, ["100-10099", "10100-20099", "20100-30000"], "chunks of 10,000 blocks")
})

test("config requires a chain, factory, renderer, start block and cache dir and defaults to the Tenderly gateway", () => {
  const base = { CHAIN: "sepolia", FACTORY: `0x${"11".repeat(20)}`, RENDERER: `0x${"22".repeat(20)}`, FROM_BLOCK: "12002730", CACHE_DIR: "/tmp/x" }
  const config = loadConfig(base)
  assert.equal(config.rpcUrl, "https://sepolia.gateway.tenderly.co")
  assert.deepEqual([config.size, config.confirmations, config.pollMs, config.fromBlock], [2048, 12n, 30_000, 12002730n])
  assert.equal(loadConfig({ ...base, CHAIN: "mainnet" }).rpcUrl, "https://mainnet.gateway.tenderly.co")
  for (const bad of [{ CHAIN: "base" }, { FACTORY: "0x12" }, { RENDERER: undefined }, { FROM_BLOCK: "" }, { FROM_BLOCK: "-1" }, { CACHE_DIR: "" }, { CONFIRMATIONS: "0" }, { RENDER_CONCURRENCY: "0" }, { PLACEHOLDER_URL: "http://x/y.png" }]) {
    assert.throws(() => loadConfig({ ...base, ...bad }), JSON.stringify(bad))
  }
})
