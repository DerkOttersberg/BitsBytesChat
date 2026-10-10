import { writeFile } from "node:fs/promises"

// Hidden Windows windows can expose an old compositor frame to CDP. Observe
// a fresh software paint instead; BB_QA_CAPTURE enables this only in QA.
export async function captureHidden(app, page, path) {
  let readyTimer
  const viewport = await Promise.race([
    page.evaluate(async () => {
      await document.fonts.ready
      // A native resize or theme change can precede the compositor's next frame.
      // Wait through layout and paint before requesting the retained bitmap.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return {
        width: innerWidth,
        height: innerHeight,
        scale: devicePixelRatio,
        scheme: document.documentElement.dataset.colorScheme,
      }
    }),
    new Promise((_, reject) => {
      readyTimer = setTimeout(() => reject(Error("Hidden capture viewport did not become ready")), 20000)
    }),
  ]).finally(() => clearTimeout(readyTimer))
  let timer
  const captured = await Promise.race([
    app.evaluate(({ BrowserWindow }, viewport) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (window.isVisible() || window.isFocused()) throw Error("QA window became visible")
      if (!window.webContents.isOffscreen()) throw Error("QA capture requires offscreen rendering")
      return new Promise((resolve, reject) => {
        const started = performance.now()
        const cleanup = () => {
          clearInterval(invalidate)
          clearTimeout(expiry)
          window.webContents.removeListener("paint", painted)
        }
        // The first invalidation can return a frame already waiting in IPC.
        // Discard it and capture a subsequent frame at the settled viewport.
        const painted = (_, rect, image) => {
          const size = image.getSize()
          if (
            performance.now() - started < 200 ||
            size.width !== Math.round(viewport.width * viewport.scale) ||
            size.height !== Math.round(viewport.height * viewport.scale)
          )
            return
          cleanup()
          resolve(image.toPNG().toString("base64"))
        }
        const invalidate = setInterval(() => window.webContents.invalidate(), 100)
        const expiry = setTimeout(() => {
          cleanup()
          reject(Error("Hidden capture did not paint the settled viewport"))
        }, 18000)
        window.webContents.on("paint", painted)
        window.webContents.invalidate()
      })
    }, viewport),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("Hidden capture did not produce a frame")), 20000)
    }),
  ]).finally(() => clearTimeout(timer))
  await writeFile(path, Buffer.from(captured, "base64"))
  await app.evaluate(({ BrowserWindow }) => {
    if (BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused())) {
      throw Error("QA window became visible")
    }
  })
  return viewport
}
