import { strict as assert } from "node:assert"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { CaptureUploadExpired } from "./arweave.ts"
import { archiveStep, publishList, type ArchiveDeps, type ArchiveManifest } from "./archive.ts"

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "archive-"))
  const calls: string[] = []
  let signs = 0
  let confirmed = false
  const saved: ArchiveManifest[] = []
  const deps: ArchiveDeps = {
    fetchPng: async (id) => id === 99 ? null : Buffer.from(`png-${id}`),
    sign: async (id) => {
      signs++
      calls.push(`sign:${id}`)
      const arweaveId = `ar${id}-${signs}`
      return { arweaveId, signed: Buffer.from(JSON.stringify({ sha256: "x", transaction: { id: arweaveId } })) }
    },
    upload: async (entry) => { calls.push(`upload:${entry.arweaveId}`) },
    verify: async () => confirmed,
    signedPath: (id, old) => join(dir, old ? `${id}.${old}.expired.json` : `${id}.json`),
    saveManifest: (m) => { saved.push(structuredClone(m)) },
  }
  return { dir, deps, calls, saved, confirm: () => { confirmed = true }, signs: () => signs }
}

test("each run advances one step and a token is signed exactly once", async () => {
  const f = fixture()
  const manifest: ArchiveManifest = {}
  assert.match(await archiveStep(5, manifest, f.deps), /^signed ar5-1$/)
  assert.ok(existsSync(join(f.dir, "5.json")), "signature on disk before any upload")
  assert.equal(f.calls.includes("upload:ar5-1"), false)
  assert.match(await archiveStep(5, manifest, f.deps), /awaiting confirmations/)
  f.confirm()
  assert.match(await archiveStep(5, manifest, f.deps), /^verified/)
  assert.equal(await archiveStep(5, manifest, f.deps), "verified")
  assert.equal(f.signs(), 1)
  assert.deepEqual(publishList(manifest), { ids: [5], uris: ["ar://ar5-1"] })
})

test("an unrendered token is skipped without signing", async () => {
  const f = fixture()
  assert.equal(await archiveStep(99, {}, f.deps), "not rendered yet")
  assert.equal(f.signs(), 0)
})

test("a crash after signing but before the manifest adopts the saved signature instead of paying again", async () => {
  const f = fixture()
  writeFileSync(join(f.dir, "6.json"), JSON.stringify({ sha256: "abc", transaction: { id: "saved-6" } }))
  const manifest: ArchiveManifest = {}
  await archiveStep(6, manifest, f.deps)
  assert.equal(f.signs(), 0)
  assert.deepEqual(manifest["6"], { sha256: "abc", arweaveId: "saved-6", verified: false })
  assert.ok(f.calls.includes("upload:saved-6"))
})

test("a proven-expired upload is set aside and the same PNG is re-signed next run", async () => {
  const f = fixture()
  const manifest: ArchiveManifest = {}
  await archiveStep(7, manifest, f.deps)
  f.deps.verify = async () => { throw new CaptureUploadExpired({ anchor: "a", anchorHeight: 1, checkedThroughHeight: 51, tipHeight: 71, tipHash: "t", blocks: [] }) }
  assert.match(await archiveStep(7, manifest, f.deps), /expired; re-signing/)
  assert.ok(existsSync(join(f.dir, "7.ar7-1.expired.json")), "old signature kept for audit")
  assert.equal(manifest["7"], undefined)
  assert.match(await archiveStep(7, manifest, f.deps), /^signed ar7-2$/)
})

test("an upload outage keeps the entry and retries the same signature", async () => {
  const f = fixture()
  const manifest: ArchiveManifest = {}
  await archiveStep(8, manifest, f.deps)
  f.deps.upload = async () => { throw new Error("gateway down") }
  await assert.rejects(archiveStep(8, manifest, f.deps), /gateway down/)
  assert.equal(manifest["8"].arweaveId, "ar8-1")
  assert.equal(f.signs(), 1)
})
