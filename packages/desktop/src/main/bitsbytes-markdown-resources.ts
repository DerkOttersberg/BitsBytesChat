import { createHash } from "node:crypto"
import { mkdir, open, realpath, rename, writeFile } from "node:fs/promises"
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { BBReadImages, validateReadImage } from "./bitsbytes-read-images"

export type MarkdownResource = { href: string; id?: string; mime?: string; width?: number; height?: number }
type Manifest = { artifactID: string; revision: number; sessionID: string; resources: MarkdownResource[] }
const maximumBytes = 4 * 1024 * 1024
const mime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" }

export class BBMarkdownResources {
  constructor(private root: string, private images = new BBReadImages(root)) {}

  async snapshot(input: { artifactID: string; revision: number; sessionID: string; path: string; text: string }) {
    if (!input.sessionID || input.text.length > 500_000) return
    const resources: MarkdownResource[] = []
    for await (const resource of resourceBytes(input.path, input.text)) {
      try {
        if (!resource.bytes || !resource.mime) { resources.push({ href: resource.href }); continue }
        const image = await this.images.snapshot({ sessionID: input.sessionID, messageID: "artifact_" + input.artifactID,
          partID: "markdown:" + input.revision, attachmentIndex: resource.index, mime: resource.mime, url: `data:${resource.mime};base64,${resource.bytes.toString("base64")}` })
        resources.push({ href: resource.href, ...image })
      } catch { resources.push({ href: resource.href }) }
    }
    const manifest: Manifest = { artifactID: input.artifactID, revision: input.revision, sessionID: input.sessionID, resources }
    const path = this.path(input.artifactID, input.revision)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path + ".tmp", JSON.stringify(manifest))
    await rename(path + ".tmp", path)
  }

  async list(artifactID: string, revision: number, sessionID: string) {
    const text = await boundedRead(this.path(artifactID, revision), 128_000).catch(() => undefined)
    if (!text) return []
    try {
      const value: Manifest = JSON.parse(text.toString("utf8"))
      if (value.artifactID !== artifactID || value.revision !== revision || value.sessionID !== sessionID || !Array.isArray(value.resources) || value.resources.length > 17) return []
      return value.resources.filter(row => typeof row?.href === "string" && row.href.length <= 1024 && (row.id === undefined || /^[a-f0-9]{64}$/.test(row.id)))
    } catch { return [] }
  }

  async read(artifactID: string, revision: number, sessionID: string, href: string) {
    const resource = (await this.list(artifactID, revision, sessionID)).find(row => row.href === href)
    if (!resource?.id) throw new Error("bb.error.imageSnapshot.unavailable")
    return this.images.read(resource.id, sessionID)
  }

  private path(id: string, revision: number) {
    const key = createHash("sha256").update(JSON.stringify([id, revision])).digest("hex")
    return join(this.root, "previews/markdown-resources", key + ".json")
  }
}

/** Working files use current bytes; only published revisions persist image snapshots. */
export async function workingMarkdownResources(input: { directory: string; path: string; text: string }, decode?: Parameters<typeof validateReadImage>[2]) {
  const directory = await realpath(input.directory)
  const candidate = resolve(directory, input.path)
  if (!inside(directory, candidate)) throw new Error("bb.error.invalidDocument")
  const actual = await realpath(candidate)
  if (!inside(directory, actual) || !/\.(md|markdown|mdown)$/i.test(actual)) throw new Error("bb.error.invalidDocument")
  const resources: (MarkdownResource & { data?: Uint8Array })[] = []
  for await (const resource of resourceBytes(actual, input.text)) {
    try {
      if (!resource.bytes || !resource.mime) { resources.push({ href: resource.href }); continue }
      const size = await validateReadImage(resource.bytes, resource.mime, decode)
      resources.push({ href: resource.href, mime: resource.mime, data: new Uint8Array(resource.bytes), ...size })
    } catch { resources.push({ href: resource.href }) }
  }
  return { path: actual, resources }
}

async function* resourceBytes(path: string, text: string): AsyncGenerator<{ href: string; index: number; bytes?: Buffer; mime?: string }> {
  if (text.length > 500_000) return
  const { marked } = await import("marked")
  const references = new Set<string>()
  let omitted = false
  marked.walkTokens(marked.lexer(text), token => {
    if (token.type !== "image" || references.has(token.href)) return
    if (token.href.length > 1024 || references.size >= 16) { omitted = true; return }
    references.add(token.href)
  })
  const folder = await realpath(dirname(path))
  let total = 0
  for (const [index, href] of [...references].entries()) {
    const absent = { href, index }
    try {
      const decoded = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? "")
      if (!decoded || /^[a-z][a-z\d+.-]*:/i.test(decoded) || isAbsolute(decoded) || decoded.startsWith("\\") || decoded.includes("\0")) { yield absent; continue }
      const candidate = resolve(folder, decoded)
      if (!inside(folder, candidate)) { yield absent; continue }
      const actual = await realpath(candidate)
      if (!inside(folder, actual) || !mime[extname(actual).toLowerCase()]) { yield absent; continue }
      const bytes = await boundedRead(actual, Math.min(maximumBytes, 16 * 1024 * 1024 - total))
      if (!bytes) { yield absent; continue }
      total += bytes.length
      yield { href, index, bytes, mime: mime[extname(actual).toLowerCase()]! }
    } catch { yield absent }
  }
  // Explain omitted images without retaining arbitrary URLs or one row per token.
  if (omitted) yield { href: "", index: 16 }
}

function inside(folder: string, path: string) {
  const difference = relative(folder, path)
  return difference !== "" && difference !== ".." && !difference.startsWith("..\\") && !difference.startsWith("../") && !isAbsolute(difference)
}

async function boundedRead(path: string, limit: number) {
  const file = await open(path, "r")
  try {
    const size = (await file.stat()).size
    if (!size || size > limit) return
    const data = Buffer.alloc(size + 1)
    let length = 0
    while (length < data.length) {
      const read = await file.read(data, length, data.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length !== size) return
    return data.subarray(0, size)
  } finally { await file.close() }
}
