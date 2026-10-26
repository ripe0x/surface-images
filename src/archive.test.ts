import { strict as assert } from "node:assert"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { archiveStep, publishList, type ArchiveDeps, type ArchiveManifest } from "./archive.ts"

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "archive-"))
  const calls: string[] = []
  let signs = 0
  const served = new Set<string>()
  let uploadLands = false
  const deps: ArchiveDeps = {
    fetchPng: async (id) => id === 99 ? null : Buffer.from(`png-${id}`),
    sign: async (id, png) => { signs++; calls.push(`sign:${id}`); return { id: `ar${id}`, sha256: `sha${id}`, item: png } },
    upload: async (signed) => { calls.push(`upload:${signed.id}`); if (uploadLands) served.add(signed.id) },
    verify: async (entry) => served.has(entry.arweaveId),
    signedPath: (id) => join(dir, `${id}.json`),
    saveManifest: () => {},
  }
  return { dir, deps, calls, signs: () => signs, land: () => { uploadLands = true } }
}

test("each run advances one step and a token is signed exactly once", async () => {
  const f = fixture()
  const manifest: ArchiveManifest = {}
  assert.equal(await archiveStep(5, manifest, f.deps), "signed ar5")
  assert.ok(existsSync(join(f.dir, "5.json")), "signature on disk before any upload")
  assert.equal(f.calls.includes("upload:ar5"), false)
  assert.match(await archiveStep(5, manifest, f.deps), /waiting for arweave.net/)
  f.land()
  assert.equal(await archiveStep(5, manifest, f.deps), "verified ar5")
  assert.equal(await archiveStep(5, manifest, f.deps), "verified")
  assert.equal(f.signs(), 1)
  assert.deepEqual(publishList(manifest), { ids: [5], uris: ["ar://ar5"] })
})

test("an upload already on arweave.net is not sent again", async () => {
  const f = fixture()
  const manifest: ArchiveManifest = {}
  await archiveStep(6, manifest, f.deps)
  f.land()
  await archiveStep(6, manifest, f.deps)
  const uploads = f.calls.filter((c) => c.startsWith("upload")).length
  manifest["6"].verified = false
  assert.match(await archiveStep(6, manifest, f.deps), /^verified/)
  assert.equal(f.calls.filter((c) => c.startsWith("upload")).length, uploads, "served bytes skip the upload")
})

test("an unrendered token is skipped without signing", async () => {
  const f = fixture()
  assert.equal(await archiveStep(99, {}, f.deps), "not rendered yet")
  assert.equal(f.signs(), 0)
})

test("a crash after signing but before the manifest adopts the saved signature", async () => {
  const f = fixture()
  writeFileSync(join(f.dir, "7.json"), JSON.stringify({ id: "saved-7", sha256: "abc", item: Buffer.from("x").toString("base64") }))
  const manifest: ArchiveManifest = {}
  await archiveStep(7, manifest, f.deps)
  assert.equal(f.signs(), 0)
  assert.deepEqual(manifest["7"], { sha256: "abc", arweaveId: "saved-7", verified: false })
  assert.ok(f.calls.includes("upload:saved-7"))
})

test("an upload failure keeps the entry and retries the same signature", async () => {
  const f = fixture()
  const manifest: ArchiveManifest = {}
  await archiveStep(8, manifest, f.deps)
  f.deps.upload = async () => { throw new Error("needs credits") }
  await assert.rejects(archiveStep(8, manifest, f.deps), /needs credits/)
  assert.equal(manifest["8"].arweaveId, "ar8")
  assert.equal(f.signs(), 1)
})
