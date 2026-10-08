import { createHash, randomUUID } from "node:crypto"
import { basename, extname, join } from "node:path"
import { copyFile, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { StringDecoder } from "node:string_decoder"
import type { DocumentArtifact, ArtifactVersion, SpreadsheetGrid } from "../bitsbytes/types"
import { BBArtifactRuntime } from "./bitsbytes-artifact-runtime"
import { fileHash } from "./bitsbytes-file-hash"
import { BBMarkdownResources } from "./bitsbytes-markdown-resources"

export class BBArtifacts {
  items: DocumentArtifact[] = []
  private queue = Promise.resolve()
  private saving = Promise.resolve()
  private publishing = Promise.resolve()
  private pending = new Set<string>()
  private focused = new Set<string>()
  private historyPreviews = new Map<string, Promise<string>>()
  runtime: BBArtifactRuntime
  private markdown: BBMarkdownResources
  constructor(private root: string, _python: string, private assets: string, private changed: (artifact: DocumentArtifact, published?: boolean) => void) { this.runtime = new BBArtifactRuntime(root, assets); this.markdown = new BBMarkdownResources(root) }
  async start() {
    await mkdir(this.root, { recursive: true })
    const source = await readFile(join(this.root, "artifacts.json"), "utf8").catch(error => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "[]"
      throw error
    })
    let stored: unknown
    try { stored = JSON.parse(source) } catch {}
    const recovered = Array.isArray(stored) ? stored.filter(validArtifact) : []
    // A failed recovery copy must not be mistaken for invalid JSON or discard
    // valid neighboring records. Keep the original readable before adopting it.
    if (!Array.isArray(stored) || recovered.length !== stored.length)
      await writeFile(join(this.root, `artifacts-recovery-${randomUUID()}.json`), source)
    this.items = recovered
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
  publish(path: string, sessionID: string, sourceID?: string, turnID?: string, image?: DocumentArtifact["image"]) {
    // Concurrent tool calls must see the preceding snapshot before assigning a revision.
    const result = this.publishing.then(() => this.publishNext(path, sessionID, sourceID, turnID, image))
    this.publishing = result.then(() => undefined, () => undefined)
    return result
  }
  private async publishNext(path: string, sessionID: string, sourceID?: string, turnID?: string, image?: DocumentArtifact["image"]) {
    const actual = await realpath(path)
    const checked = await this.runtime.call<{ hash: string; kind: DocumentArtifact["kind"]; mime: string }>("validate", { path: actual })
    const hash = checked.hash
    const id = createHash("sha256").update(`${sessionID}\0${sourceID ?? actual.toLowerCase()}`).digest("hex").slice(0, 24)
    const old = this.items.find(item => item.id === id)
    const focusKey = `${sessionID}:${turnID ?? "manual:" + id}`
    const focus = !this.focused.has(focusKey)
    if (old?.hash === hash) {
      if (image) old.image = image
      if (turnID) { old.turnID = turnID; old.turnIDs = [...new Set([...(old.turnIDs ?? []), turnID])] }
      if (old.path !== actual) { old.path = actual; old.filename = basename(actual) }
      await this.persist()
      this.focused.add(focusKey); this.changed(old, focus)
      if (old.status === "queued" || old.status === "exporting" || old.status === "error" && ["html", "code", "image", "pdf"].includes(old.kind ?? "")) await this.enqueue(old)
      return old
    }
    const source = join(this.root, "previews/sources", hash + extname(actual).toLowerCase())
    const item: DocumentArtifact = { id, sessionID, turnID, turnIDs: [...new Set([...(old?.turnIDs ?? (old?.turnID ? [old.turnID] : [])), ...(turnID ? [turnID] : [])])], path: actual, filename: basename(actual), revision: (old?.revision ?? 0) + 1, hash, kind: checked.kind, mime: checked.mime, source, history: [...(old?.history ?? [])], status: "queued", updated: Date.now(), pdf: "", error: "", ...(image ? { image } : {}) }
    await mkdir(join(this.root, "previews/sources"), { recursive: true })
    await copyFile(actual, source)
    if (await fileHash(source) !== hash) throw new Error("bb.error.invalidDocument")
    if (checked.kind === "code" && /\.(md|markdown|mdown)$/i.test(actual))
      await this.markdown.snapshot({ artifactID: id, revision: item.revision, sessionID, path: actual, text: await readPreviewText(source) })
    item.history!.push({ revision: item.revision, hash, source, pdf: "", updated: item.updated, turnID })
    this.items = [...this.items.filter(row => row.id !== id), item]
    await this.persist(); this.focused.add(focusKey); this.changed(item, focus); await this.enqueue(item)
    return item
  }
  async retry(id: string, revision?: number) {
    const item = this.items.find(row => row.id === id)
    if (!item) throw new Error("bb.error.invalidDocument")
    if (revision !== undefined && revision !== item.revision) {
      this.version(id, revision)
      item.history!.find(version => version.revision === revision)!.pdf = ""
      await this.read(id, revision); this.changed(item); return item
    }
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
    const pdf = await this.previewPath(id, revision)
    return pdf ? new Uint8Array(await readFile(pdf)) : null
  }
  async previewPath(id: string, revision?: number) {
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
          await checkPDF(output.pdf)
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
    return pdf || null
  }
  async content(id: string, args: Record<string, unknown> = {}) {
    const selected = this.version(id, args.revision === undefined ? undefined : Number(args.revision))
    if (selected.item.kind === "spreadsheet") { const cached = join(this.root, "previews/pdf", basename(selected.source)); return this.runtime.call<SpreadsheetGrid>("grid", { path: existsSync(cached) ? cached : selected.source, sheet: args.sheet, offset: args.offset, limit: args.limit }) }
    if (selected.item.kind === "image") return { data: new Uint8Array(await readFile(selected.source)), mime: selected.item.mime }
    if (selected.item.kind === "html" || selected.item.kind === "code") {
      const revision = args.revision === undefined ? selected.item.revision : Number(args.revision)
      return { text: await readPreviewText(selected.source), mime: selected.item.mime, revision,
        resources: /\.(md|markdown|mdown)$/i.test(selected.source) ? await this.markdown.list(id, revision, selected.item.sessionID) : undefined }
    }
    return { text: "" }
  }
  async resource(id: string, href: string, revision?: number) {
    const selected = this.version(id, revision)
    return this.markdown.read(id, revision ?? selected.item.revision, selected.item.sessionID, href)
  }
  async pages(id: string, start = 0, options: { revision?: number; signal?: AbortSignal; waitMs?: number } = {}) {
    const initial = this.version(id, options.revision)
    const revision = options.revision ?? initial.item.revision
    const hash = initial.item.history?.find(row => row.revision === revision)?.hash ?? initial.item.hash
    const deadline = Date.now() + Math.min(30_000, Math.max(0, options.waitMs ?? 20_000))
    if (!["document", "presentation", "spreadsheet", "pdf"].includes(initial.item.kind ?? "document"))
      throw new Error("bb.error.unsupportedArtifact")
    let historicalError: unknown
    if (!initial.pdf && revision !== initial.item.revision && ["document", "presentation"].includes(initial.item.kind ?? "document"))
      void this.previewPath(id, revision).catch(error => { historicalError = error })
    // Pin the revision. A later publication must never change the requested pages.
    for (;;) {
      options.signal?.throwIfAborted()
      if (historicalError) throw historicalError
      const selected = this.version(id, revision)
      if (selected.pdf) {
        const result = await this.runtime.call<{ pages: number; images: string[]; next: number | null }>("pages", { path: selected.pdf, folder: join(this.root, "previews/pages", hash), start }, options.signal)
        return { status: "ready" as const, id, revision, content: [{ type: "text", text: JSON.stringify({ status: "ready", id, revision, pages: result.pages, next: result.next }) }, ...await Promise.all(result.images.map(async path => ({ type: "image", data: (await readFile(path)).toString("base64"), mimeType: "image/png" })))] }
      }
      if (selected.item.revision === revision && selected.item.status === "error")
        throw new Error(selected.item.error || "bb.error.invalidDocument")
      if (Date.now() >= deadline)
        return { status: "preparing" as const, id, revision, retryAfterMs: 1000, content: [{ type: "text", text: JSON.stringify({ status: "preparing", id, revision, retryAfterMs: 1000 }) }] }
      // Cancellation belongs to this waiter; the shared export remains recoverable.
      await waitForPreview(Math.min(100, deadline - Date.now()), options.signal)
    }
  }
  async saveCopy(id: string, target: string, revision?: number) {
    const selected = this.version(id, revision)
    await copyFile(selected.source, target)
    const verified = await this.runtime.call<{ hash: string }>("validate", { path: target })
    if (verified.hash !== await fileHash(selected.source)) throw new Error("bb.error.invalidDocument")
    return { path: target, verified: true }
  }
  private enqueue(item: DocumentArtifact) {
    if (["html", "code", "image", "pdf"].includes(item.kind ?? "")) {
      item.status = "ready"; item.error = ""
      if (item.kind === "pdf") { item.pdf = item.source ?? item.path; const version = item.history?.find(row => row.revision === item.revision); if (version) version.pdf = item.pdf }
      return this.persist().catch(error => { item.status = "error"; item.error = String(error instanceof Error ? error.message : error) }).then(() => this.changed(item))
    }
    const key = `${item.id}:${item.revision}`
    if (this.pending.has(key)) return
    this.pending.add(key)
    this.queue = this.queue.catch(() => undefined).then(async () => {
      if (this.items.find(row => row.id === item.id) !== item) { this.pending.delete(key); return }
      try {
        item.status = "exporting"; this.changed(item); await this.persist()
        const output = await this.runtime.call<{ pdf: string; formulaErrors?: unknown[] }>("render", { path: item.source, folder: join(this.root, "previews/pdf") })
        if (output.pdf) await checkPDF(output.pdf)
        item.pdf = output.pdf; item.status = "ready"
        const version = item.history?.find(row => row.revision === item.revision)
        if (version) version.pdf = output.pdf
        if (output.formulaErrors?.length) item.error = "bb.error.formulaErrors"
      } catch (error) { item.status = "error"; item.error = String((error as Error).message ?? error) }
      finally {
        this.pending.delete(key)
        await this.persist().catch(error => { item.status = "error"; item.error = String(error instanceof Error ? error.message : error) })
        if (this.items.find(row => row.id === item.id) === item) this.changed(item)
      }
    })
  }
}

function waitForPreview(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve() }
    const timer = setTimeout(finish, ms)
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("AbortError")) }
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
  })
}

async function readPreviewText(path: string) {
  const file = await open(path, "r")
  try {
    // No UTF-8 source fitting the existing character limit needs this many
    // bytes. Reject oversized snapshots before allocating their complete text.
    if ((await file.stat()).size > 8e6 * 4) throw new Error("bb.error.fileTooLarge")
    const buffer = Buffer.alloc(64 * 1024), decoder = new StringDecoder("utf8")
    let text = ""
    for (;;) {
      const result = await file.read(buffer, 0, buffer.length, null)
      if (!result.bytesRead) break
      text += decoder.write(buffer.subarray(0, result.bytesRead))
      if (text.length > 8e6) throw new Error("bb.error.fileTooLarge")
    }
    text += decoder.end()
    if (text.length > 8e6) throw new Error("bb.error.fileTooLarge")
    return text
  } finally { await file.close() }
}

async function checkPDF(path: string) {
  const file = await open(path, "r")
  try {
    const header = Buffer.alloc(5)
    await file.read(header, 0, header.length, 0)
    if (!header.equals(Buffer.from("%PDF-"))) throw new Error("bb.error.invalidDocument")
  } finally {
    await file.close()
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
