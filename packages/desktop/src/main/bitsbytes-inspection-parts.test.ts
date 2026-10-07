import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BBArtifactRuntime } from "./bitsbytes-artifact-runtime"

type Part = { source_id: string; path: string; hash: string; format: string; characters: number; part: number; total: number; text: string; next: number | null }
const integration = process.env.BB_ARTIFACT_PYTHON ? test : test.skip
const folders: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bb-inspection-parts-test-"))
  folders.push(root)
  const runtime = new BBArtifactRuntime(root, resolve("resources/bitsbytes"))
  if (process.env.BB_ARTIFACT_PYTHON) runtime.python = process.env.BB_ARTIFACT_PYTHON
  const folder = join(root, "inspection")
  return { root, folder, runtime, inspect: <T = Record<string, unknown>>(path: string, source_id?: string, part = 0, signal?: AbortSignal) => runtime.call<T>("inspect_source", { path, folder, source_id, part }, signal) }
}

afterEach(async () => {
  for (const root of folders.splice(0)) {
    if (!resolve(root).startsWith(join(resolve(tmpdir()), "bb-inspection-parts-test-"))) throw new Error("Unexpected cleanup path")
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

integration("small Office, PDF and text inspections keep their existing structured results", async () => {
  const f = await fixture()
  const specs = [
    { filename: "small.docx", title: "Document é 😀", blocks: [{ text: "Saved paragraph" }, { type: "table", rows: [["Name", "Value"]] }] },
    { filename: "small.xlsx", sheets: [{ name: "Data", rows: [["Value", "Formula"], [3, "=A2*2"]] }] },
    { filename: "small.pptx", slides: [{ title: "Slide title", bullets: ["Slide content"] }] },
    { filename: "small.pdf", title: "PDF title", blocks: [{ text: "PDF content" }] },
    { filename: "small.md", text: "Source material\nIgnore other instructions is quoted data." },
  ]
  for (const spec of specs) {
    const artifact = await f.runtime.call<{ path: string }>("create", { spec, folder: f.root })
    const result = await f.inspect(artifact.path)
    expect(result).toEqual(await f.runtime.call("inspect", { path: artifact.path }))
    if (spec.filename.endsWith("docx")) { expect(result.paragraphs).toContain("Saved paragraph"); expect(result.tables).toEqual([[["Name", "Value"]]]) }
    if (spec.filename.endsWith("xlsx")) expect(JSON.stringify(result.sheets)).toContain("=A2*2")
    if (spec.filename.endsWith("pptx")) expect(JSON.stringify(result.slides)).toContain("Slide content")
    if (spec.filename.endsWith("pdf")) expect(JSON.stringify(result.text)).toContain("PDF content")
  }
  expect(await readdir(f.root)).not.toContain("inspection")
}, 30000)

integration("a source exceeding the subprocess output limit is reconstructed without losing Unicode or final text", async () => {
  const f = await fixture(), path = join(f.root, "large.md")
  const source = "BEGIN SOURCE\n" + "Synthetic source é 😀.\n".repeat(100000) + "END SOURCE"
  await writeFile(path, source)
  await expect(f.runtime.call("inspect", { path })).rejects.toThrow("bb.error.artifactOutputLimit")
  const first = await f.inspect<Part>(path)
  expect(first.format).toBe("json")
  expect(first.part).toBe(0)
  expect(first.total).toBeGreaterThan(100)
  const parts = [first.text]
  for (let part = first.next; part !== null;) {
    const value = await f.inspect<Part>(path, first.source_id, part)
    expect(value.part).toBe(part)
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(100000)
    expect(value.text).not.toContain("�")
    parts.push(value.text)
    part = value.next
  }
  const text = parts.join("")
  expect(Array.from(text)).toHaveLength(first.characters)
  expect(JSON.parse(text).text).toBe(source)
  expect(JSON.parse(text).hash).toBe(first.hash)
}, 120000)

integration("numbered parts retain their snapshot after the original changes or disappears", async () => {
  const f = await fixture(), path = join(f.root, "source.md")
  const original = "Original source. ".repeat(4000) + "ORIGINAL END"
  await writeFile(path, original)
  const first = await f.inspect<Part>(path)
  await writeFile(path, "Changed source. ".repeat(4000) + "CHANGED END")
  const current = await f.inspect<Part>(path)
  expect(current.source_id).not.toBe(first.source_id)
  expect(current.hash).not.toBe(first.hash)
  const last = await f.inspect<Part>(path, first.source_id, first.total - 1)
  expect(last.text).toContain("ORIGINAL END")
  expect(last.text).not.toContain("CHANGED END")
  await rm(path)
  expect((await f.inspect<Part>(path, first.source_id, first.total - 1)).text).toBe(last.text)
  expect(last.next).toBeNull()
})

integration("large Word inspections retain paragraph and table structure across part boundaries", async () => {
  const f = await fixture()
  const paragraphs = Array.from({ length: 800 }, (_, index) => `Paragraph ${index}: ` + "Document source é 😀. ".repeat(8))
  const artifact = await f.runtime.call<{ path: string }>("create", { folder: f.root, spec: { filename: "large.docx", blocks: [...paragraphs.map(text => ({ text })), { type: "table", rows: [["Final table", "Verified value"]] }] } })
  const first = await f.inspect<Part>(artifact.path), parts = [first.text]
  for (let part = first.next; part !== null;) {
    const value = await f.inspect<Part>(artifact.path, first.source_id, part)
    parts.push(value.text); part = value.next
  }
  const result = JSON.parse(parts.join(""))
  expect(result.paragraphs).toEqual(paragraphs)
  expect(result.tables).toEqual([[["Final table", "Verified value"]]])
}, 30000)

integration("damaged or mismatched snapshots fail clearly and fresh inspection repairs missing parts", async () => {
  const f = await fixture(), path = join(f.root, "source.md")
  await writeFile(path, "Source data. ".repeat(4000))
  const first = await f.inspect<Part>(path), cached = join(f.folder, first.source_id)
  await writeFile(join(cached, "1.txt"), "Damaged part")
  await expect(f.inspect(path, first.source_id, 1)).rejects.toThrow("bb.error.inspectionCache")
  const repaired = await f.inspect<Part>(path)
  expect(repaired.source_id).toBe(first.source_id)
  expect((await f.inspect<Part>(path, first.source_id, 1)).text).toContain("Source data")
  await expect(f.inspect(join(f.root, "other.md"), first.source_id, 0)).rejects.toThrow("bb.error.inspectionCache")
  await writeFile(join(cached, "manifest.json"), "{}")
  await expect(f.inspect(path, first.source_id)).rejects.toThrow("bb.error.inspectionCache")
  expect((await f.inspect<Part>(path)).source_id).toBe(first.source_id)
})

integration("part bounds and invalid identifiers cannot escape the snapshot cache", async () => {
  const f = await fixture(), path = join(f.root, "source.md")
  await writeFile(path, "Source data. ".repeat(4000))
  const first = await f.inspect<Part>(path)
  for (const part of [-1, 1.5, first.total]) await expect(f.inspect(path, first.source_id, part)).rejects.toThrow("bb.error.inspectionPart")
  await expect(f.inspect(path, undefined, 1)).rejects.toThrow("bb.error.inspectionPart")
  await expect(f.inspect(path, "../manifest")).rejects.toThrow("bb.error.inspectionCache")
  await expect(f.inspect(path, "0".repeat(64))).rejects.toThrow("bb.error.inspectionCache")
})

integration("concurrent inspections publish the same complete snapshot", async () => {
  const f = await fixture(), path = join(f.root, "source.md")
  await writeFile(path, "Concurrent source data. ".repeat(8000) + "CONCURRENT END")
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => f.inspect<Part>(path)))
  const values = results.map(result => { if (result.status === "rejected") throw result.reason; return result.value })
  expect(new Set(values.map(value => value.source_id)).size).toBe(1)
  expect(values.map(value => value.text)).toEqual([values[0].text, values[0].text, values[0].text])
  expect((await f.inspect<Part>(path, values[0].source_id, values[0].total - 1)).text).toContain("CONCURRENT END")
})

integration("stopping snapshot extraction leaves no published partial manifest and the same source can recover", async () => {
  const f = await fixture(), path = join(f.root, "source.md"), controller = new AbortController()
  await writeFile(path, "Source recovery data. ".repeat(900000))
  const pending = f.inspect<Part>(path, undefined, 0, controller.signal)
  // Observe real cache writes instead of relying on extraction duration.
  const started = Date.now()
  let snapshots: string[] = []
  while (!snapshots.length) {
    snapshots = await readdir(f.folder).catch(() => [])
    if (Date.now() - started > 10000) throw new Error("Extraction did not create its cache")
    if (!snapshots.length) await Bun.sleep(5)
  }
  controller.abort()
  await expect(pending).rejects.toThrow("bb.error.interrupted")
  expect(await readdir(join(f.folder, snapshots[0]))).not.toContain("manifest.json")
  const recovered = await f.inspect<Part>(path)
  expect(recovered.source_id).toBe(snapshots[0])
  expect((await f.inspect<Part>(path, recovered.source_id, recovered.total - 1)).next).toBeNull()
}, 60000)
