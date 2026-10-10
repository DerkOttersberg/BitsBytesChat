import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BBPluginSettings, pluginPackage } from "./bitsbytes-plugins"

const folders: string[] = []
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => {
      if (!folder.startsWith(join(tmpdir(), "bb-plugin-test-"))) throw Error("Unexpected test directory")
      return rm(folder, { recursive: true, force: true })
    }),
  )
})
async function fixture(config: unknown = {}) {
  const root = await mkdtemp(join(tmpdir(), "bb-plugin-test-"))
  folders.push(root)
  const path = join(root, "opencode.json"),
    disabled = join(root, "managed-plugins.json")
  await writeFile(path, JSON.stringify(config))
  return { root, path, disabled, service: new BBPluginSettings(path, disabled) }
}
test("plugin toggles preserve package options and unrelated configuration through restart", async () => {
  const config = {
    plugin: [["@fixture/tool@1.0.0", { flag: true }], "fixture-other"],
    permission: { edit: "ask" },
    mcp: { existing: { enabled: false } },
  }
  const f = await fixture(config)
  expect((await f.service.call("list", {})).plugins).toEqual([
    { package: "@fixture/tool@1.0.0", enabled: true },
    { package: "fixture-other", enabled: true },
  ])
  expect((await f.service.call("save", { package: "@fixture/tool@1.0.0", enabled: false })).restartRequired).toBe(true)
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ ...config, plugin: ["fixture-other"] })
  const restarted = new BBPluginSettings(f.path, f.disabled)
  expect((await restarted.call("list", {})).plugins[0]).toEqual({ package: "@fixture/tool@1.0.0", enabled: false })
  await restarted.call("save", { package: "@fixture/tool@1.0.0", enabled: true })
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(config)
  await restarted.call("remove", { package: "@fixture/tool@1.0.0" })
  expect((await new BBPluginSettings(f.path, f.disabled).call("list", {})).plugins).toEqual([
    { package: "fixture-other", enabled: true },
  ])
})
test("adding and removing a disabled local plugin never enables it in the engine", async () => {
  const f = await fixture()
  const pkg = "file:///D:/fixture/tool.mjs"
  await f.service.call("save", { package: pkg, enabled: false })
  expect(JSON.parse(await readFile(f.path, "utf8")).plugin).toEqual([])
  expect((await f.service.call("list", {})).plugins).toEqual([{ package: pkg, enabled: false }])
  await f.service.call("remove", { package: pkg })
  expect((await f.service.call("list", {})).plugins).toEqual([])
})
test("malformed plugin rows are kept and block a destructive rewrite", async () => {
  for (const config of [[], { plugin: "wrong" }, { plugin: ["valid", 42] }, { plugin: [["fixture", "wrong"]] }]) {
    const f = await fixture(config)
    const original = await readFile(f.path, "utf8")
    await expect(f.service.call("save", { package: "new-plugin", enabled: true })).rejects.toThrow(
      "bb.error.pluginConfig",
    )
    expect(await readFile(f.path, "utf8")).toBe(original)
  }
})
test("a configuration read failure leaves retained plugin records unchanged", async () => {
  const f = await fixture({ plugin: ["fixture"] })
  await f.service.call("save", { package: "fixture", enabled: true })
  const original = await readFile(f.disabled, "utf8")
  await rm(f.path)
  await mkdir(f.path)
  // A read failure must prevent changes to either storage file.
  await expect(f.service.call("save", { package: "fixture", enabled: false })).rejects.toThrow()
  expect(await readFile(f.disabled, "utf8")).toBe(original)
})
test("plugin packages reject commands and unsafe identifiers", () => {
  for (const pkg of ["fixture-plugin", "@scope/plugin@2.1.0", "file:///C:/QA/plugin.ts"])
    expect(pluginPackage(pkg)).toBe(pkg)
  for (const pkg of [
    "",
    "cmd /c echo bad",
    "fixture\nsecond",
    "https://example.com/remote.js",
    "file:///C:/QA/file.exe",
  ])
    expect(() => pluginPackage(pkg)).toThrow("bb.error.pluginPackage")
})
