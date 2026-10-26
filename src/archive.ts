/**
 * Manual Arweave archive of the hosted PNGs. Each run moves
 * every token in [from, to] forward one step (download the hosted PNG and
 * sign, then upload, then verify) and is safe to repeat: a token's upload is
 * signed once and saved before it is sent, so a re-run never pays twice.
 * Run it, wait for Arweave confirmations, run it again until every token is
 * verified. Then write the `ids`/`uris` it outputs with
 * RenderAssets.setCaptures(collection, ids, uris) from the collection owner.
 *
 * Usage: npm run archive -- <from> <to>
 *
 * Env:
 *   IMAGE_URL           the image service, e.g. https://<app>.fly.dev
 *   COLLECTION          collection address (upload tag)
 *   CHAIN_ID            chain id (upload tag)
 *   OUT_DIR             local state: signed uploads and manifest.json
 *   PUBLISH_FILE        where to write { ids, uris } for verified tokens
 *   ARWEAVE_ADDRESS     uploader address, checked against the key
 *   ARWEAVE_JWK         uploader key, passed from a secret store at run time, never a file
 *   MAX_UPLOAD_WINSTON  fee ceiling for one upload
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"
import { CaptureUploadExpired, createNativeArweaveUploader, sha256Hex } from "./arweave.ts"

export interface ArchiveEntry { sha256: string; arweaveId: string; verified: boolean }
export type ArchiveManifest = Record<string, ArchiveEntry>

export interface ArchiveDeps {
  fetchPng(id: number): Promise<Buffer | null>
  sign(id: number, png: Buffer): Promise<{ arweaveId: string; signed: Buffer }>
  upload(entry: ArchiveEntry, signed: Buffer): Promise<void>
  /** True once confirmed and served; throws CaptureUploadExpired when it can never land. */
  verify(entry: ArchiveEntry, signed: Buffer): Promise<boolean>
  signedPath(id: number, arweaveId?: string): string
  saveManifest(manifest: ArchiveManifest): void
}

function writeAtomic(path: string, data: string | Buffer): void {
  writeFileSync(`${path}.tmp`, data)
  renameSync(`${path}.tmp`, path)
}

/** One step per token. The signed upload is on disk before the manifest names it, and both before any upload. */
export async function archiveStep(id: number, manifest: ArchiveManifest, deps: ArchiveDeps): Promise<string> {
  let entry = manifest[id]
  if (!entry && existsSync(deps.signedPath(id))) {
    // Crash between saving the signature and the manifest: adopt it, never re-sign.
    const envelope = JSON.parse(readFileSync(deps.signedPath(id), "utf8"))
    entry = manifest[id] = { sha256: envelope.sha256, arweaveId: envelope.transaction.id, verified: false }
    deps.saveManifest(manifest)
  }
  if (!entry) {
    const png = await deps.fetchPng(id)
    if (!png) return "not rendered yet"
    const { arweaveId, signed } = await deps.sign(id, png)
    writeAtomic(deps.signedPath(id), signed)
    entry = manifest[id] = { sha256: sha256Hex(png), arweaveId, verified: false }
    deps.saveManifest(manifest)
    return `signed ${arweaveId}`
  }
  if (entry.verified) return "verified"
  const signed = readFileSync(deps.signedPath(id))
  try {
    await deps.upload(entry, signed)
    if (!await deps.verify(entry, signed)) return `uploaded ${entry.arweaveId}, awaiting confirmations`
  } catch (error) {
    if (!(error instanceof CaptureUploadExpired)) throw error
    // Proven never included: keep the old signature for audit, re-sign the same PNG next run.
    renameSync(deps.signedPath(id), deps.signedPath(id, entry.arweaveId))
    delete manifest[id]
    deps.saveManifest(manifest)
    return `upload ${entry.arweaveId} expired; re-signing next run`
  }
  entry.verified = true
  deps.saveManifest(manifest)
  return `verified ${entry.arweaveId}`
}

export function publishList(manifest: ArchiveManifest): { ids: number[]; uris: string[] } {
  const ids = Object.keys(manifest).filter((id) => manifest[id].verified).map(Number).sort((a, b) => a - b)
  return { ids, uris: ids.map((id) => `ar://${manifest[id].arweaveId}`) }
}

async function main(): Promise<void> {
  const [from, to] = process.argv.slice(2).filter((arg) => arg !== "--").map(Number)
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) throw new Error("usage: npm run archive -- <from> <to>")
  const env = (name: string) => process.env[name] || (() => { throw new Error(`missing ${name}`) })()
  const imageUrl = env("IMAGE_URL").replace(/\/$/, "")
  const outDir = env("OUT_DIR")
  const publishFile = env("PUBLISH_FILE")
  const maxUploadWinston = BigInt(env("MAX_UPLOAD_WINSTON"))
  const tags = [{ name: "Collection", value: env("COLLECTION") }, { name: "Chain-Id", value: env("CHAIN_ID") }]
  mkdirSync(join(outDir, "signed"), { recursive: true })
  const manifestPath = join(outDir, "manifest.json")
  const manifest: ArchiveManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {}
  const uploader = await createNativeArweaveUploader({ jwkJson: env("ARWEAVE_JWK"), expectedAddress: env("ARWEAVE_ADDRESS") })

  const deps: ArchiveDeps = {
    async fetchPng(id) {
      const response = await fetch(`${imageUrl}/${id}.png`, { redirect: "manual", signal: AbortSignal.timeout(60_000) })
      if (response.status !== 200) return null
      const png = Buffer.from(await response.arrayBuffer())
      const meta = await sharp(png).metadata()
      if (meta.format !== "png" || meta.width !== 2048 || meta.height !== 2048) throw new Error(`token ${id}: hosted image is not a 2048 x 2048 PNG`)
      return png
    },
    async sign(id, png) {
      const { id: arweaveId, signedTransaction } = await uploader.prepare(png, [
        { name: "Content-Type", value: "image/png" }, { name: "Sha256", value: sha256Hex(png) },
        ...tags, { name: "Token-Id", value: String(id) },
      ], maxUploadWinston)
      return { arweaveId, signed: signedTransaction }
    },
    upload: (entry, signed) => uploader.upload(signed, { id: entry.arweaveId, sha256: entry.sha256, maxUploadWinston }),
    verify: (entry, signed) => uploader.verify(entry.arweaveId, entry.sha256, signed),
    signedPath: (id, old) => join(outDir, "signed", old ? `${id}.${old}.expired.json` : `${id}.json`),
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
