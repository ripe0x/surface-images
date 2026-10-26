/**
 * A token's capture document is its own onchain HTML (tokenURI's
 * animation_url) with the injected render context switched from "token" to
 * "capture", per the Surface injection convention. No local copy of the
 * artwork is involved, so the still is always what the renderer serves.
 */

function decodeDataUri(uri: string, type: string): string {
  const prefix = `data:${type}`
  if (!uri.startsWith(prefix)) throw new Error(`expected a ${type} data URI`)
  const comma = uri.indexOf(",")
  const header = uri.slice(prefix.length, comma)
  const body = uri.slice(comma + 1)
  return header.split(";").includes("base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body)
}

export function captureDocument(tokenURI: string): string {
  const metadata = JSON.parse(decodeDataUri(tokenURI, "application/json"))
  if (typeof metadata.animation_url !== "string") throw new Error("tokenURI has no animation_url")
  const html = decodeDataUri(metadata.animation_url, "text/html")
  // Fail closed rather than guess if the work's own code also contains the marker.
  const marker = '"context":"token"'
  if (html.split(marker).length !== 2) throw new Error("expected exactly one injected token render context")
  return html.replace(marker, '"context":"capture"')
}
