/**
 * Image service for a PND Surface collection. GET /<id>.png returns a minted
 * token's still, rendered from its own onchain HTML in "capture" context. A
 * background loop renders new confirmed mints into CACHE_DIR, one Chromium
 * per CPU; requests only read memory, so a mint rush never renders, calls
 * the chain or touches the disk per request. A minted token that is not
 * rendered yet gets a short-lived "rendering" image (or a redirect to
 * PLACEHOLDER_URL); an unminted id 404s. No keys or database are involved.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { availableParallelism } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createPublicClient, http, parseAbi, type Address } from "viem"
import { mainnet, sepolia } from "viem/chains"
import { captureDocument } from "./document.ts"
import { launchBrowser, renderDocument } from "./render.ts"

const surfaceAbi = parseAbi([
  "function config() view returns ((uint256 supplyCap, uint16 royaltyBps, address royaltyReceiver, address renderer, bool rendererLocked, bool supplyLocked) cfg, uint256 minted)",
  "function tokenURI(uint256 tokenId) view returns (string)",
])
const PNG_PATH = /^\/([1-9]\d{0,9})\.png$/
// A still is a pure function of the confirmed token, so it never changes.
const IMMUTABLE = "public, max-age=31536000, immutable"
// Shown while a minted token waits for confirmations and its render. Never
// cached for long, so viewers pick up the real image as soon as it exists.
const PENDING_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#141414"/><text x="256" y="266" fill="#8a8a8f" font-family="system-ui, sans-serif" font-size="22" text-anchor="middle">Rendering…</text></svg>')

export interface ImageCache {
  get(id: string): Buffer | undefined
  has(id: string): boolean
  put(id: string, png: Buffer): void
  size(): number
}

/** PNGs on disk, mirrored in memory. Writes are atomic renames, so a crash never leaves a partial file. */
export function openImageCache(dir: string): ImageCache {
  mkdirSync(dir, { recursive: true })
  const images = new Map<string, Buffer>()
  for (const file of readdirSync(dir)) {
    const match = /^(\d+)\.png$/.exec(file)
    if (match) images.set(match[1], readFileSync(join(dir, file)))
  }
  return {
    get: (id) => images.get(id),
    has: (id) => images.has(id),
    put(id, png) {
      const path = join(dir, `${id}.png`)
      writeFileSync(`${path}.tmp`, png)
      renameSync(`${path}.tmp`, path)
      images.set(id, png)
    },
    size: () => images.size,
  }
}

/** `pendingUpTo` is the latest (unconfirmed) minted count: ids at or below it are minted. */
export function createImageServer(cache: ImageCache, placeholder: string | undefined, status: () => object, pendingUpTo: () => bigint = () => 0n): Server {
  return createServer((request, response) => {
    const path = request.url?.split("?")[0] ?? ""
    if (request.method !== "GET" && request.method !== "HEAD") return void response.writeHead(405).end()
    if (path === "/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      return void response.end(JSON.stringify({ ok: true, ...status() }))
    }
    const id = PNG_PATH.exec(path)?.[1]
    const png = id ? cache.get(id) : undefined
    if (png) {
      response.writeHead(200, { "content-type": "image/png", "content-length": png.length, "cache-control": IMMUTABLE })
      return void response.end(request.method === "HEAD" ? undefined : png)
    }
    if (id && BigInt(id) <= pendingUpTo()) {
      if (placeholder) return void response.writeHead(302, { location: placeholder, "cache-control": "no-cache" }).end()
      response.writeHead(200, { "content-type": "image/svg+xml", "content-length": PENDING_SVG.length, "cache-control": "no-cache" })
      return void response.end(request.method === "HEAD" ? undefined : PENDING_SVG)
    }
    response.writeHead(404, { "cache-control": "public, max-age=10" }).end()
  })
}

export interface RenderLoopDeps {
  /** Confirmed minted count, a capture-document reader pinned to that block, and the latest (unconfirmed) minted count. */
  snapshot(): Promise<{ minted: bigint; latestMinted?: bigint; documentOf(id: bigint): Promise<string> }>
  /** `slot` is the worker (0..concurrency-1); each owns one browser. */
  render(html: string, slot: number): Promise<Buffer>
  cache: ImageCache
}

/** Render every confirmed, uncached token, lowest id first, `concurrency` at a time. A failed token is retried next pass. */
export async function renderMissing(deps: RenderLoopDeps, stopping: () => boolean = () => false, concurrency = 1, onSnapshot: (latestMinted: bigint) => void = () => {}): Promise<{ minted: bigint; rendered: number; failed: number }> {
  const { minted, latestMinted, documentOf } = await deps.snapshot()
  onSnapshot(latestMinted ?? minted)
  const queue: bigint[] = []
  for (let id = 1n; id <= minted; id++) if (!deps.cache.has(String(id))) queue.push(id)
  let rendered = 0
  let failed = 0
  await Promise.all(Array.from({ length: concurrency }, async (_, slot) => {
    while (queue.length > 0 && !stopping()) {
      const id = queue.shift()!
      try {
        deps.cache.put(String(id), await deps.render(await documentOf(id), slot))
        rendered++
      } catch (error) {
        failed++
        console.error(`[surface-images] token ${id} render failed: ${error instanceof Error ? error.message.slice(0, 200) : "Error"}`)
      }
    }
  }))
  return { minted, rendered, failed }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const chain = env.CHAIN === "mainnet" ? mainnet : env.CHAIN === "sepolia" ? sepolia : undefined
  if (!chain) throw new Error("CHAIN must be mainnet or sepolia")
  const collection = env.COLLECTION
  if (!collection || !/^0x[\da-fA-F]{40}$/.test(collection)) throw new Error("invalid COLLECTION")
  if (!env.CACHE_DIR) throw new Error("CACHE_DIR required")
  const integer = (name: string, fallback: number, min: number) => {
    const value = Number(env[name] ?? fallback)
    if (!Number.isSafeInteger(value) || value < min) throw new Error(`invalid ${name}`)
    return value
  }
  const placeholder = env.PLACEHOLDER_URL || undefined
  if (placeholder && new URL(placeholder).protocol !== "https:") throw new Error("PLACEHOLDER_URL must be https")
  return {
    chain, collection: collection as Address, placeholder, cacheDir: env.CACHE_DIR,
    rpcUrl: env.RPC_URL || `https://${env.CHAIN}.gateway.tenderly.co`,
    confirmations: BigInt(integer("CONFIRMATIONS", 12, 1)),
    pollMs: integer("POLL_SECONDS", 30, 1) * 1000,
    size: integer("IMAGE_SIZE", 2048, 16),
    concurrency: integer("RENDER_CONCURRENCY", availableParallelism(), 1),
    port: integer("PORT", 8080, 0),
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  const client = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) })
  const cache = openImageCache(config.cacheDir)
  const state = { minted: "0", lastError: null as string | null, lastPassAt: null as string | null }
  const browsers: (Awaited<ReturnType<typeof launchBrowser>> | undefined)[] = []
  const deps: RenderLoopDeps = {
    cache,
    async snapshot() {
      const latest = await client.getBlockNumber()
      const blockNumber = latest - config.confirmations + 1n
      const [[, minted], [, latestMinted]] = await Promise.all([
        client.readContract({ address: config.collection, abi: surfaceAbi, functionName: "config", blockNumber }),
        client.readContract({ address: config.collection, abi: surfaceAbi, functionName: "config", blockNumber: latest }),
      ])
      return {
        minted, latestMinted,
        documentOf: async (id) => captureDocument(await client.readContract({ address: config.collection, abi: surfaceAbi, functionName: "tokenURI", args: [id], blockNumber })),
      }
    },
    async render(html, slot) {
      try {
        const browser = browsers[slot] ??= await launchBrowser()
        return await renderDocument(browser, html, config.size)
      } catch (error) {
        // A crashed Chromium is relaunched on the next token.
        await browsers[slot]?.close().catch(() => {})
        browsers[slot] = undefined
        throw error
      }
    },
  }

  let latestMinted = 0n
  let stopping = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pass: Promise<void> | undefined
  async function loop(): Promise<void> {
    try {
      const result = await renderMissing(deps, () => stopping, config.concurrency, (n) => { latestMinted = n })
      Object.assign(state, { minted: String(result.minted), lastPassAt: new Date().toISOString(),
        lastError: result.failed ? `${result.failed} token(s) failed to render; retrying` : null })
    } catch (error) {
      state.lastError = error instanceof Error ? error.message.slice(0, 200) : "render pass failed"
      console.error(`[surface-images] ${state.lastError}`)
    }
    if (!stopping) timer = setTimeout(() => { pass = loop() }, config.pollMs)
  }

  const server = createImageServer(cache, config.placeholder, () => ({ ...state, rendered: cache.size(), latestMinted: String(latestMinted) }), () => latestMinted)
  await new Promise<void>((resolve) => server.listen(config.port, "0.0.0.0", resolve))
  console.log(`[surface-images] serving ${cache.size()} cached images on :${(server.address() as { port: number }).port}`)
  pass = loop()

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      stopping = true
      clearTimeout(timer)
      void (async () => {
        await pass
        await Promise.all(browsers.map((browser) => browser?.close().catch(() => {})))
        await new Promise((resolve) => server.close(resolve))
      })()
    })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[surface-images] startup failed: ${error instanceof Error ? error.message : "Error"}`)
    process.exitCode = 1
  })
}
