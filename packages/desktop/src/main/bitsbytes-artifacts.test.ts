import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { BBArtifacts } from "./bitsbytes-artifacts"
import type { DocumentArtifact } from "../bitsbytes/types"

const folders: string[] = []
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "bb-artifacts-test-"))
  folders.push(folder)
  const events: { artifact: DocumentArtifact; focused?: boolean }[] = []
  const artifacts = new BBArtifacts(folder, "", resolve("resources/bitsbytes"), (artifact, focused) => events.push({ artifact, focused }))
  if (process.env.BB_ARTIFACT_PYTHON) artifacts.runtime.python = process.env.BB_ARTIFACT_PYTHON
  await artifacts.start()
  return { artifacts, folder, events }
}
afterEach(async () => {
  for (const folder of folders.splice(0)) {
    const path = resolve(folder)
    if (!path.startsWith(join(resolve(tmpdir()), "bb-artifacts-test-"))) throw new Error("Unexpected cleanup path")
    await rm(path, { recursive: true, force: true })
  }
})

test("malformed artifact registries are preserved without blocking startup", async () => {
  for (const source of ["{broken", "null", '[{"id":"incomplete"}]']) {
    const f = await fixture()
    await writeFile(join(f.folder, "artifacts.json"), source)
    await f.artifacts.start()
    expect(f.artifacts.items).toEqual([])
    const backup = (await readdir(f.folder)).find(name => name.startsWith("artifacts-recovery-"))!
    expect(await readFile(join(f.folder, backup), "utf8")).toBe(source)
  }
})

test("one malformed artifact does not discard the remaining document registry", async () => {
  const f = await fixture()
  const valid = { id: "saved", sessionID: "ses_saved", path: join(f.folder, "saved.html"), filename: "saved.html", hash: "saved-hash", revision: 1, updated: 1, kind: "html", status: "ready", pdf: "", error: "" }
  await writeFile(join(f.folder, "artifacts.json"), JSON.stringify([valid, null]))
  await f.artifacts.start()
  expect(f.artifacts.items.map(item => item.id)).toEqual(["saved"])
  expect((await readdir(f.folder)).some(name => name.startsWith("artifacts-recovery-"))).toBe(true)
})

const integration = process.env.BB_ARTIFACT_PYTHON ? test : test.skip
integration("saved copies retain the published revision and exact bytes", async () => {
  const f = await fixture(), path = join(f.folder, "source.html")
  const original = "<!doctype html>" + "Source é 😀. ".repeat(100000)
  await writeFile(path, original)
  const artifact = await f.artifacts.publish(path, "ses_test")
  await writeFile(path, "<!doctype html>Changed source")
  const target = join(f.folder, "copied.html")
  expect(await f.artifacts.saveCopy(artifact.id, target)).toEqual({ path: target, verified: true })
  expect(await readFile(target, "utf8")).toBe(original)
})

integration("text previews preserve the exact character limit, BOM and Unicode across read boundaries and revisions", async () => {
  const f = await fixture(), path = join(f.folder, "source.txt")
  const prefix = "\uFEFF" + "a".repeat(65531) + "🌿"
  const original = prefix + "é".repeat(8e6 - prefix.length)
  expect(Buffer.byteLength(original)).toBeGreaterThan(8e6)
  await writeFile(path, original)
  const artifact = await f.artifacts.publish(path, "ses_preview")
  await writeFile(path, "Small newer source 🌿")
  await f.artifacts.publish(path, "ses_preview")
  expect((await f.artifacts.content(artifact.id, { revision: 1 })).text).toBe(original)
  expect((await f.artifacts.content(artifact.id)).text).toBe("Small newer source 🌿")
  expect(await readFile(artifact.source!, "utf8")).toBe(original)
})

integration("over-limit Unicode previews fail without changing their saved source or preventing the next revision", async () => {
  const f = await fixture(), path = join(f.folder, "source.html")
  const original = "é".repeat(8e6) + "🌿"
  await writeFile(path, original)
  const artifact = await f.artifacts.publish(path, "ses_preview")
  await expect(f.artifacts.content(artifact.id)).rejects.toThrow("bb.error.fileTooLarge")
  expect(await readFile(artifact.source!, "utf8")).toBe(original)
  await writeFile(path, "<!doctype html><p>Ready again 🌿</p>")
  await f.artifacts.publish(path, "ses_preview")
  expect((await f.artifacts.content(artifact.id)).text).toBe("<!doctype html><p>Ready again 🌿</p>")
  await expect(f.artifacts.content(artifact.id, { revision: 1 })).rejects.toThrow("bb.error.fileTooLarge")
})

integration("simultaneous publications retain every immutable revision and focus only the first result", async () => {
  const f = await fixture()
  const paths = [join(f.folder, "first.html"), join(f.folder, "second.html")]
  await Promise.all(paths.map((path, index) => writeFile(path, `<!doctype html><title>Revision ${index + 1}</title><p>${index + 1}</p>`)))
  const results = await Promise.all(paths.map(path => f.artifacts.publish(path, "ses_test", "same-document", "msg_turn")))
  expect(results.map(item => item.revision)).toEqual([1, 2])
  expect(f.artifacts.items).toHaveLength(1)
  expect(f.artifacts.items[0].history?.map(version => version.revision)).toEqual([1, 2])
  const saved = JSON.parse(await readFile(join(f.folder, "artifacts.json"), "utf8"))
  expect(saved[0].status).toBe("ready")
  expect(saved[0].revision).toBe(2)
  expect((await f.artifacts.content(results[0].id, { revision: 1 })).text).toContain("Revision 1")
  expect((await f.artifacts.content(results[0].id, { revision: 2 })).text).toContain("Revision 2")
  expect(f.events.filter(event => event.focused).length).toBe(1)
  await expect(f.artifacts.content(results[0].id, { revision: 99 })).rejects.toThrow("invalidDocument")
  await expect(f.artifacts.content(results[0].id, { revision: 0 })).rejects.toThrow("invalidDocument")
  await expect(f.artifacts.content(results[0].id, { revision: "bad" })).rejects.toThrow("invalidDocument")
  await f.artifacts.saveCopy(results[0].id, join(f.folder, "old.html"), 1)
  expect(await readFile(join(f.folder, "old.html"), "utf8")).toContain("Revision 1")
})

integration("a rejected file does not consume document focus or block later publications", async () => {
  const f = await fixture(), path = join(f.folder, "report.html")
  await expect(f.artifacts.publish(join(f.folder, "missing.html"), "ses_test", "report", "msg_turn")).rejects.toThrow()
  await writeFile(path, "<!doctype html><title>Verified</title><p>Saved</p>")
  const item = await f.artifacts.publish(path, "ses_test", "report", "msg_turn")
  expect(item.revision).toBe(1)
  expect(f.events.some(event => event.artifact.id === item.id && event.focused)).toBe(true)
})

integration("an earlier Word revision without a PDF recovers its own preview without changing the latest document", async () => {
  const f = await fixture()
  const first = await f.artifacts.runtime.call<{ path: string; hash: string }>("create", { folder: f.folder, spec: { filename: "first.docx", blocks: [{ text: "Original revision" }] } })
  const latest = await f.artifacts.runtime.call<{ path: string; hash: string }>("create", { folder: f.folder, spec: { filename: "latest.docx", blocks: [{ text: "Latest revision" }] } })
  const rendered = await f.artifacts.runtime.call<{ pdf: string }>("render", { path: latest.path, folder: join(f.folder, "previews/pdf") })
  await writeFile(join(f.folder, "artifacts.json"), JSON.stringify([{ id: "history", sessionID: "ses_test", path: latest.path,
    source: latest.path, filename: "latest.docx", hash: latest.hash, revision: 2, updated: 1, kind: "document", status: "ready", pdf: rendered.pdf, error: "",
    history: [{ revision: 1, source: first.path, hash: first.hash, pdf: "", updated: 1 }, { revision: 2, source: latest.path, hash: latest.hash, pdf: rendered.pdf, updated: 2 }] }]))
  await f.artifacts.start()
  const previews = await Promise.all([f.artifacts.read("history", 1), f.artifacts.read("history", 1)])
  expect(previews[0]?.subarray(0, 5)).toEqual(new Uint8Array(Buffer.from("%PDF-")))
  expect(previews[1]).toEqual(previews[0])
  expect(f.artifacts.items[0].revision).toBe(2)
  expect(f.artifacts.items[0].pdf).toBe(rendered.pdf)
  expect(f.artifacts.items[0].history?.[0].pdf).toBeTruthy()
  expect(f.artifacts.items[0].history?.[0].pdf).not.toBe(rendered.pdf)
  expect(await f.artifacts.previewPath("history", 1)).toBe(f.artifacts.items[0].history![0].pdf)
  expect(new Uint8Array(await readFile((await f.artifacts.previewPath("history", 1))!))).toEqual(previews[0]!)
  const oldContent = await f.artifacts.runtime.call("inspect", { path: f.artifacts.items[0].history![0].pdf })
  expect(JSON.stringify(oldContent)).toContain("Original revision")
  expect(JSON.stringify(oldContent)).not.toContain("Latest revision")
  const saved = JSON.parse(await readFile(join(f.folder, "artifacts.json"), "utf8"))
  expect(saved[0].history[0].pdf).toBeTruthy()
  const originalPreview = f.artifacts.items[0].history![0].pdf
  await rm(originalPreview, { force: true })
  await f.artifacts.retry("history", 1)
  expect((await f.artifacts.read("history", 1))?.subarray(0, 5)).toEqual(new Uint8Array(Buffer.from("%PDF-")))
  await writeFile(originalPreview, "%PDF-1.7 damaged cached preview")
  await f.artifacts.retry("history", 1)
  const recovered = await f.artifacts.runtime.call("inspect", { path: f.artifacts.items[0].history![0].pdf })
  expect(JSON.stringify(recovered)).toContain("Original revision")
  expect(JSON.stringify(recovered)).not.toContain("Latest revision")
  expect(f.artifacts.items[0].pdf).toBe(rendered.pdf)
}, 60000)
