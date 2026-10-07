import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const root = resolve("../..")
if (!process.env.BB_ARTIFACT_RUNTIME_MODULE || !process.env.BB_ARTIFACT_PYTHON)
  throw new Error("Select the compiled runtime module and isolated QA Python")
const { BBArtifactRuntime } = await import(pathToFileURL(resolve(process.env.BB_ARTIFACT_RUNTIME_MODULE)).href)
const folder = await mkdtemp(join(root, ".tools/qa/artifact-stop-"))
const timeout = process.env.BB_ARTIFACT_STOP_TIMEOUT === "1",
  lifetime = timeout ? 190 : 3
const controller = new AbortController(),
  marker = join(folder, "child-started")
const runtime = new BBArtifactRuntime(folder, resolve("resources/bitsbytes"))
runtime.python = resolve(process.env.BB_ARTIFACT_PYTHON)
const report = { timeout, checks: [], errors: [] }
const started = performance.now()
const completion = { at: started + (lifetime + 6) * 1000 }
try {
  const child = `import time; time.sleep(${lifetime})`
  const pending = runtime.script(
    `import pathlib, subprocess, sys\nchild = subprocess.Popen([sys.executable, '-c', ${JSON.stringify(child)}], stdout=sys.stdout, stderr=sys.stderr)\npathlib.Path(${JSON.stringify(marker)}).write_text(str(child.pid))`,
    folder,
    timeout ? undefined : controller.signal,
  )
  for (let index = 0; index < 250 && !(await readFile(marker, "utf8").catch(() => "")); index++)
    await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(Number(await readFile(marker, "utf8")))
  completion.at = performance.now() + (lifetime + 1) * 1000
  const stopped = performance.now()
  if (!timeout) controller.abort()
  const failure = await pending.then(
    () => "unexpected success",
    (error) => String(error),
  )
  report.elapsedMs = performance.now() - started
  report.stopMs = performance.now() - stopped
  assert.ok(failure.includes(timeout ? "bb.error.previewTimeout" : "bb.error.interrupted"))
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
  if (process.env.BB_ARTIFACT_STOP_OBSERVE !== "1") {
    assert.ok(timeout ? report.elapsedMs < 182000 : report.stopMs < 1000)
    report.checks.push("Failure releases inherited output pipes without waiting for the independent child")
  }
  assert.equal((await runtime.script("print('recovered')", folder)).output.trim(), "recovered")
  report.checks.push("The next actual Python helper succeeds and cancellation listeners are released")
  console.log(JSON.stringify(report))
} catch (error) {
  report.failure = String(error)
  process.exitCode = 1
  console.error(error)
} finally {
  // This fixture child expires on its own; never terminate user/Office processes.
  while (performance.now() < completion.at)
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, completion.at - performance.now())))
  await mkdir(join(root, ".tools/qa/results"), { recursive: true })
  await writeFile(
    join(root, ".tools/qa/results", (process.env.BB_ARTIFACT_STOP_REPORT || "artifact-stop") + ".json"),
    JSON.stringify(report, null, 2),
  )
  if (!resolve(folder).startsWith(join(root, ".tools/qa/artifact-stop-"))) throw new Error("Unexpected cleanup path")
  await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}
