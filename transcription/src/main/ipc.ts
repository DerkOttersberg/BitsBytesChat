import { clipboard, dialog, ipcMain, safeStorage, shell } from "electron"
import type { BrowserWindow } from "electron"
import { copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { AppError, copy } from "../copy.js"
import type { Preferences, Recording, Settings, Snapshot } from "../shared.js"
import { atomicWrite, Library, readJSON } from "./storage.js"
import { Transcriber } from "./transcriber.js"

type StoredSettings = Preferences & { encryptedKey?: string }
const defaults: StoredSettings = { model: "elevenlabs/scribe-v2", language: "", microphone: "" }

export class Application {
  library: Library
  transcriber: Transcriber
  activeId?: string
  busyId?: string
  private settings = { ...defaults }
  private task?: Promise<void>
  private starting?: Promise<Recording>
  private appending: Promise<unknown> = Promise.resolve()
  private fileTask = false
  audioFiles = new Map<string, string>()
  constructor(public root: string, private window: BrowserWindow, private version: string) {
    this.library = new Library(root)
    this.transcriber = new Transcriber(this.library, () => this.changed())
  }
  async initialize() {
    await mkdir(this.root, { recursive: true })
    const settings = await readJSON<StoredSettings>(path.join(this.root, "settings.json")) ?? await readJSON<StoredSettings>(path.join(this.root, "settings.backup.json"))
    if (settings && typeof settings.model === "string" && typeof settings.language === "string" && typeof settings.microphone === "string") this.settings = settings
    await this.library.initialize()
  }
  changed() {
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed() && !this.window.webContents.isCrashed()) this.window.webContents.send("changed")
  }
  snapshot(): Snapshot {
    return { recordings: [...this.library.records.values()].sort((a, b) => b.created.localeCompare(a.created)).map(row => ({ ...row })), settings: { model: this.settings.model, language: this.settings.language, microphone: this.settings.microphone, hasKey: !!this.settings.encryptedKey, storagePath: path.join(this.root, "recordings") }, activeId: this.activeId, busyId: this.busyId, version: this.version }
  }
  private idle() {
    if (this.activeId) throw new AppError("active")
    if (this.busyId || this.fileTask) throw new AppError("busy")
  }
  async finish(id: string, error?: string) {
    if (this.activeId !== id) throw new AppError("invalid")
    await this.appending.catch(() => undefined)
    const row = this.library.get(id)
    row.status = error ? "interrupted" : "saved"; row.error = error && error in copy.errors ? error : ""
    try {
      // A finished recording also has an ordinary playable WAV, independent of the manifest.
      if (row.duration > 0) await this.library.assemble(id)
      await this.library.save(row)
    } catch {
      row.status = "interrupted"; row.error = "storage"
      await this.library.save(row).catch(() => undefined)
      throw new AppError("storage")
    } finally { this.activeId = undefined; this.changed() }
  }
  async shutdown() {
    await this.starting?.catch(() => undefined)
    if (this.activeId) await this.finish(this.activeId, "recovered")
    this.transcriber.cancel()
    await this.task
  }
  register() {
    const handle = (name: string, action: (...args: never[]) => unknown) => {
      ipcMain.handle(name, async (event, ...args) => {
        if (event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame) return { ok: false, error: "invalid" }
        try { return { ok: true, value: await action(...args as never[]) } }
        catch (error) { return { ok: false, error: error instanceof AppError ? error.code : "storage" } }
      })
    }
    handle("snapshot", () => this.snapshot())
    handle("start", async () => {
      this.idle()
      // Claim the recorder synchronously before the first disk await.
      this.activeId = "starting"
      try {
        this.starting = this.library.create(this.settings)
        const row = await this.starting
        this.activeId = row.id; this.changed(); return row
      } catch (error) { this.activeId = undefined; throw error }
      finally { this.starting = undefined }
    })
    handle("append", (id: string, sequence: number, input: ArrayBuffer) => {
      if (this.activeId !== id || !(input instanceof ArrayBuffer)) throw new AppError("invalid")
      const operation = this.appending.catch(() => undefined).then(() => this.library.append(id, sequence, Buffer.from(input)))
      this.appending = operation
      return operation
    })
    handle("finish", (id: string, error?: string) => this.finish(id, error))
    handle("saveSettings", async (input: Preferences & { key: string }) => {
      if (!input || typeof input.model !== "string" || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]{0,180}$/i.test(input.model.trim()) || typeof input.language !== "string" || !/^([a-z]{2})?$/.test(input.language.trim()) || typeof input.microphone !== "string" || input.microphone.length > 1024 || typeof input.key !== "string" || input.key.length > 4096) throw new AppError("settings")
      if (input.key.trim() && !safeStorage.isEncryptionAvailable()) throw new AppError("encryption")
      const next = { model: input.model.trim(), language: input.language.trim(), microphone: input.microphone, encryptedKey: input.key.trim() ? safeStorage.encryptString(input.key.trim()).toString("base64") : this.settings.encryptedKey }
      await atomicWrite(path.join(this.root, "settings.backup.json"), JSON.stringify(this.settings))
      await atomicWrite(path.join(this.root, "settings.json"), JSON.stringify(next))
      this.settings = next; this.changed()
    })
    handle("transcribe", async (id: string) => {
      this.idle()
      const row = this.library.get(id)
      if (row.status === "complete") return
      if (!this.settings.encryptedKey) throw new AppError("key")
      let key: string
      try { key = safeStorage.decryptString(Buffer.from(this.settings.encryptedKey, "base64")) } catch { throw new AppError("encryption") }
      this.busyId = id
      this.task = this.transcriber.transcribe(id, key).catch(() => {
        row.status = "error"; row.error = "storage"
      }).finally(() => { this.busyId = undefined; this.changed() })
      this.changed()
    })
    handle("cancel", () => { this.transcriber.cancel() })
    handle("copy", (id: string) => { clipboard.writeText(this.library.get(id).transcript) })
    handle("audio", async (id: string) => {
      if (this.activeId) throw new AppError("active")
      this.library.get(id)
      const prepared = await readJSON<{ parts: string[] }>(path.join(this.library.directory(id), "prepared.json"))
      const file = prepared ? path.join(this.library.directory(id), "audio.mp3") : await this.library.assemble(id)
      this.audioFiles.set(id, file)
      return `bb-audio://recording/${id}`
    })
    handle("folder", async () => { const error = await shell.openPath(path.join(this.root, "recordings")); if (error) throw new AppError("storage") })
    handle("importAudio", async () => {
      this.idle(); this.fileTask = true
      try {
        const result = await dialog.showOpenDialog(this.window, { title: copy.importTitle, properties: ["openFile"], filters: [{ name: copy.audioFiles, extensions: ["mp3", "wav", "m4a", "mp4", "ogg", "flac", "webm", "aac"] }] })
        if (result.canceled || !result.filePaths[0]) return
        const row = await this.library.create(this.settings, "importing")
        try { await this.library.copyImport(row.id, result.filePaths[0]) }
        catch { row.status = "error"; row.error = "storage"; await this.library.save(row); throw new AppError("storage") }
        row.title = path.basename(result.filePaths[0]); await this.library.save(row); this.changed(); return row.id
      } finally { this.fileTask = false }
    })
    handle("exportAudio", async (id: string) => {
      this.idle(); this.fileTask = true
      try {
        const row = this.library.get(id)
        const prepared = await readJSON<{ parts: string[] }>(path.join(this.library.directory(id), "prepared.json"))
        const file = prepared ? path.join(this.library.directory(id), "audio.mp3") : await this.library.assemble(id)
        const result = await dialog.showSaveDialog(this.window, { title: copy.exportTitle, defaultPath: row.title.replace(/[<>:"/\\|?*]/g, "-") + path.extname(file), filters: [{ name: copy.audioFile, extensions: [path.extname(file).slice(1)] }] })
        if (!result.canceled && result.filePath && path.resolve(result.filePath).toLowerCase() !== path.resolve(file).toLowerCase()) await copyFile(file, result.filePath)
      } finally { this.fileTask = false }
    })
    handle("remove", async (id: string) => {
      this.idle(); this.library.get(id)
      const result = await dialog.showMessageBox(this.window, { type: "warning", title: copy.removeTitle, message: copy.removeTitle, detail: copy.removeBody, buttons: [copy.keep, copy.delete], defaultId: 0, cancelId: 0, noLink: true })
      if (result.response !== 1) return
      this.idle(); await this.library.remove(id); this.audioFiles.delete(id); this.changed()
    })
  }
}
