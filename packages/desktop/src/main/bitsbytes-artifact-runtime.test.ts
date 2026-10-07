import { afterEach, expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BBArtifactRuntime } from "./bitsbytes-artifact-runtime"

const folders: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bb-artifact-runtime-test-"))
  folders.push(root)
  const runtime = new BBArtifactRuntime(root, resolve("resources/bitsbytes"))
  if (process.env.BB_ARTIFACT_PYTHON) runtime.python = process.env.BB_ARTIFACT_PYTHON
  return { root, runtime }
}

afterEach(async () => {
  for (const root of folders.splice(0)) {
    if (!resolve(root).startsWith(join(resolve(tmpdir()), "bb-artifact-runtime-test-"))) throw new Error("Unexpected cleanup path")
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test("a helper that cannot spawn removes its cancellation listener", async () => {
  const f = await fixture(), controller = new AbortController()
  f.runtime.python = join(f.root, "invalid.exe")
  await writeFile(f.runtime.python, "This is not an executable")
  await expect(f.runtime.script("print('unreachable')", f.root, controller.signal)).rejects.toThrow()
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
})

const integration = process.env.BB_ARTIFACT_PYTHON ? test : test.skip
integration("a cancelled script never starts or creates a script file", async () => {
  const f = await fixture(), controller = new AbortController()
  controller.abort()
  await expect(f.runtime.script("print('unreachable')", join(f.root, "output"), controller.signal)).rejects.toThrow("bb.error.interrupted")
  expect(await readdir(f.root)).toEqual([])
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
})

integration("large Unicode output and its final marker are retained in full", async () => {
  const f = await fixture()
  const result = await f.runtime.script("import sys\nsys.stdout.buffer.write(('é' * 600000 + '\\nFINAL MARKER').encode('utf-8'))", f.root)
  expect(result.output).toBe("é".repeat(600000) + "\nFINAL MARKER")
  expect(await readFile(result.script + ".log", "utf8")).toBe(result.output)
})

integration("final output is drained even when the parent exits before its inherited pipe closes", async () => {
  const f = await fixture()
  const child = "import sys, time; time.sleep(0.2); sys.stdout.write('FINAL CHILD OUTPUT')"
  const result = await f.runtime.script(`import subprocess, sys\nsubprocess.Popen([sys.executable, '-c', ${JSON.stringify(child)}], stdout=sys.stdout, stderr=sys.stderr)\nprint('PARENT OUTPUT')`, f.root)
  expect(result.output).toContain("PARENT OUTPUT")
  expect(result.output).toContain("FINAL CHILD OUTPUT")
})

integration("oversized output fails instead of reporting a truncated successful script", async () => {
  const f = await fixture()
  await expect(f.runtime.script("import sys\nsys.stdout.write('x' * 2200000)", f.root)).rejects.toThrow("bb.error.artifactOutputLimit")
  expect((await readdir(f.root)).some(name => name.endsWith(".log"))).toBe(false)
  expect((await f.runtime.script("print('ready again')", f.root)).output.trim()).toBe("ready again")
})

integration("Stop releases inherited output pipes after the helper starts a child", async () => {
  const f = await fixture(), controller = new AbortController(), marker = join(f.root, "child-started")
  const child = "import time; time.sleep(3)"
  const pending = f.runtime.script(`import pathlib, subprocess, sys\nsubprocess.Popen([sys.executable, '-c', ${JSON.stringify(child)}], stdout=sys.stdout, stderr=sys.stderr)\npathlib.Path(${JSON.stringify(marker)}).write_text('started')`, f.root, controller.signal)
  const started = Date.now()
  while (!(await readdir(f.root)).includes("child-started")) {
    if (Date.now() - started > 5000) throw new Error("Helper did not start")
    await Bun.sleep(20)
  }
  try {
    const stopped = Date.now()
    controller.abort()
    await expect(pending).rejects.toThrow("bb.error.interrupted")
    expect(Date.now() - stopped).toBeLessThan(1000)
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
    expect((await f.runtime.script("print('recovered')", f.root)).output.trim()).toBe("recovered")
  } finally {
    // The short-lived fixture child exits independently; cancellation only owns
    // the helper and its pipes, never an unrelated Office/user process.
    await Bun.sleep(Math.max(0, 3500 - (Date.now() - started)))
  }
})

integration("a failing helper retains the end of long diagnostics", async () => {
  const f = await fixture()
  await expect(f.runtime.script("import sys, time\nfor i in range(2000):\n sys.stderr.write('x' * 100)\n sys.stderr.flush()\n time.sleep(0.0002)\nsys.stderr.write('\\nFINAL DIAGNOSTIC')\nsys.exit(1)", f.root)).rejects.toThrow("FINAL DIAGNOSTIC")
})

integration("stopping an active script cleans up and permits the next script", async () => {
  const f = await fixture(), controller = new AbortController(), marker = join(f.root, "started")
  const pending = f.runtime.script(`import pathlib, time\npathlib.Path(${JSON.stringify(marker)}).write_text('started')\ntime.sleep(30)`, f.root, controller.signal)
  const started = Date.now()
  while (!(await readdir(f.root)).includes("started")) {
    if (Date.now() - started > 5000) throw new Error("Helper did not start")
    await Bun.sleep(20)
  }
  controller.abort()
  await expect(pending).rejects.toThrow("bb.error.interrupted")
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  expect((await f.runtime.script("print('recovered')", f.root)).output.trim()).toBe("recovered")
})
