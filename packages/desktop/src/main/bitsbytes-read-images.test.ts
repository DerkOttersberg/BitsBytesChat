import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { BBReadImages } from "./bitsbytes-read-images"

const image = await readFile(new URL("../../icons/bitsbytes/64x64.png", import.meta.url))
const input = { sessionID: "ses_fixture", messageID: "msg_fixture", partID: "prt_fixture", attachmentIndex: 0, mime: "image/png", url: "data:image/png;base64," + image.toString("base64") }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bb-read-images-"))
  const calls = { decode: 0 }
  return {
    root, calls,
    service: new BBReadImages(root, async () => { calls.decode++; return { width: 64, height: 64 } }),
    cleanup: async () => {
      if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error("Unexpected test directory")
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("recorded previews retain exact immutable bytes across restart and duplicate opens", async () => {
  const f = await fixture()
  try {
    const first = await f.service.snapshot(input)
    const again = await f.service.snapshot(input)
    expect(again.id).toBe(first.id)
    expect(await readdir(join(f.root, "read-images"))).toHaveLength(2)
    const reopened = new BBReadImages(f.root)
    const saved = await reopened.read(first.id, input.sessionID)
    expect(Buffer.from(saved.data)).toEqual(image)
    expect({ width: saved.width, height: saved.height }).toEqual({ width: 64, height: 64 })
    const metadata = JSON.parse(await readFile(join(f.root, "read-images", first.id + ".json"), "utf8"))
    expect(metadata).toMatchObject({ sessionID: input.sessionID, messageID: input.messageID, partID: input.partID, attachmentIndex: 0 })
    expect(metadata.url).toBeUndefined()
    await expect(reopened.read(first.id, "ses_other")).rejects.toThrow("imageSnapshot.unavailable")
  } finally { await f.cleanup() }
})

test("damaged snapshot bytes fail integrity verification", async () => {
  const f = await fixture()
  try {
    const snapshot = await f.service.snapshot(input)
    const bytes = (await readdir(join(f.root, "read-images"))).find(path => path.endsWith(".image"))!
    await writeFile(join(f.root, "read-images", bytes), Buffer.from("changed"))
    await expect(f.service.read(snapshot.id, input.sessionID)).rejects.toThrow("imageSnapshot.unavailable")
  } finally { await f.cleanup() }
})

test("simultaneous preview opens finish their immutable write before any caller reads it", async () => {
  const f = await fixture()
  try {
    const ids = await Promise.all(Array.from({ length: 12 }, async () => {
      const snapshot = await f.service.snapshot(input)
      expect(Buffer.from((await f.service.read(snapshot.id, input.sessionID)).data)).toEqual(image)
      return snapshot.id
    }))
    expect(new Set(ids).size).toBe(1)
    expect(await readdir(join(f.root, "read-images"))).toHaveLength(2)
  } finally { await f.cleanup() }
})

test("tampering with recorded ownership or attachment provenance invalidates the snapshot", async () => {
  const f = await fixture()
  try {
    const snapshot = await f.service.snapshot(input)
    const path = join(f.root, "read-images", snapshot.id + ".json")
    const original = JSON.parse(await readFile(path, "utf8"))
    await writeFile(path, JSON.stringify({ ...original, sessionID: "ses_other" }))
    await expect(f.service.read(snapshot.id, "ses_other")).rejects.toThrow("imageSnapshot.unavailable")
    await writeFile(path, JSON.stringify({ ...original, attachmentIndex: original.attachmentIndex + 1 }))
    await expect(f.service.read(snapshot.id, input.sessionID)).rejects.toThrow("imageSnapshot.unavailable")
  } finally { await f.cleanup() }
})

test("unsafe references, malformed base64 and image bombs fail before decoding", async () => {
  const f = await fixture()
  try {
    for (const invalid of [
      { ...input, sessionID: "../../elsewhere" },
      { ...input, attachmentIndex: -1 },
      { ...input, url: "file:///current.png" },
      { ...input, mime: "image/svg+xml" },
      { ...input, url: input.url + "?" },
      { ...input, mime: "image/jpeg", url: input.url.replace("image/png", "image/jpeg") },
    ]) await expect(f.service.snapshot(invalid)).rejects.toThrow("imageSnapshot.invalid")
    const huge = Buffer.from(image)
    huge.writeUInt32BE(100_000, 16)
    huge.writeUInt32BE(100_000, 20)
    await expect(f.service.snapshot({ ...input, url: "data:image/png;base64," + huge.toString("base64") })).rejects.toThrow("imageSnapshot.invalid")
    expect(f.calls.decode).toBe(0)
  } finally { await f.cleanup() }
})
