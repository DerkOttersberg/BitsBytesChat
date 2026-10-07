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
integration("simultaneous publications retain every immutable revision and focus only the first result", async () => {
  const f = await fixture()
  const paths = [join(f.folder, "first.html"), join(f.folder, "second.html")]
  await Promise.all(paths.map((path, index) => writeFile(path, `<!doctype html><title>Revision ${index + 1}</title><p>${index + 1}</p>`)))
  const results = await Promise.all(paths.map(path => f.artifacts.publish(path, "ses_test", "same-document", "msg_turn")))
  expect(results.map(item => item.revision)).toEqual([1, 2])
  expect(f.artifacts.items).toHaveLength(1)
  expect(f.artifacts.items[0].history?.map(version => version.revision)).toEqual([1, 2])
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
