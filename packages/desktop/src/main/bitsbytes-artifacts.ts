import { createHash } from "node:crypto"
import { basename, extname, join } from "node:path"
import { copyFile, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import type { DocumentArtifact, ArtifactVersion } from "../bitsbytes/types"
import { BBArtifactRuntime } from "./bitsbytes-artifact-runtime"

export class BBArtifacts {
  items: DocumentArtifact[] = []
  private queue = Promise.resolve()
  private saving = Promise.resolve()
  private publishing = Promise.resolve()
  private pending = new Set<string>()
  private focused = new Set<string>()
  private historyPreviews = new Map<string, Promise<string>>()
  runtime: BBArtifactRuntime
  constructor(private root: string, _python: string, private assets: string, private changed: (artifact: DocumentArtifact, published?: boolean) => void) { this.runtime = new BBArtifactRuntime(root, assets) }
  async start() {
    await mkdir(this.root, { recursive: true })
    const source = await readFile(join(this.root, "artifacts.json"), "utf8").catch(() => "[]")
    try {
      const stored: unknown = JSON.parse(source)
      if (!Array.isArray(stored)) throw new Error("Invalid artifact journal")
      this.items = stored.filter(validArtifact)
      if (this.items.length !== stored.length) await writeFile(join(this.root, `artifacts-recovery-${Date.now()}.json`), source)
    } catch {
      await writeFile(join(this.root, `artifacts-recovery-${Date.now()}.json`), source)
      this.items = []
    }
    for (const item of this.items) {
      item.kind ??= "document"; item.mime ??= "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      item.source ??= join(this.root, "previews/sources", item.hash + ".docx")
      item.history ??= [{ revision: item.revision, hash: item.hash, source: item.source, pdf: item.pdf, updated: item.updated }]
      if (item.status === "queued" || item.status === "exporting") await this.enqueue(item)
    }
  }
  private persist() {
    this.saving = this.saving.catch(() => undefined).then(async () => {
      await writeFile(join(this.root, "artifacts.json.tmp"), JSON.stringify(this.items))
      await rename(join(this.root, "artifacts.json.tmp"), join(this.root, "artifacts.json"))
    })
    return this.saving
  }
  publish(path: string, sessionID: string, sourceID?: string, turnID?: string) {
    // Concurrent tool calls must see the preceding snapshot before assigning a revision.
    const result = this.publishing.then(() => this.publishNext(path, sessionID, sourceID, turnID))
    this.publishing = result.then(() => undefined, () => undefined)
    return result
  }
  private async publishNext(path: string, sessionID: string, sourceID?: string, turnID?: string) {
    const actual = await realpath(path)
    const checked = await this.runtime.call<{ hash: string; kind: DocumentArtifact["kind"]; mime: string }>("validate", { path: actual })
    const hash = checked.hash
    const id = createHash("sha256").update(`${sessionID}\0${sourceID ?? actual.toLowerCase()}`).digest("hex").slice(0, 24)
    const old = this.items.find(item => item.id === id)
    const focusKey = `${sessionID}:${turnID ?? "manual:" + id}`
    const focus = !this.focused.has(focusKey)
    if (old?.hash === hash) {
      if (turnID) { old.turnID = turnID; old.turnIDs = [...new Set([...(old.turnIDs ?? []), turnID])] }
      if (old.path !== actual) { old.path = actual; old.filename = basename(actual); await this.persist() }
      else if (turnID) await this.persist()
      this.focused.add(focusKey); this.changed(old, focus); return old
    }
    const source = join(this.root, "previews/sources", hash + extname(actual).toLowerCase())
    const item: DocumentArtifact = { id, sessionID, turnID, turnIDs: [...new Set([...(old?.turnIDs ?? (old?.turnID ? [old.turnID] : [])), ...(turnID ? [turnID] : [])])], path: actual, filename: basename(actual), revision: (old?.revision ?? 0) + 1, hash, kind: checked.kind, mime: checked.mime, source, history: [...(old?.history ?? [])], status: "queued", updated: Date.now(), pdf: "", error: "" }
    await mkdir(join(this.root, "previews/sources"), { recursive: true })
    await copyFile(actual, source)
    if (createHash("sha256").update(await readFile(source)).digest("hex") !== hash) throw new Error("bb.error.invalidDocument")
    item.history!.push({ revision: item.revision, hash, source, pdf: "", updated: item.updated, turnID })
    this.items = [...this.items.filter(row => row.id !== id), item]
    await this.persist(); this.focused.add(focusKey); this.changed(item, focus); await this.enqueue(item)
    return item
  }
  async retry(id: string, revision?: number) {
    const item = this.items.find(row => row.id === id)
    if (!item) throw new Error("bb.error.invalidDocument")
    if (revision !== undefined && revision !== item.revision) { await this.read(id, revision); this.changed(item); return item }
    item.status = "queued"; item.error = ""; this.changed(item); await this.enqueue(item)
    return item
  }
  private version(id: string, revision?: number) {
    const item = this.items.find(row => row.id === id)
    if (!item) throw new Error("bb.error.invalidDocument")
    const version = revision === undefined ? undefined : item.history?.find(row => row.revision === revision)
    if (revision !== undefined && !version) throw new Error("bb.error.invalidDocument")
    return { item, source: version?.source ?? item.source!, pdf: version?.pdf ?? item.pdf }
  }
  async read(id: string, revision?: number) {
    const selected = this.version(id, revision)
    let pdf = selected.pdf
    if (!pdf && revision !== undefined && ["document", "presentation"].includes(selected.item.kind ?? "document")) {
      const key = `${id}:${revision}`
      let pending = this.historyPreviews.get(key)
      if (!pending) {
        const render = this.queue.catch(() => undefined).then(async () => {
          const current = this.version(id, revision)
          if (current.pdf) return current.pdf
          const output = await this.runtime.call<{ pdf: string }>("render", { path: current.source, folder: join(this.root, "previews/pdf") })
          if (!(await readFile(output.pdf)).subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("bb.error.invalidDocument")
          const version = current.item.history!.find(row => row.revision === revision)!
          version.pdf = output.pdf
          await this.persist()
          return output.pdf
        })
        this.queue = render.then(() => undefined, () => undefined)
        pending = render.finally(() => this.historyPreviews.delete(key))
        this.historyPreviews.set(key, pending)
      }
      pdf = await pending
    }
    return pdf ? new Uint8Array(await readFile(pdf)) : null
  }
  async content(id: string, args: Record<string, unknown> = {}) {
    const selected = this.version(id, args.revision === undefined ? undefined : Number(args.revision))
    if (selected.item.kind === "spreadsheet") { const cached = join(this.root, "previews/pdf", basename(selected.source)); return this.runtime.call("grid", { path: existsSync(cached) ? cached : selected.source, sheet: args.sheet, offset: args.offset, limit: args.limit }) }
    if (selected.item.kind === "image") return { data: new Uint8Array(await readFile(selected.source)), mime: selected.item.mime }
    if (selected.item.kind === "html" || selected.item.kind === "code") {
      const text = await readFile(selected.source, "utf8")
      if (text.length > 8e6) throw new Error("bb.error.fileTooLarge")
      return { text, mime: selected.item.mime }
    }
    return { text: "" }
  }
  async pages(id: string, start = 0) {
    const selected = this.version(id)
    if (!selected.pdf) throw new Error("bb.error.previewPending")
    const result = await this.runtime.call<{ pages: number; images: string[]; next: number | null }>("pages", { path: selected.pdf, folder: join(this.root, "previews/pages", selected.item.hash), start })
    return { content: [{ type: "text", text: JSON.stringify({ pages: result.pages, next: result.next }) }, ...await Promise.all(result.images.map(async path => ({ type: "image", data: (await readFile(path)).toString("base64"), mimeType: "image/png" })))] }
  }
  async saveCopy(id: string, target: string, revision?: number) {
    const selected = this.version(id, revision)
    await copyFile(selected.source, target)
    const verified = await this.runtime.call<{ hash: string }>("validate", { path: target })
    if (verified.hash !== createHash("sha256").update(await readFile(selected.source)).digest("hex")) throw new Error("bb.error.invalidDocument")
    return { path: target, verified: true }
  }
  private enqueue(item: DocumentArtifact) {
    if (["html", "code", "image", "pdf"].includes(item.kind ?? "")) {
      item.status = "ready"
      if (item.kind === "pdf") { item.pdf = item.source ?? item.path; const version = item.history?.find(row => row.revision === item.revision); if (version) version.pdf = item.pdf }
      return this.persist().then(() => this.changed(item))
    }
    const key = `${item.id}:${item.revision}`
    if (this.pending.has(key)) return
    this.pending.add(key)
    this.queue = this.queue.catch(() => undefined).then(async () => {
      if (this.items.find(row => row.id === item.id) !== item) { this.pending.delete(key); return }
      item.status = "exporting"; this.changed(item); await this.persist()
      try {
        const output = await this.runtime.call<{ pdf: string; formulaErrors?: unknown[] }>("render", { path: item.source, folder: join(this.root, "previews/pdf") })
        if (output.pdf && !(await readFile(output.pdf)).subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("bb.error.invalidDocument")
        item.pdf = output.pdf; item.status = "ready"
        const version = item.history?.find(row => row.revision === item.revision)
        if (version) version.pdf = output.pdf
        if (output.formulaErrors?.length) item.error = "bb.error.formulaErrors"
      } catch (error) { item.status = "error"; item.error = String((error as Error).message ?? error) }
      finally { this.pending.delete(key); await this.persist(); if (this.items.find(row => row.id === item.id) === item) this.changed(item) }
    })
  }
}

function validArtifact(value: unknown): value is DocumentArtifact {
  if (!value || typeof value !== "object") return false
  const item = value as DocumentArtifact
  return typeof item.id === "string" && typeof item.sessionID === "string"
    && typeof item.path === "string" && typeof item.filename === "string" && typeof item.hash === "string"
    && Number.isInteger(item.revision) && item.revision > 0 && Number.isFinite(item.updated)
    && ["queued", "exporting", "ready", "error"].includes(item.status)
    && (item.history === undefined || (Array.isArray(item.history) && item.history.every(version =>
      version && Number.isInteger(version.revision) && typeof version.source === "string" && typeof version.hash === "string")))
}
