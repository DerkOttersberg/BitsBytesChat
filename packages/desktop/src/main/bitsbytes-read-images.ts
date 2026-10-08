import { createHash } from "node:crypto"
import { mkdir, open, writeFile } from "node:fs/promises"
import { join } from "node:path"

const maximumBytes = 24 * 1024 * 1024
const supported = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
const identity = /^[a-zA-Z0-9_-]{1,160}$/
const digest = /^[a-f0-9]{64}$/
type Provenance = { sessionID: string; messageID: string; partID: string; attachmentIndex: number }
type Snapshot = Provenance & { id: string; hash: string; mime: string; width: number; height: number; bytes: number }

/** Explicit image previews keep the bytes recorded by the tool, never reread its source path. */
export class BBReadImages {
  private writing = new Map<string, Promise<void>>()
  constructor(private root: string, private decode = decodedSize) {}

  async snapshot(input: Record<string, unknown>) {
    const provenance = requireProvenance(input)
    if (typeof input.mime !== "string" || !supported.has(input.mime) || typeof input.url !== "string")
      throw new Error("bb.error.imageSnapshot.invalid")
    const prefix = `data:${input.mime};base64,`
    if (!input.url.startsWith(prefix) || input.url.length > maximumBytes * 4 / 3 + prefix.length + 4)
      throw new Error("bb.error.imageSnapshot.invalid")
    const encoded = input.url.slice(prefix.length)
    if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw new Error("bb.error.imageSnapshot.invalid")
    const bytes = Buffer.from(encoded, "base64")
    if (!bytes.length || bytes.length > maximumBytes || bytes.toString("base64") !== encoded || rasterMime(bytes) !== input.mime)
      throw new Error("bb.error.imageSnapshot.invalid")
    const size = await validateReadImage(bytes, input.mime, this.decode)
    const hash = createHash("sha256").update(bytes).digest("hex")
    const id = createHash("sha256").update(JSON.stringify({ ...provenance, hash })).digest("hex")
    const snapshot: Snapshot = { ...provenance, id, hash, mime: input.mime, ...size, bytes: bytes.length }
    const folder = join(this.root, "read-images")
    await mkdir(folder, { recursive: true })
    await this.write(join(folder, hash + ".image"), bytes)
    await this.write(join(folder, id + ".json"), JSON.stringify(snapshot))
    return { id, mime: snapshot.mime, width: size.width, height: size.height }
  }

  async read(id: string, sessionID: string) {
    if (!digest.test(id) || !identity.test(sessionID)) throw new Error("bb.error.imageSnapshot.invalid")
    const folder = join(this.root, "read-images")
    const metadata: unknown = JSON.parse((await boundedRead(join(folder, id + ".json"), 4096)).toString("utf8"))
    if (!validSnapshot(metadata) || metadata.id !== id || metadata.sessionID !== sessionID)
      throw new Error("bb.error.imageSnapshot.unavailable")
    const bytes = await boundedRead(join(folder, metadata.hash + ".image"), maximumBytes)
    if (bytes.length !== metadata.bytes || bytes.length > maximumBytes || rasterMime(bytes) !== metadata.mime || createHash("sha256").update(bytes).digest("hex") !== metadata.hash)
      throw new Error("bb.error.imageSnapshot.unavailable")
    return { data: new Uint8Array(bytes), mime: metadata.mime, width: metadata.width, height: metadata.height }
  }

  private write(path: string, data: string | Buffer) {
    const pending = this.writing.get(path)
    if (pending) return pending
    const writing = immutableWrite(path, data).finally(() => this.writing.delete(path))
    this.writing.set(path, writing)
    return writing
  }
}

export async function validateReadImage(bytes: Buffer, mime: string, decode = decodedSize) {
  const header = rasterMime(bytes) === mime && rasterSize(bytes, mime)
  if (!header || header.width < 1 || header.height < 1 || header.width * header.height > 100_000_000)
    throw new Error("bb.error.imageSnapshot.invalid")
  const size = await decode(bytes)
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1 || size.width * size.height > 100_000_000)
    throw new Error("bb.error.imageSnapshot.invalid")
  return size
}

async function decodedSize(data: Buffer) {
  const { nativeImage } = await import("electron")
  const image = nativeImage.createFromBuffer(data)
  if (image.isEmpty()) throw new Error("bb.error.imageSnapshot.invalid")
  return image.getSize()
}

function requireProvenance(input: Record<string, unknown>): Provenance {
  if (typeof input.sessionID !== "string" || !identity.test(input.sessionID)
    || typeof input.messageID !== "string" || !identity.test(input.messageID)
    || typeof input.partID !== "string" || !/^[^\u0000-\u001f]{1,512}$/.test(input.partID)
    || typeof input.attachmentIndex !== "number" || !Number.isSafeInteger(input.attachmentIndex) || input.attachmentIndex < 0 || input.attachmentIndex > 1024)
    throw new Error("bb.error.imageSnapshot.invalid")
  return { sessionID: input.sessionID, messageID: input.messageID, partID: input.partID, attachmentIndex: input.attachmentIndex }
}

function validSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object") return false
  const item = value as Snapshot
  const valid = typeof item.id === "string" && digest.test(item.id) && typeof item.hash === "string" && digest.test(item.hash)
    && typeof item.sessionID === "string" && identity.test(item.sessionID)
    && typeof item.mime === "string" && supported.has(item.mime)
    && Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= maximumBytes
    && Number.isSafeInteger(item.width) && item.width > 0 && Number.isSafeInteger(item.height) && item.height > 0
    && item.width * item.height <= 100_000_000
  if (!valid) return false
  try {
    const provenance = requireProvenance(value as Record<string, unknown>)
    return createHash("sha256").update(JSON.stringify({ ...provenance, hash: item.hash })).digest("hex") === item.id
  } catch { return false }
}

function rasterMime(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg"
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif"
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp"
}

// Read bounded dimensions before asking the native decoder to allocate pixels.
function rasterSize(bytes: Buffer, mime: string): { width: number; height: number } | undefined {
  if (mime === "image/png" && bytes.length >= 24 && bytes.subarray(12, 16).toString("ascii") === "IHDR")
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  if (mime === "image/gif" && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  if (mime === "image/webp" && bytes.length >= 30) {
    const type = bytes.subarray(12, 16).toString("ascii")
    if (type === "VP8X") return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
    if (type === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
    if (type === "VP8L" && bytes[20] === 0x2f) {
      const value = bytes.readUInt32LE(21)
      return { width: (value & 0x3fff) + 1, height: ((value >>> 14) & 0x3fff) + 1 }
    }
  }
  if (mime !== "image/jpeg") return
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return
    if (bytes[offset + 1] === 0xff) { offset++; continue }
    const marker = bytes[offset + 1]!
    if (marker === 0xda || marker === 0xd9) return
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) { offset += 2; continue }
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2 || offset + length + 2 > bytes.length) return
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7)
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
    offset += length + 2
  }
}

async function boundedRead(path: string, limit: number) {
  const file = await open(path, "r")
  try {
    const size = (await file.stat()).size
    if (size > limit) throw new Error("bb.error.imageSnapshot.unavailable")
    const data = Buffer.alloc(size + 1)
    let length = 0
    while (length < data.length) {
      const read = await file.read(data, length, data.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length !== size) throw new Error("bb.error.imageSnapshot.unavailable")
    return data.subarray(0, length)
  } finally { await file.close() }
}

async function immutableWrite(path: string, data: string | Buffer) {
  await writeFile(path, data, { flag: "wx" }).catch(error => {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return
    throw error
  })
}
