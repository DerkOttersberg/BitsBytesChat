import { spawn } from "node:child_process"
import { mkdir, readFile, readdir, rename, stat } from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { AppError } from "../copy.js"
import { atomicWrite, Library, readJSON } from "./storage.js"
import { parseSpeakers, speakerTranscript, supportsSpeakers } from "../speakers.js"
const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string | null

export class Transcriber {
  controller?: AbortController
  constructor(private library: Library, private changed: () => void, private request: typeof fetch = fetch) {}
  cancel() { this.controller?.abort() }
  async prepare(id: string, signal: AbortSignal) {
    const directory = this.library.directory(id)
    const speakers = this.library.get(id).preferences.speakers
    const manifest = await readJSON<{ parts: string[]; duration: number; mode?: string }>(path.join(directory, "prepared.json"))
    if (manifest && (manifest.mode === "speakers") === speakers && Array.isArray(manifest.parts) && manifest.parts.length && manifest.parts.every((file, index) => speakers ? manifest.parts.length === 1 && file === "audio.mp3" : file === `upload-${String(index).padStart(6, "0")}.mp3`) && Number.isFinite(manifest.duration) && (await Promise.all(manifest.parts.map(file => stat(path.join(directory, file)).catch(() => undefined)))).every(value => value && value.size > 0)) return manifest
    const source = await this.library.assemble(id)
    const temporary = path.join(directory, "prepare-" + Date.now())
    await mkdir(temporary)
    const duration = await this.run(["-i", source, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-codec:a", "libmp3lame", "-b:a", speakers ? "32k" : "48k", "-progress", "pipe:1", path.join(temporary, "audio.mp3")], signal)
    if (!speakers) await this.run(["-i", path.join(temporary, "audio.mp3"), "-c", "copy", "-f", "segment", "-segment_time", "300", "-reset_timestamps", "1", path.join(temporary, "upload-%06d.mp3")], signal)
    const parts = speakers ? ["audio.mp3"] : (await readdir(temporary)).filter(file => /^upload-\d{6}\.mp3$/.test(file)).sort()
    if (!parts.length) throw new AppError("empty")
    for (const file of new Set(["audio.mp3", ...parts])) {
      const { open } = await import("node:fs/promises")
      const handle = await open(path.join(temporary, file), "r+")
      try { await handle.sync() } finally { await handle.close() }
      await rename(path.join(temporary, file), path.join(directory, file))
    }
    const prepared = { parts, duration, mode: speakers ? "speakers" : "plain" }
    await atomicWrite(path.join(directory, "prepared.json"), JSON.stringify(prepared))
    const row = this.library.get(id)
    row.duration = duration || row.duration
    await this.library.save(row)
    return prepared
  }
  private run(args: string[], signal: AbortSignal): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!ffmpeg) return reject(new AppError("prepare"))
      if (signal.aborted) return reject(new AppError("uncertain"))
      const child = spawn(ffmpeg.replace("app.asar", "app.asar.unpacked"), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
      let progress = ""
      child.stdout.on("data", chunk => { progress = (progress + String(chunk)).slice(-4096) })
      const abort = () => { child.kill() }
      signal.addEventListener("abort", abort, { once: true })
      const timeout = setTimeout(abort, 30 * 60_000)
      child.on("error", () => { clearTimeout(timeout); signal.removeEventListener("abort", abort); reject(new AppError("prepare")) })
      child.on("close", code => {
        clearTimeout(timeout); signal.removeEventListener("abort", abort)
        if (signal.aborted) return reject(new AppError("uncertain"))
        if (code !== 0) return reject(new AppError("prepare"))
        const values = [...progress.matchAll(/out_time_us=(\d+)/g)]
        resolve(Number(values.at(-1)?.[1] ?? 0) / 1_000_000)
      })
    })
  }
  async transcribe(id: string, key: string) {
    const row = this.library.get(id)
    this.controller = new AbortController()
    const signal = this.controller.signal
    row.status = "transcribing"; row.error = ""
    row.progress = { stage: "preparing", completed: row.completedParts }
    await this.library.save(row); this.changed()
    try {
      if (row.preferences.speakers && !supportsSpeakers(row.preferences.model)) throw new AppError("speakerModel")
      const prepared = await this.prepare(id, signal)
      for (let index = row.completedParts; index < prepared.parts.length; index++) {
        row.progress = { stage: "transcribing", completed: index, total: prepared.parts.length }; this.changed()
        if (signal.aborted) throw new AppError("uncertain")
        const file = path.join(this.library.directory(id), prepared.parts[index])
        if ((await stat(file)).size > 24_000_000) throw new AppError(row.preferences.speakers ? "speakerLimit" : "prepare")
        const audio = await readFile(file)
        const response = await this.request("https://openrouter.ai/api/v1/audio/transcriptions", {
          method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "BitsBytes Transcription" },
          body: JSON.stringify({ model: row.preferences.model, input_audio: { data: audio.toString("base64"), format: "mp3" }, response_format: row.preferences.speakers ? "verbose_json" : "json", ...(row.preferences.speakers ? { timestamp_granularities: ["word"], provider: { options: { elevenlabs: { diarize: true } } } } : {}), ...(row.preferences.language ? { language: row.preferences.language } : {}) }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(row.preferences.speakers ? 180_000 : 120_000)])
        }).catch(() => { throw new AppError("uncertain") })
        if (!response.ok) {
          await response.body?.cancel()
          if ([401, 403].includes(response.status)) throw new AppError("unauthorized")
          if (response.status === 402) throw new AppError("credits")
          if (response.status === 429) throw new AppError("quota")
          if ([400, 404, 422].includes(response.status)) throw new AppError("model")
          if ([408, 504].includes(response.status)) throw new AppError("uncertain")
          throw new AppError("provider")
        }
        let body = ""
        if (!response.body) throw new AppError("response")
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        for (;;) {
          const chunk = await reader.read().catch(() => { throw new AppError("uncertain") })
          if (chunk.done) break
          body += decoder.decode(chunk.value, { stream: true })
          if (body.length > (row.preferences.speakers ? 16_000_000 : 2_000_000)) { await reader.cancel(); throw new AppError("response") }
        }
        let result: unknown
        try { result = JSON.parse(body + decoder.decode()) } catch { throw new AppError("response") }
        if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string") throw new AppError("response")
        // Commit valid responses even if Close arrives after the response. Never discard paid work.
        const turns = row.preferences.speakers ? parseSpeakers(result as Record<string, unknown>, prepared.duration) : undefined
        const usage = "usage" in result && result.usage && typeof result.usage === "object" ? result.usage as Record<string, unknown> : undefined
        const cost = usage && (typeof usage.cost === "number" || typeof usage.cost === "string") && String(usage.cost).trim() ? Number(usage.cost) : undefined
        row.progress = { stage: "saving", completed: index, total: prepared.parts.length }; this.changed()
        await this.library.savePart(id, index, turns ? speakerTranscript(turns) : result.text.trim(), turns, cost)
        this.changed()
      }
      row.status = "complete"; row.error = ""
    } catch (error) {
      row.status = "error"; row.error = error instanceof AppError ? error.code : "storage"
    } finally {
      this.controller = undefined
      delete row.progress
      await this.library.save(row); this.changed()
    }
  }
}
