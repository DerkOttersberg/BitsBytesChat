import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BBArtifactRuntime } from "./bitsbytes-artifact-runtime"
import { fileHash } from "./bitsbytes-file-hash"

const integration = process.env.BB_ARTIFACT_PYTHON ? test : test.skip
const folders: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bb-streaming-test-"))
  folders.push(root)
  const runtime = new BBArtifactRuntime(root, resolve("resources/bitsbytes"))
  if (process.env.BB_ARTIFACT_PYTHON) runtime.python = process.env.BB_ARTIFACT_PYTHON
  return { root, runtime }
}
afterEach(async () => {
  for (const root of folders.splice(0)) {
    if (!resolve(root).startsWith(join(resolve(tmpdir()), "bb-streaming-test-"))) throw new Error("Unexpected cleanup path")
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test("streamed file hashes preserve arbitrary bytes across chunk boundaries and propagate missing files", async () => {
  const f = await fixture(), path = join(f.root, "bytes.bin")
  const bytes = Buffer.from(Array.from({ length: 1048707 }, (_, index) => index % 256))
  await writeFile(path, bytes)
  expect(await fileHash(path)).toBe(createHash("sha256").update(bytes).digest("hex"))
  await writeFile(path, Buffer.alloc(0))
  expect(await fileHash(path)).toBe(createHash("sha256").digest("hex"))
  await expect(fileHash(join(f.root, "missing.bin"))).rejects.toThrow()
})

integration("streamed validation retains BOM/Unicode hashes and rejects invalid UTF-8 at a read boundary", async () => {
  const f = await fixture(), path = join(f.root, "source.md")
  const text = "\ufeff" + "é😀\r\n".repeat(200000) + "FINAL SOURCE"
  await writeFile(path, text)
  const value = await f.runtime.call<{ size: number; hash: string }>("validate", { path })
  expect(value.size).toBe(Buffer.byteLength(text))
  expect(value.hash).toBe(await fileHash(path))
  await writeFile(path, Buffer.concat([Buffer.alloc(1048575, 97), Buffer.from([0xf0, 0x9f, 0x80])]))
  await expect(f.runtime.call("validate", { path })).rejects.toThrow("bb.error.invalidDocument")
})

integration("CSV pagination counts records, preserves quoted newlines and bounds columns", async () => {
  const f = await fixture(), path = join(f.root, "source.csv")
  const wide = Array.from({ length: 125 }, (_, index) => "column " + index)
  await writeFile(path, '\ufeff"First, quoted",Value\r\n"Line one\nLine two","é 😀"\r\n\r\n' + wide.join(',') + '\r\nLast,End\r\n')
  type Grid = { rows: string[][]; total: number; columns: number; offset: number }
  const page = await f.runtime.call<Grid>("grid", { path, offset: 1, limit: 3 })
  expect(page.rows).toEqual([["Line one\nLine two", "é 😀"], [], wide.slice(0, 100)])
  expect(page.total).toBe(5)
  expect(page.columns).toBe(125)
  expect(page.offset).toBe(1)
  const last = await f.runtime.call<Grid>("grid", { path, offset: 4, limit: 200 })
  expect(last.rows).toEqual([["Last", "End"]])
  expect(last.total).toBe(5)
  expect((await f.runtime.call<Grid>("grid", { path, offset: 100 })).rows).toEqual([])
  expect(await readFile(path, "utf8")).toContain("column 124")
})

integration("empty CSV grids have no phantom records or columns", async () => {
  const f = await fixture(), path = join(f.root, "empty.csv")
  await writeFile(path, "")
  expect(await f.runtime.call("grid", { path })).toMatchObject({ rows: [], total: 0, columns: 0, offset: 0 })
})
