/**
 * Image service for PND Surface (v2) collections. GET /<collection>/<id>.png
 * returns a minted token's still, rendered from its own onchain HTML in
 * "capture" context. Collections are found, not configured: every collection
 * the FACTORY created whose renderer is RENDERER is watched from the block its
 * RendererSet log confirms, so a new deploy is picked up without a restart. A
 * background loop renders new confirmed mints into CACHE_DIR, one Chromium per
 * CPU; requests only read memory, so a mint rush never renders, calls the
 * chain or touches the disk per request. A minted token that is not rendered
 * yet gets a short-lived "rendering" image (or a redirect to PLACEHOLDER_URL);
 * anything else 404s. No keys or database are involved.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { availableParallelism } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createPublicClient, getAddress, http, parseAbi, parseAbiItem, type Address } from "viem"
import { mainnet, sepolia } from "viem/chains"
import { captureDocument } from "./document.ts"
import { launchBrowser, renderDocument } from "./render.ts"

const surfaceAbi = parseAbi([
  "function config() view returns (address renderer, address minter, uint256 supplyCap, uint16 royaltyBps, address royaltyReceiver, uint256 minted)",
  "function tokenURI(uint256 tokenId) view returns (string)",
])
const factoryAbi = parseAbi(["function isInstance(address) view returns (bool)"])
// Surface emits it at initialize and on every setRenderer.
const rendererSet = parseAbiItem("event RendererSet(address indexed renderer)")
const PNG_PATH = /^\/(0x[\da-fA-F]{40})\/([1-9]\d{0,9})\.png$/
// Blocks per eth_getLogs while catching up.
const LOG_CHUNK = 10_000n
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

/** One watched collection. `latestMinted` is the unconfirmed minted count: ids at or below it are minted. */
export interface Watched { cache: ImageCache; minted: bigint; latestMinted: bigint }

/** `watched` is keyed by lowercase collection address. */
export function createImageServer(watched: Map<string, Watched>, placeholder: string | undefined, status: () => object): Server {
  return createServer((request, response) => {
    const path = request.url?.split("?")[0] ?? ""
    // Public images: any page may fetch them (e.g. to archive them from a browser).
    response.setHeader("access-control-allow-origin", "*")
    if (request.method !== "GET" && request.method !== "HEAD") return void response.writeHead(405).end()
    if (path === "/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      return void response.end(JSON.stringify({ ok: true, ...status() }))
    }
    const [, collection, id] = PNG_PATH.exec(path) ?? []
    const entry = collection ? watched.get(collection.toLowerCase()) : undefined
    const png = entry?.cache.get(id)
    if (png) {
      response.writeHead(200, { "content-type": "image/png", "content-length": png.length, "cache-control": IMMUTABLE })
      return void response.end(request.method === "HEAD" ? undefined : png)
    }
    if (entry && BigInt(id) <= entry.latestMinted) {
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

export interface DiscoveryState { scannedTo: bigint; collections: Address[] }

export interface DiscoveryDeps {
  /** Emitters of RendererSet(RENDERER) in [from, to]. */
  logs(from: bigint, to: bigint): Promise<Address[]>
  /** True if FACTORY created it. Anyone can emit a RendererSet log; only factory instances are watched. */
  isInstance(address: Address): Promise<boolean>
}

/** Scan (scannedTo, toBlock] for collections pointed at the renderer, appending new ones to `state.collections` as found. Advances chunk by chunk, so a failure resumes where it stopped and loses nothing. */
export async function discover(state: DiscoveryState, toBlock: bigint, deps: DiscoveryDeps): Promise<void> {
  const known = new Set(state.collections.map((a) => a.toLowerCase()))
  while (state.scannedTo < toBlock) {
    const from = state.scannedTo + 1n
    const to = from + LOG_CHUNK - 1n < toBlock ? from + LOG_CHUNK - 1n : toBlock
    for (const address of await deps.logs(from, to)) {
      if (known.has(address.toLowerCase())) continue
      known.add(address.toLowerCase())
      if (await deps.isInstance(address)) state.collections.push(getAddress(address))
    }
    state.scannedTo = to
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const chain = env.CHAIN === "mainnet" ? mainnet : env.CHAIN === "sepolia" ? sepolia : undefined
  if (!chain) throw new Error("CHAIN must be mainnet or sepolia")
  const address = (name: string) => {
    const value = env[name]
    if (!value || !/^0x[\da-fA-F]{40}$/.test(value)) throw new Error(`invalid ${name}`)
    return getAddress(value)
  }
  const factory = address("FACTORY")
  const renderer = address("RENDERER")
  if (!/^\d+$/.test(env.FROM_BLOCK ?? "")) throw new Error("FROM_BLOCK required: the factory's deploy block")
  if (!env.CACHE_DIR) throw new Error("CACHE_DIR required")
  const integer = (name: string, fallback: number, min: number) => {
    const value = Number(env[name] ?? fallback)
    if (!Number.isSafeInteger(value) || value < min) throw new Error(`invalid ${name}`)
    return value
  }
  const placeholder = env.PLACEHOLDER_URL || undefined
  if (placeholder && new URL(placeholder).protocol !== "https:") throw new Error("PLACEHOLDER_URL must be https")
  return {
    chain, factory, renderer, fromBlock: BigInt(env.FROM_BLOCK!), placeholder, cacheDir: env.CACHE_DIR,
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
  const statePath = join(config.cacheDir, "collections.json")
  mkdirSync(config.cacheDir, { recursive: true })
  const saved = (() => { try { return JSON.parse(readFileSync(statePath, "utf8")) } catch { return undefined } })()
  // A saved scan for another factory or renderer is ignored, never mixed in.
  const discovery: DiscoveryState = saved?.factory === config.factory && saved?.renderer === config.renderer
    ? { scannedTo: BigInt(saved.scannedTo), collections: saved.collections }
    : { scannedTo: config.fromBlock - 1n, collections: [] }
  const saveDiscovery = () => {
    writeFileSync(`${statePath}.tmp`, JSON.stringify({ factory: config.factory, renderer: config.renderer, scannedTo: String(discovery.scannedTo), collections: discovery.collections }, null, 2))
    renameSync(`${statePath}.tmp`, statePath)
  }
  const watched = new Map<string, Watched>()
  const watch = (address: Address) => watched.set(address.toLowerCase(), { cache: openImageCache(join(config.cacheDir, address.toLowerCase())), minted: 0n, latestMinted: 0n })
  discovery.collections.forEach(watch)

  const state = { lastError: null as string | null, lastPassAt: null as string | null }
  const browsers: (Awaited<ReturnType<typeof launchBrowser>> | undefined)[] = []
  const render = async (html: string, slot: number) => {
    try {
      const browser = browsers[slot] ??= await launchBrowser()
      return await renderDocument(browser, html, config.size)
    } catch (error) {
      // A crashed Chromium is relaunched on the next token.
      await browsers[slot]?.close().catch(() => {})
      browsers[slot] = undefined
      throw error
    }
  }
  const mintedAt = async (address: Address, blockNumber: bigint) => {
    const [renderer, , , , , minted] = await client.readContract({ address, abi: surfaceAbi, functionName: "config", blockNumber })
    // Only tokens our renderer draws are rendered; a collection that moved to another renderer keeps its cached stills.
    return renderer === config.renderer ? minted : 0n
  }

  let stopping = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pass: Promise<void> | undefined
  async function loop(): Promise<void> {
    const errors: string[] = []
    try {
      const latest = await client.getBlockNumber()
      const blockNumber = latest - config.confirmations + 1n
      await discover(discovery, blockNumber, {
        logs: async (fromBlock, toBlock) => (await client.getLogs({ event: rendererSet, args: { renderer: config.renderer }, fromBlock, toBlock })).map((log) => log.address),
        isInstance: (address) => client.readContract({ address: config.factory, abi: factoryAbi, functionName: "isInstance", args: [address], blockNumber }),
      }).finally(() => {
        saveDiscovery()
        for (const address of discovery.collections) {
          if (watched.has(address.toLowerCase())) continue
          console.log(`[surface-images] watching ${address}`)
          watch(address)
        }
      })
      for (const address of discovery.collections) {
        if (stopping) break
        const entry = watched.get(address.toLowerCase())!
        try {
          const result = await renderMissing({
            cache: entry.cache,
            render,
            snapshot: async () => {
              const [minted, latestMinted] = await Promise.all([mintedAt(address, blockNumber), mintedAt(address, latest)])
              return { minted, latestMinted, documentOf: async (id) => captureDocument(await client.readContract({ address, abi: surfaceAbi, functionName: "tokenURI", args: [id], blockNumber })) }
            },
          }, () => stopping, config.concurrency, (n) => { entry.latestMinted = n })
          entry.minted = result.minted
          if (result.failed) errors.push(`${address}: ${result.failed} token(s) failed to render; retrying`)
        } catch (error) {
          errors.push(`${address}: ${error instanceof Error ? error.message.slice(0, 200) : "render pass failed"}`)
        }
      }
      state.lastPassAt = new Date().toISOString()
    } catch (error) {
      errors.push(error instanceof Error ? error.message.slice(0, 200) : "pass failed")
    }
    state.lastError = errors.length ? errors.join("; ") : null
    if (state.lastError) console.error(`[surface-images] ${state.lastError}`)
    if (!stopping) timer = setTimeout(() => { pass = loop() }, config.pollMs)
  }

  const server = createImageServer(watched, config.placeholder, () => ({
    ...state, factory: config.factory, renderer: config.renderer, scannedTo: String(discovery.scannedTo),
    collections: Object.fromEntries(discovery.collections.map((address) => {
      const entry = watched.get(address.toLowerCase())!
      return [address, { minted: String(entry.minted), latestMinted: String(entry.latestMinted), rendered: entry.cache.size() }]
    })),
  }))
  await new Promise<void>((resolve) => server.listen(config.port, "0.0.0.0", resolve))
  console.log(`[surface-images] serving ${watched.size} collection(s) on :${(server.address() as { port: number }).port}`)
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
