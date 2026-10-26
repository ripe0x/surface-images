/**
 * Headless Chromium renders one capture document to a square PNG of its
 * first canvas. Without a GPU, WebGL runs in software (SwiftShader) inside
 * each browser's single GPU process, so callers use one browser per CPU.
 */
import { chromium, type Browser } from "playwright"
import sharp from "sharp"

// Chromium builds accept different SwiftShader flag spellings; try both.
const LAUNCH_ARGS = [
  ["--force-color-profile=srgb", "--use-gl=angle", "--use-angle=swiftshader"],
  ["--force-color-profile=srgb", "--enable-unsafe-swiftshader"],
]

export async function launchBrowser(): Promise<Browser> {
  let last: unknown
  for (const args of LAUNCH_ARGS) {
    try { return await chromium.launch({ headless: true, args }) }
    catch (error) { last = error }
  }
  throw new Error(`no Chromium launch flags worked: ${(last as Error)?.message}`)
}

export async function renderDocument(browser: Browser, html: string, size: number): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const assertNoErrors = () => { if (errors.length) throw new Error(`artwork script failed: ${errors[0].slice(0, 300)}`) }
  try {
    await page.setContent(html, { waitUntil: "load" })
    const canvas = page.locator("canvas").first()
    await canvas.waitFor({ state: "attached" })
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    assertNoErrors()
    // A failed WebGL start can still screenshot as a repeatable blank image.
    await canvas.evaluate((element) => {
      const c = element as HTMLCanvasElement
      const gl = (c.getContext("webgl2") || c.getContext("webgl")) as WebGLRenderingContext | null
      if (!gl) return
      if (gl.isContextLost()) throw new Error("WebGL context lost")
      const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null
      if (!program || !gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("WebGL artwork has no linked program")
    })
    const png = await canvas.screenshot({ type: "png" })
    assertNoErrors()
    const meta = await sharp(png).metadata()
    if (meta.format !== "png" || meta.width !== size || meta.height !== size) throw new Error(`expected a ${size} x ${size} PNG, got ${meta.width} x ${meta.height}`)
    return png
  } finally {
    await page.close()
  }
}
