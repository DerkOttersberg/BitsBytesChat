import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import type { Preferences, Recording, SpeakerTurn } from "../shared.js"
import { AppError } from "../copy.js"

export async function atomicWrite(file: string, data: string | Buffer) {
  const temporary = file + ".tmp-" + randomUUID()
  const handle = await open(temporary, "wx")
  try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
  await rename(temporary, file)
}

export async function readJSON<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as T } catch { return undefined }
}

export class Library {
  records = new Map<string, Recording>()
  private next = new Map<string, number>()
  constructor(public root: string) {}
  directory(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError("invalid")
    return path.join(this.root, "recordings", id)
  }
  get(id: string) {
    const row = this.records.get(id)
    if (!row) throw new AppError("invalid")
    return row
  }
  async initialize() {
    await mkdir(path.join(this.root, "recordings"), { recursive: true })
    for (const folder of await readdir(path.join(this.root, "recordings"), { withFileTypes: true })) {
      if (!folder.isDirectory() || !/^[0-9a-f-]{36}$/.test(folder.name)) continue
      const directory = this.directory(folder.name)
      const stored = await readJSON<Recording>(path.join(directory, "recording.json")) ?? await readJSON<Recording>(path.join(directory, "recording.backup.json"))
      const valid = stored && stored.id === folder.name && typeof stored.created === "string" && typeof stored.title === "string" && Number.isFinite(stored.duration) && typeof stored.rate === "number" && stored.rate >= 8000 && stored.rate <= 96000 && stored.preferences && typeof stored.preferences.model === "string" && typeof stored.preferences.language === "string" && ["recording", "saved", "transcribing", "complete", "interrupted", "error"].includes(stored.status)
      const row: Recording = valid ? stored : {
        id: folder.name, title: new Date((await stat(directory)).birthtimeMs).toLocaleString("en-GB"),
        created: (await stat(directory)).birthtime.toISOString(), rate: 16000, duration: 0,
        status: "interrupted", error: "recovered", transcript: "", completedParts: 0,
        preferences: { model: "elevenlabs/scribe-v2", language: "", microphone: "", speakers: false }
      }
      row.preferences.speakers = row.preferences.speakers === true
      const imported = (await readdir(directory)).find(file => /^original\.[a-z0-9]+$/.test(file))
      if (imported) row.source = imported
      if (row.source === "importing") { row.status = "error"; row.error = "prepare" }
      row.transcript = ""; row.completedParts = 0; row.turns = []
      // Per-part transcript files are the commit record. Never trust an outdated manifest count.
      for (let index = 0; ; index++) {
        const part = await readJSON<{ text: string; turns?: SpeakerTurn[]; preferences?: Preferences }>(path.join(directory, `part-${String(index).padStart(6, "0")}.json`))
        if (!part || typeof part.text !== "string") break
        row.transcript += (row.completedParts ? "\n\n" : "") + part.text
        row.completedParts++
        if (Array.isArray(part.turns)) {
          row.turns.push(...part.turns)
          if (part.preferences && typeof part.preferences.model === "string") row.preferences = { ...part.preferences, speakers: true }
        }
      }
      const chunks = (await readdir(directory)).filter(file => /^\d{8}\.pcm$/.test(file)).sort()
      let bytes = 0
      for (const [index, file] of chunks.entries()) {
        if (file !== `${String(index).padStart(8, "0")}.pcm`) break
        const size = (await stat(path.join(directory, file))).size
        if (size % 2) break
        bytes += size
        this.next.set(row.id, index + 1)
      }
      if (chunks.length) row.duration = bytes / 2 / row.rate
      if (["recording", "transcribing"].includes(row.status) || !valid) { row.status = "interrupted"; row.error = "recovered" }
      this.records.set(row.id, row)
      await this.save(row)
    }
  }
  async create(preferences: Preferences, source?: string) {
    const row: Recording = {
      id: randomUUID(), title: new Date().toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
      created: new Date().toISOString(), rate: 16000, duration: 0, status: source ? "saved" : "recording",
      error: "", transcript: "", completedParts: 0, preferences: { model: preferences.model, language: preferences.language, microphone: preferences.microphone, speakers: preferences.speakers === true }, ...(source ? { source } : {})
    }
    await mkdir(this.directory(row.id), { recursive: true })
    await this.save(row)
    this.records.set(row.id, row)
    return row
  }
  async save(row: Recording) {
    const file = path.join(this.directory(row.id), "recording.json")
    // Keep a previous complete manifest; orphan PCM/part files remain independently recoverable.
    const previous = await readJSON<Recording>(file)
    if (previous) await atomicWrite(path.join(this.directory(row.id), "recording.backup.json"), JSON.stringify(previous))
    await atomicWrite(file, JSON.stringify(row))
  }
  async append(id: string, sequence: number, data: Buffer) {
    const row = this.get(id)
    if (row.status !== "recording" || !Number.isSafeInteger(sequence) || sequence < 0 || data.length === 0 || data.length > row.rate * 2 || data.length % 2) throw new AppError("invalid")
    const next = this.next.get(id) ?? 0
    const file = path.join(this.directory(id), `${String(sequence).padStart(8, "0")}.pcm`)
    if (sequence < next) {
      const existing = await readFile(file)
      if (!createHash("sha256").update(existing).digest().equals(createHash("sha256").update(data).digest())) throw new AppError("invalid")
      return row.duration
    }
    if (sequence !== next) throw new AppError("invalid")
    await atomicWrite(file, data)
    this.next.set(id, next + 1)
    row.duration += data.length / 2 / row.rate
    return row.duration
  }
  async savePart(id: string, index: number, text: string, turns?: SpeakerTurn[]) {
    const row = this.get(id)
    if (index !== row.completedParts) throw new AppError("invalid")
    await atomicWrite(path.join(this.directory(id), `part-${String(index).padStart(6, "0")}.json`), JSON.stringify({ text, ...(turns ? { turns, preferences: row.preferences } : {}) }))
    row.transcript += (row.completedParts ? "\n\n" : "") + text
    row.completedParts++
    if (turns) row.turns = [...(row.turns ?? []), ...turns]
    await atomicWrite(path.join(this.directory(id), "transcript.txt"), row.transcript)
    await this.save(row)
  }
  async copyImport(id: string, source: string) {
    const file = path.join(this.directory(id), "original" + path.extname(source).toLowerCase())
    await copyFile(source, file + ".importing")
    const handle = await open(file + ".importing", "r+")
    try { await handle.sync() } finally { await handle.close() }
    await rename(file + ".importing", file)
    this.get(id).source = path.basename(file)
    await this.save(this.get(id))
  }
  async assemble(id: string) {
    const row = this.get(id)
    if (row.source) return path.join(this.directory(id), path.basename(row.source))
    const output = path.join(this.directory(id), "recording.wav")
    const count = this.next.get(id) ?? 0
    if (!count) throw new AppError("empty")
    const files = Array.from({ length: count }, (_, index) => path.join(this.directory(id), `${String(index).padStart(8, "0")}.pcm`))
    const size = (await Promise.all(files.map(file => stat(file)))).reduce((total, item) => total + item.size, 0)
    // Standard RIFF is bounded at 4 GiB. Capture stays recoverable beyond that boundary.
    if (size > 0xffffffff - 36) throw new AppError("prepare")
    const header = Buffer.alloc(44)
    header.write("RIFF"); header.writeUInt32LE(36 + size, 4); header.write("WAVEfmt ", 8)
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
    header.writeUInt32LE(row.rate, 24); header.writeUInt32LE(row.rate * 2, 28)
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(size, 40)
    async function* audio() { yield header; for (const file of files) yield* createReadStream(file) }
    await pipeline(audio(), createWriteStream(output + ".tmp"))
    const handle = await open(output + ".tmp", "r+")
    try { await handle.sync() } finally { await handle.close() }
    await rename(output + ".tmp", output)
    return output
  }
  async remove(id: string) {
    // Move out of the library first. An interrupted deletion cannot resurrect a partial row.
    const directory = this.directory(id)
    await mkdir(path.join(this.root, "trash"), { recursive: true })
    const trash = path.join(this.root, "trash", id + "-" + Date.now())
    await rename(directory, trash)
    this.records.delete(id); this.next.delete(id)
    await rm(trash, { recursive: true, force: true }).catch(() => undefined)
  }
}
