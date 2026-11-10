// Test-only Electron entry point. Uses the real application service and UI with
// an injected provider response; no paid account or global fetch replacement.
import { app, BrowserWindow } from "electron"
import { readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Application } from "../src/main/ipc.js"

const root = process.env.BITSBYTES_TEST_DATA!
app.setPath("userData", root)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1140, height: 780, webPreferences: { preload: path.resolve("dist/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "media"))
  const request: typeof fetch = async (_url, options) => {
    const payload = JSON.parse(String(options?.body))
    const row = [...service.library.records.values()].find(row => row.status === "transcribing")!
    const audio = path.join(service.library.directory(row.id), row.source || "recording.wav")
    const saved = (await stat(audio)).size > 44
    const history = JSON.parse(await readFile(path.join(root, "requests.json"), "utf8").catch(() => "[]")) as unknown[]
    history.push({ saved, model: payload.model, response_format: payload.response_format, diarize: payload.provider?.options?.elevenlabs?.diarize === true })
    await writeFile(path.join(root, "requests.json"), JSON.stringify(history))
    await new Promise(resolve => setTimeout(resolve, 1000))
    return Response.json(payload.provider?.options?.elevenlabs?.diarize ? {
      text: "Hello there. Hi. Again.", words: [
        { word: "Hello", start: 0, end: .2, speaker: 0 },
        { word: "there.", start: .2, end: .5, speaker: 0 },
        { word: "Hi.", start: .6, end: 1, speaker: 1 },
        { word: "Again.", start: 1.1, end: 1.5, speaker: 0 }
      ], usage: { cost: 0.0012 }
    } : { text: "Automatically transcribed after the audio was saved.", usage: { cost: 0.0007 } })
  }
  const catalog: typeof fetch = async () => Response.json({ data: [{ id: "elevenlabs/scribe-v2", pricing: { prompt: "0.0000611111111111" } }, { id: "elevenlabs/scribe-v2-medical", pricing: { prompt: "0.0000611111111111" } }] })
  const service = new Application(root, window, "1.2.0", request, catalog)
  await service.initialize(); service.register()
  await window.loadFile(path.resolve("dist/renderer/index.html"))
})
app.on("window-all-closed", () => app.quit())
