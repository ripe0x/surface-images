import { strict as assert } from "node:assert"
import { test } from "node:test"
import { captureDocument } from "./document.ts"

const b64 = (s: string) => Buffer.from(s).toString("base64")
const html = '<script>window.tokenData={"hash":"0xab","tokenId":"7","context":"token","owner":"0x00"};</script><script>draw()</script>'
const tokenURI = (animation: unknown) => `data:application/json;base64,${b64(JSON.stringify({ name: "x", image: "https://a/7.png", animation_url: animation }))}`

test("switches only the injected render context to capture", () => {
  const out = captureDocument(tokenURI(`data:text/html;base64,${b64(html)}`))
  assert.equal(out, html.replace('"context":"token"', '"context":"capture"'))
  const plain = captureDocument(tokenURI(`data:text/html,${encodeURIComponent(html)}`))
  assert.equal(plain, out, "non-base64 data URIs decode too")
})

test("fails closed on missing, foreign or ambiguous documents", () => {
  assert.throws(() => captureDocument(tokenURI(undefined)), /no animation_url/)
  assert.throws(() => captureDocument(tokenURI("https://example.com/7.html")), /text\/html data URI/)
  assert.throws(() => captureDocument("https://example.com/7.json"), /application\/json data URI/)
  assert.throws(() => captureDocument(tokenURI(`data:text/html;base64,${b64(html + '"context":"token"')}`)), /exactly one/)
  assert.throws(() => captureDocument(tokenURI(`data:text/html;base64,${b64("<p>no context</p>")}`)), /exactly one/)
})
