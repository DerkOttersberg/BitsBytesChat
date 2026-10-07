import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { readState, stateRecord } from "./bitsbytes-state"

test("optional state accepts valid content and preserves invalid bytes verbatim", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bb-state-test-"))
  try {
    expect(await readState(folder, "missing.json", {}, stateRecord)).toEqual({})
    await writeFile(join(folder, "valid.json"), '{"chat":"ask"}')
    expect(await readState(folder, "valid.json", {}, stateRecord)).toEqual({ chat: "ask" })
    for (const [index, source] of ["{broken", "null", "[]", '"wrong"'].entries()) {
      const name = `broken-${index}.json`
      await writeFile(join(folder, name), source)
      expect(await readState(folder, name, { recovered: true }, stateRecord)).toEqual({ recovered: true })
      const backup = (await readdir(folder)).find(file => file.startsWith(name + ".recovery-"))!
      expect(await readFile(join(folder, backup), "utf8")).toBe(source)
      expect(await readFile(join(folder, name), "utf8")).toBe(source)
    }
  } finally {
    if (!resolve(folder).startsWith(join(resolve(tmpdir()), "bb-state-test-"))) throw new Error("Unexpected cleanup path")
    await rm(folder, { recursive: true, force: true })
  }
})
