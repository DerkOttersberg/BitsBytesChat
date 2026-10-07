import { test, expect } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { repairPythonHome } from "./bitsbytes-runtime"

async function fixture(version = "3.12") {
  const root = await mkdtemp(join(tmpdir(), "bitsbytes runtime "))
  const environment = join(root, "runtime/worker")
  const installed = join(root, "runtime/python/cpython-3.12.11-windows-x86_64-none")
  await mkdir(environment, { recursive: true })
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, "python.exe"), "test marker")
  const source = `home = ${join(root, "missing python")}\r\nimplementation = CPython\r\nversion_info = ${version}\r\ninclude-system-site-packages = false\r\n`
  await writeFile(join(environment, "pyvenv.cfg"), source)
  return { root, environment, installed, source }
}

test("repairs a missing compatible Python home and preserves packages and original config", async () => {
  const item = await fixture()
  await writeFile(join(item.environment, "retained-package.txt"), "keep")
  expect(await repairPythonHome(item.root, "worker")).toBe(true)
  expect(await readFile(join(item.environment, "pyvenv.cfg"), "utf8")).toContain(`home = ${item.installed}`)
  expect(await readFile(join(item.environment, "retained-package.txt"), "utf8")).toBe("keep")
  const saved = (await readdir(item.environment)).find(name => name.startsWith("pyvenv.cfg.recovery-"))!
  expect(await readFile(join(item.environment, saved), "utf8")).toBe(item.source)
  expect(await repairPythonHome(item.root, "worker")).toBe(false)
  expect((await readdir(item.environment)).filter(name => name.startsWith("pyvenv.cfg.recovery-")).length).toBe(1)
})

test("keeps an existing valid home even when a pinned interpreter is available", async () => {
  const item = await fixture()
  const source = item.source.replace(join(item.root, "missing python"), item.installed)
  await writeFile(join(item.environment, "pyvenv.cfg"), source)
  expect(await repairPythonHome(item.root, "worker")).toBe(false)
  expect(await readFile(join(item.environment, "pyvenv.cfg"), "utf8")).toBe(source)
})

test("never substitutes another Python minor version", async () => {
  const item = await fixture("3.14")
  expect(await repairPythonHome(item.root, "worker")).toBe(false)
  expect(await readFile(join(item.environment, "pyvenv.cfg"), "utf8")).toBe(item.source)
})

test("missing environments are left for component setup", async () => {
  const root = await mkdtemp(join(tmpdir(), "bitsbytes empty runtime "))
  expect(await repairPythonHome(root, "worker")).toBe(false)
})
