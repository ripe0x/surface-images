/**
 * Manual Arweave archive of the hosted PNGs, paid in ETH through ArDrive
 * Turbo. Each run moves every token in [from, to] forward one step (download
 * the hosted PNG and sign, then upload, then verify on arweave.net) and is
 * safe to repeat: a token's upload is signed once and saved before it is
 * sent, and re-sending it is a duplicate Turbo does not charge for. Then write
 * the `ids`/`uris` it outputs with RenderAssets.setCaptures(collection, ids,
 * uris) from the collection owner.
 *
 * Usage: npm run archive -- top-up <eth>    buy Turbo credits with ETH (asks first)
 *        npm run archive -- balance         credits, and images they cover
 *        npm run archive -- <from> <to>     archive a token range
 *
 * Env:
 *   ETH_PRIVATE_KEY  payer and signer, passed from a secret store at run time, never a file
 *   ETH_ADDRESS      that key's address, checked before anything runs
 *   ETH_RPC_URL      Ethereum mainnet RPC for top-ups (default https://mainnet.gateway.tenderly.co)
 *   IMAGE_URL        the collection on the image service, e.g. https://<app>.fly.dev/<collection> (archive only)
 *   COLLECTION       collection address (upload tag)
 *   CHAIN_ID         collection chain id (upload tag)
 *   OUT_DIR          local state: signed uploads and manifest.json
 *   PUBLISH_FILE     where to write { ids, uris } for verified tokens
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import sharp from "sharp"
import { createTurbo, servedMatches, sha256Hex, signUpload, type SignedUpload } from "./turbo.ts"

export interface ArchiveEntry { sha256: string; arweaveId: string; verified: boolean }
export type ArchiveManifest = Record<string, ArchiveEntry>

export interface ArchiveDeps {
  fetchPng(id: number): Promise<Buffer | null>
  sign(id: number, png: Buffer): Promise<SignedUpload>
  upload(signed: SignedUpload): Promise<void>
  /** True once arweave.net serves the uploaded bytes. */
  verify(entry: ArchiveEntry): Promise<boolean>
  signedPath(id: number): string
  saveManifest(manifest: ArchiveManifest): void
}

function writeAtomic(path: string, data: string | Buffer): void {
  writeFileSync(`${path}.tmp`, data)
  renameSync(`${path}.tmp`, path)
}

const readSigned = (path: string): SignedUpload => {
  const saved = JSON.parse(readFileSync(path, "utf8"))
  return { id: saved.id, sha256: saved.sha256, item: Buffer.from(saved.item, "base64") }
}

/** One step per token. The signed upload is on disk before the manifest names it, and both before any upload. */
export async function archiveStep(id: number, manifest: ArchiveManifest, deps: ArchiveDeps): Promise<string> {
  let entry = manifest[id]
  if (!entry && existsSync(deps.signedPath(id))) {
    // Crash between saving the signature and the manifest: adopt it, never re-sign.
    const saved = readSigned(deps.signedPath(id))
    entry = manifest[id] = { sha256: saved.sha256, arweaveId: saved.id, verified: false }
    deps.saveManifest(manifest)
  }
  if (!entry) {
    const png = await deps.fetchPng(id)
    if (!png) return "not rendered yet"
    const signed = await deps.sign(id, png)
    writeAtomic(deps.signedPath(id), JSON.stringify({ id: signed.id, sha256: signed.sha256, item: signed.item.toString("base64") }))
    entry = manifest[id] = { sha256: signed.sha256, arweaveId: signed.id, verified: false }
    deps.saveManifest(manifest)
    return `signed ${signed.id}`
  }
  if (entry.verified) return "verified"
  if (!await deps.verify(entry)) {
    await deps.upload(readSigned(deps.signedPath(id)))
    if (!await deps.verify(entry)) return `uploaded ${entry.arweaveId}, waiting for arweave.net`
  }
  entry.verified = true
  deps.saveManifest(manifest)
  return `verified ${entry.arweaveId}`
}

export function publishList(manifest: ArchiveManifest): { ids: number[]; uris: string[] } {
  const ids = Object.keys(manifest).filter((id) => manifest[id].verified).map(Number).sort((a, b) => a - b)
  return { ids, uris: ids.map((id) => `ar://${manifest[id].arweaveId}`) }
}

const env = (name: string) => process.env[name] || (() => { throw new Error(`missing ${name}`) })()
const AR = (winc: bigint) => `${(Number(winc) / 1e12).toFixed(6)} credits`

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--")
  const rawKey = env("ETH_PRIVATE_KEY").trim()
  const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("ETH_PRIVATE_KEY must be a 32-byte hex key")
  const turbo = createTurbo(privateKey, process.env.ETH_RPC_URL || "https://mainnet.gateway.tenderly.co")
  if (turbo.address.toLowerCase() !== env("ETH_ADDRESS").toLowerCase()) throw new Error("ETH_PRIVATE_KEY does not match ETH_ADDRESS")
  const perImage = await turbo.cost(750_000)

  if (args[0] === "balance") {
    const balance = await turbo.balance()
    console.log(`${turbo.address}: ${AR(balance)}, about ${balance / perImage} images of 750 KB`)
    return
  }
  if (args[0] === "top-up") {
    const eth = Number(args[1])
    if (!(eth > 0 && eth <= 0.05)) throw new Error("usage: npm run archive -- top-up <eth>, between 0 and 0.05")
    const credits = await turbo.quoteEth(eth)
    console.log(`Send ${eth} ETH on Ethereum mainnet from ${turbo.address} to Turbo (plus gas).`)
    console.log(`Buys about ${AR(credits)}, about ${credits / perImage} images of 750 KB. Turbo credits are not refundable.`)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question("Type yes to send: ")
    rl.close()
    if (answer.trim() !== "yes") return void console.log("Stopped; nothing sent.")
    const result = await turbo.topUp(eth)
    console.log(`Sent: https://etherscan.io/tx/${result.id} (${result.status})`)
    console.log(`Balance now: ${AR(await turbo.balance())}`)
    return
  }

  const [from, to] = args.map(Number)
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) throw new Error("usage: npm run archive -- <from> <to>")
  const imageUrl = env("IMAGE_URL").replace(/\/$/, "")
  const outDir = env("OUT_DIR")
  const publishFile = env("PUBLISH_FILE")
  const tags = [{ name: "Collection", value: env("COLLECTION") }, { name: "Chain-Id", value: env("CHAIN_ID") }]
  mkdirSync(join(outDir, "signed"), { recursive: true })
  const manifestPath = join(outDir, "manifest.json")
  const manifest: ArchiveManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {}

  const deps: ArchiveDeps = {
    async fetchPng(id) {
      const response = await fetch(`${imageUrl}/${id}.png`, { redirect: "manual", signal: AbortSignal.timeout(60_000) })
      if (response.status !== 200 || response.headers.get("content-type") !== "image/png") return null
      const png = Buffer.from(await response.arrayBuffer())
      const meta = await sharp(png).metadata()
      if (meta.format !== "png" || !meta.width || meta.width !== meta.height) throw new Error(`token ${id}: hosted image is not a square PNG`)
      return png
    },
    sign: (id, png) => signUpload(privateKey, png, [
      { name: "Content-Type", value: "image/png" }, { name: "Sha256", value: sha256Hex(png) },
      ...tags, { name: "Token-Id", value: String(id) },
    ]),
    async upload(signed) {
      const [balance, cost] = await Promise.all([turbo.balance(), turbo.cost(signed.item.length)])
      if (balance < cost) throw new Error(`needs ${AR(cost)}, have ${AR(balance)}; run: npm run archive -- top-up <eth>`)
      await turbo.upload(signed)
    },
    verify: (entry) => servedMatches(entry.arweaveId, entry.sha256),
    signedPath: (id) => join(outDir, "signed", `${id}.json`),
    saveManifest: (m) => writeAtomic(manifestPath, JSON.stringify(m, null, 2)),
  }

  for (let id = from; id <= to; id++) {
    console.log(`token ${id}: ${await archiveStep(id, manifest, deps).catch((error) => `error: ${error instanceof Error ? error.message : "Error"}`)}`)
  }
  const list = publishList(manifest)
  writeAtomic(publishFile, JSON.stringify(list, null, 2))
  console.log(`${list.ids.length} verified token(s) ready to publish in ${publishFile}`)
}

if (process.argv[1]?.endsWith("archive.ts")) {
  main().catch((error) => {
    console.error(`[archive] ${error instanceof Error ? error.message : "failed"}`)
    process.exitCode = 1
  })
}
