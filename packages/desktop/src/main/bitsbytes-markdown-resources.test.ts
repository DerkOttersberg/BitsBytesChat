import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { BBMarkdownResources, workingMarkdownResources } from "./bitsbytes-markdown-resources"
import { BBReadImages } from "./bitsbytes-read-images"

const original = await readFile(new URL("../../icons/bitsbytes/64x64.png", import.meta.url))
const changed = await readFile(new URL("../../icons/bitsbytes/32x32.png", import.meta.url))
const owner = { artifactID: "document_fixture", revision: 1, sessionID: "ses_fixture" }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bb-markdown-images-"))
  const directory = join(root, "document")
  await mkdir(join(directory, "assets"), { recursive: true })
  const calls = { decode: 0 }
  return {
    root, directory, calls,
    service: new BBMarkdownResources(root, new BBReadImages(root, async data => {
      calls.decode++
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
    })),
    snapshot: { ...owner, path: join(directory, "plan.md") },
    cleanup: async () => {
      if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error("Unexpected test directory")
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("relative Markdown images preserve exact revision bytes after file changes, deletion and restart", async () => {
  const f = await fixture()
  try {
    const path = join(f.directory, "assets/diagram one.png")
    await writeFile(path, original)
    const text = "# Plan\n\n![Diagram](assets/diagram%20one.png)\n\n![Same diagram][image]\n\n[image]: assets/diagram%20one.png\n"
    await f.service.snapshot({ ...f.snapshot, text })
    const first = await f.service.list(owner.artifactID, 1, owner.sessionID)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ href: "assets/diagram%20one.png", width: 64, height: 64, mime: "image/png" })
    expect(f.calls.decode).toBe(1)
    await writeFile(path, changed)
    await f.service.snapshot({ ...f.snapshot, revision: 2, text: text + "\nUpdated plan." })
    await rm(path)
    const reopened = new BBMarkdownResources(f.root)
    expect(Buffer.from((await reopened.read(owner.artifactID, 1, owner.sessionID, first[0]!.href)).data)).toEqual(original)
    expect(Buffer.from((await reopened.read(owner.artifactID, 2, owner.sessionID, first[0]!.href)).data)).toEqual(changed)
    expect(await reopened.list(owner.artifactID, 3, owner.sessionID)).toEqual([])
    await expect(reopened.read(owner.artifactID, 1, "ses_other", first[0]!.href)).rejects.toThrow("imageSnapshot.unavailable")
    await expect(reopened.read(owner.artifactID, 1, owner.sessionID, "unrecorded.png")).rejects.toThrow("imageSnapshot.unavailable")
  } finally { await f.cleanup() }
})

test("Markdown images cannot escape the document folder through paths, schemes or directory links", async () => {
  const f = await fixture()
  try {
    const outside = join(f.root, "private")
    await mkdir(outside)
    await writeFile(join(outside, "secret.png"), original)
    await symlink(outside, join(f.directory, "linked"), process.platform === "win32" ? "junction" : "dir")
    const references = [
      "../private/secret.png", "%2e%2e/private/secret.png", "linked/secret.png",
      join(outside, "secret.png").replaceAll("\\", "/"),
      "file:///private/secret.png", "https://example.invalid/image.png", "//example.invalid/image.png",
      "data:image/png;base64," + original.toString("base64"),
      "assets/vector.svg", "C:%5cprivate%5csecret.png", "%5c%5cserver%5cprivate%5csecret.png",
    ]
    await f.service.snapshot({ ...f.snapshot, text: references.map(href => `![Blocked](${href})`).join("\n\n") })
    const list = await f.service.list(owner.artifactID, 1, owner.sessionID)
    expect(list.length).toBeGreaterThan(0)
    expect(list.every(resource => !resource.id)).toBe(true)
    expect(f.calls.decode).toBe(0)
    expect(await readdir(join(f.root, "read-images")).catch(() => [])).toEqual([])
    await expect(f.service.read(owner.artifactID, 1, owner.sessionID, references[0]!)).rejects.toThrow("imageSnapshot.unavailable")
  } finally { await f.cleanup() }
})

test("missing, malformed and oversized image resources leave usable Markdown with explicit placeholders", async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.directory, "malformed.png"), "This is not an image")
    await writeFile(join(f.directory, "oversized.png"), Buffer.alloc(4 * 1024 * 1024 + 1))
    await writeFile(join(f.directory, "valid.png"), original)
    await f.service.snapshot({ ...f.snapshot, text: "![Missing](missing.png)\n\n![Bad](malformed.png)\n\n![Big](oversized.png)\n\n![Ready](valid.png)" })
    const list = await f.service.list(owner.artifactID, 1, owner.sessionID)
    expect(list.map(resource => !!resource.id)).toEqual([false, false, false, true])
    expect(f.calls.decode).toBe(1)
    expect(Buffer.from((await f.service.read(owner.artifactID, 1, owner.sessionID, "valid.png")).data)).toEqual(original)
  } finally { await f.cleanup() }
})

test("Markdown resource snapshots bound total image bytes and reference count", async () => {
  const f = await fixture()
  try {
    const bytes = Buffer.concat([original, Buffer.alloc(4 * 1024 * 1024 - original.length)])
    for (let index = 0; index < 5; index++) await writeFile(join(f.directory, `large${index}.png`), bytes)
    await f.service.snapshot({ ...f.snapshot, text: Array.from({ length: 5 }, (_, index) => `![Image](large${index}.png)`).join("\n\n") })
    expect((await f.service.list(owner.artifactID, 1, owner.sessionID)).map(resource => !!resource.id)).toEqual([true, true, true, true, false])
    expect(f.calls.decode).toBe(4)
    await f.service.snapshot({ ...f.snapshot, revision: 2, text: Array.from({ length: 2000 }, (_, index) => `![Missing](image${index}.png)`).join("\n\n") })
    const bounded = await f.service.list(owner.artifactID, 2, owner.sessionID)
    expect(bounded).toHaveLength(17)
    expect(bounded.at(-1)).toEqual({ href: "" })
    await f.service.snapshot({ ...f.snapshot, revision: 3, text: `![Long](${"a".repeat(8000)}.png)` })
    expect(await f.service.list(owner.artifactID, 3, owner.sessionID)).toEqual([{ href: "" }])
    await f.service.snapshot({ ...f.snapshot, revision: 4, text: "x".repeat(500_001) })
    expect(await f.service.list(owner.artifactID, 4, owner.sessionID)).toEqual([])
  } finally { await f.cleanup() }
})

test("damaged or oversized resource manifests never become filesystem reads", async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.directory, "image.png"), original)
    await f.service.snapshot({ ...f.snapshot, text: "![Image](image.png)" })
    const folder = join(f.root, "previews/markdown-resources")
    const file = join(folder, (await readdir(folder))[0]!)
    const manifest = JSON.parse(await readFile(file, "utf8"))
    await writeFile(file, JSON.stringify({ ...manifest, sessionID: "ses_other" }))
    expect(await f.service.list(owner.artifactID, 1, owner.sessionID)).toEqual([])
    await writeFile(file, JSON.stringify({ ...manifest, resources: [{ href: "image.png", id: "../../private" }] }))
    expect(await f.service.list(owner.artifactID, 1, owner.sessionID)).toEqual([])
    await writeFile(file, "x".repeat(128_001))
    expect(await f.service.list(owner.artifactID, 1, owner.sessionID)).toEqual([])
    await writeFile(file, "null")
    expect(await f.service.list(owner.artifactID, 1, owner.sessionID)).toEqual([])
  } finally { await f.cleanup() }
})

test("working Markdown resolves relative resources from its authorized document folder and follows current bytes", async () => {
  const f = await fixture()
  try {
    const text = "![Diagram](assets/diagram.png)\n\n![Outside](../private.png)"
    await writeFile(f.snapshot.path, text)
    await writeFile(join(f.directory, "assets/diagram.png"), original)
    const decode = async (data: Buffer) => ({ width: data.readUInt32BE(16), height: data.readUInt32BE(20) })
    const input = { directory: f.root, path: "document/plan.md", text }
    const first = await workingMarkdownResources(input, decode)
    expect(first.path).toBe(f.snapshot.path)
    expect(Buffer.from(first.resources[0]!.data!)).toEqual(original)
    expect(first.resources[1]).toEqual({ href: "../private.png" })
    await writeFile(join(f.directory, "assets/diagram.png"), changed)
    const second = await workingMarkdownResources(input, decode)
    expect(Buffer.from(second.resources[0]!.data!)).toEqual(changed)
    expect(await readdir(join(f.root, "read-images")).catch(() => [])).toEqual([])
    expect(await readdir(join(f.root, "previews/markdown-resources")).catch(() => [])).toEqual([])
  } finally { await f.cleanup() }
})

test("working Markdown rejects outside document paths and directory-link escapes before decoding", async () => {
  const f = await fixture()
  try {
    const outside = join(f.root, "private")
    await mkdir(outside)
    await writeFile(join(outside, "secret.md"), "![Secret](secret.png)")
    await writeFile(join(outside, "secret.png"), original)
    await symlink(outside, join(f.directory, "linked"), process.platform === "win32" ? "junction" : "dir")
    const decode = async () => { throw new Error("A rejected file must never reach decoding") }
    for (const path of ["../private/secret.md", join(outside, "secret.md"), "linked/secret.md"])
      await expect(workingMarkdownResources({ directory: f.directory, path, text: "![Secret](secret.png)" }, decode)).rejects.toThrow("invalidDocument")
  } finally { await f.cleanup() }
})
