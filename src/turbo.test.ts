import { strict as assert } from "node:assert"
import { test } from "node:test"
import { DataItem } from "@dha-team/arbundles"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { servedMatches, sha256Hex, signUpload } from "./turbo.ts"

test("signing is offline, valid and deterministic, with a 43-character Arweave id", async () => {
  const key = generatePrivateKey()
  const png = Buffer.from("png bytes")
  const tags = [{ name: "Content-Type", value: "image/png" }, { name: "Token-Id", value: "7" }]
  const a = await signUpload(key, png, tags)
  const b = await signUpload(key, png, tags)
  assert.match(a.id, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(a.id, b.id, "re-signing the same PNG gives the same upload")
  assert.equal(a.sha256, sha256Hex(png))
  const item = new DataItem(a.item)
  assert.equal(await item.isValid(), true)
  assert.deepEqual(Buffer.from(item.rawData), png)
  assert.deepEqual(item.tags, tags)
  const other = await signUpload(generatePrivateKey(), png, tags)
  assert.notEqual(other.id, a.id)
  assert.ok(privateKeyToAccount(key).address)
})

test("gateway check: absent is false, matching bytes true, different bytes an error", async () => {
  const png = Buffer.from("png")
  const fake = (status: number, body = png) => (async () => new Response(body, { status })) as unknown as typeof fetch
  assert.equal(await servedMatches("x", sha256Hex(png), fake(404)), false)
  assert.equal(await servedMatches("x", sha256Hex(png), fake(200)), true)
  await assert.rejects(servedMatches("x", sha256Hex(png), fake(200, Buffer.from("other"))), /do not match/)
  await assert.rejects(servedMatches("x", sha256Hex(png), fake(500)), /returned 500/)
})
