import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BBArtifactRuntime } from "./bitsbytes-artifact-runtime"
import type { SpreadsheetGrid } from "../bitsbytes/types"

const integration = process.env.BB_ARTIFACT_PYTHON ? test : test.skip
const folders: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bb-grid-test-"))
  folders.push(root)
  const runtime = new BBArtifactRuntime(root, resolve("resources/bitsbytes"))
  if (process.env.BB_ARTIFACT_PYTHON) runtime.python = process.env.BB_ARTIFACT_PYTHON
  return { root, runtime }
}
afterEach(async () => {
  for (const root of folders.splice(0)) {
    if (!resolve(root).startsWith(join(resolve(tmpdir()), "bb-grid-test-"))) throw new Error("Unexpected cleanup path")
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

integration.each(["csv", "xlsx"])(
  "dense %s previews page through complete rows below the helper output boundary",
  async (format) => {
    const f = await fixture(),
      path = join(f.root, "Dense." + format)
    const rows = Array.from({ length: 80 }, (_, row) =>
      Array.from({ length: 100 }, (_, column) => `ROW ${row} COL ${column} ` + "é🌿".repeat(120) + " END"),
    )
    if (format === "csv") await writeFile(path, rows.map((row) => row.join(",")).join("\r\n"))
    else
      await f.runtime.call("create", {
        folder: f.root,
        spec: { filename: "Dense.xlsx", sheets: [{ name: "Dense", rows }] },
      })
    const before = await readFile(path)
    const actual: string[][] = []
    const offsets: number[] = []
    while (actual.length < rows.length) {
      const page = await f.runtime.call<SpreadsheetGrid>("grid", { path, offset: actual.length })
      expect(page.offset).toBe(actual.length)
      expect(page.total).toBe(rows.length)
      expect(page.columns).toBe(100)
      expect(page.rows.length).toBeGreaterThan(0)
      expect(page.rows.length).toBeLessThan(rows.length)
      expect(page.shortened).toBe(false)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1500000)
      offsets.push(page.offset)
      actual.push(...page.rows)
    }
    expect(actual).toEqual(rows)
    expect(await readFile(path)).toEqual(before)
    for (const offset of offsets.reverse()) {
      const page = await f.runtime.call<SpreadsheetGrid>("grid", { path, offset })
      expect(page.rows).toEqual(rows.slice(offset, offset + page.rows.length))
    }
  },
  30000,
)

integration("long CSV cells are explicitly shortened without changing their saved bytes", async () => {
  const f = await fixture(),
    path = join(f.root, "Long.csv")
  const source = '"Before\n' + "🌿".repeat(3000) + '\nFINAL SOURCE",Short\r\nLast,End'
  await writeFile(path, source)
  const page = await f.runtime.call<SpreadsheetGrid>("grid", { path })
  expect(page.shortened).toBe(true)
  expect([...page.rows[0][0]]).toHaveLength(1025)
  expect(page.rows[0][0]).toBe(
    ("Before\n" + "🌿".repeat(3000) + "\nFINAL SOURCE").slice(0, 7) + "🌿".repeat(1017) + "…",
  )
  expect(page.rows[0][1]).toBe("Short")
  expect(page.rows[1]).toEqual(["Last", "End"])
  expect(await readFile(path, "utf8")).toBe(source)
  expect((await f.runtime.call<SpreadsheetGrid>("grid", { path, offset: 1 })).shortened).toBe(false)
})

integration("escaped XLSX values and formulas cannot overflow a single preview row", async () => {
  const f = await fixture(),
    path = join(f.root, "Escaped.xlsx")
  const formula = '="' + "\\".repeat(3000) + '"'
  await f.runtime.call("create", {
    folder: f.root,
    spec: {
      filename: "Escaped.xlsx",
      sheets: [{ name: "Escaped", rows: [Array.from({ length: 100 }, () => formula), ["Last", "End"]] }],
    },
  })
  const before = await readFile(path)
  const page = await f.runtime.call<SpreadsheetGrid>("grid", { path })
  expect(page.shortened).toBe(true)
  expect(page.formulas?.[0][0]).toBe(formula.slice(0, 1024) + "…")
  expect(page.rows[0][0]).toBe("")
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1500000)
  expect(page.rows[1].slice(0, 2)).toEqual(["Last", "End"])
  expect(await readFile(path)).toEqual(before)
})

integration("CSV fields beyond the parser default remain available as bounded previews", async () => {
  const f = await fixture(),
    path = join(f.root, "Transcript.csv")
  const source = '"' + "Saved transcript ".repeat(10000) + '\nFINAL PASSAGE",Other'
  await writeFile(path, source)
  const page = await f.runtime.call<SpreadsheetGrid>("grid", { path })
  expect(page.shortened).toBe(true)
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0][1]).toBe("Other")
  expect([...page.rows[0][0]]).toHaveLength(1025)
  expect(await readFile(path, "utf8")).toBe(source)
  const inspected = await f.runtime.call<{ text: string }>("inspect", { path })
  expect(inspected.text).toBe(source)
})
