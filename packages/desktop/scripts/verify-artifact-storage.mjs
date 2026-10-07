import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

if (!process.env.BB_ARTIFACTS_MODULE || !process.env.BB_ARTIFACT_PYTHON)
  throw new Error("Select the compiled artifact module and QA Python")
const root = resolve("../.."),
  folder = join(root, ".tools/qa/artifact-storage-" + randomUUID()),
  temporary = join(folder, "artifacts.json.tmp"),
  stage = process.env.BB_ARTIFACT_SAVE_STAGE || "exporting",
  { BBArtifacts } = await import(pathToFileURL(resolve(process.env.BB_ARTIFACTS_MODULE)).href),
  events = [],
  artifacts = new BBArtifacts(folder, "", resolve("resources/bitsbytes"), (item) =>
    events.push({ id: item.id, status: item.status, error: item.error }),
  )
assert.ok(["exporting", "final"].includes(stage))
artifacts.runtime.python = process.env.BB_ARTIFACT_PYTHON
await artifacts.start()
const workbook = await artifacts.runtime.call("create", {
    folder,
    spec: {
      filename: "Storage recovery.xlsx",
      sheets: [
        {
          name: "Saved",
          rows: [
            ["Exact source 🌿", "Value"],
            ["Original", 42],
          ],
        },
      ],
    },
  }),
  originalBytes = await readFile(workbook.path),
  item = {
    id: "storage_saved",
    sessionID: "ses_storage",
    filename: "Storage recovery.xlsx",
    path: workbook.path,
    source: workbook.path,
    revision: 1,
    hash: "storage-fixture",
    kind: "spreadsheet",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    status: "queued",
    updated: 1,
    pdf: "",
    error: "",
    history: [{ revision: 1, source: workbook.path, pdf: "", hash: "storage-fixture", updated: 1 }],
  },
  original = JSON.stringify([item])
await writeFile(join(folder, "artifacts.json"), original)
if (stage === "exporting") await mkdir(temporary)
else {
  // Delegate to the actual Office helper, then fail only the final journal
  // checkpoint after its real PDF has been produced.
  const invoke = artifacts.runtime.call.bind(artifacts.runtime)
  let held = false
  artifacts.runtime.call = async (method, args, signal) => {
    const result = await invoke(method, args, signal)
    if (method === "render" && !held) {
      held = true
      await mkdir(temporary)
    }
    return result
  }
}
async function until(check, label) {
  const started = performance.now()
  while (!check()) {
    if (performance.now() - started > 45000) throw new Error("Timed out: " + label)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
await artifacts.start()
await until(() => events.some((event) => event.status === "error"), "visible storage error")
const failed = artifacts.items[0],
  savedFailure = JSON.parse(await readFile(join(folder, "artifacts.json"), "utf8"))[0],
  failureEvents = [...events]
assert.equal(failed.status, "error")
assert.ok(failed.error.includes("artifacts.json.tmp"))
assert.equal(savedFailure.revision, 1)
assert.equal(savedFailure.status, stage === "exporting" ? "queued" : "exporting")
assert.deepEqual(await readFile(workbook.path), originalBytes)
await rmdir(temporary)
events.length = 0
await artifacts.retry("storage_saved")
await until(() => events.some((event) => event.status === "ready"), "explicit preview retry")
const recovered = JSON.parse(await readFile(join(folder, "artifacts.json"), "utf8"))[0]
assert.equal(recovered.status, "ready")
assert.equal(recovered.revision, 1)
assert.equal(recovered.error, "")
assert.equal((await readFile(recovered.pdf)).subarray(0, 5).toString(), "%PDF-")
assert.deepEqual(await readFile(workbook.path), originalBytes)
const report = {
  stage,
  durableFailureStatus: savedFailure.status,
  failureEvents,
  checks: [
    "Background preview write failure is contained and shown without replacing the last durable snapshot",
    "Complete workbook source survives the failed save unchanged",
    "Explicit retry after storage repair releases the preview job and saves its real PDF without adding a revision",
  ],
  events,
}
await writeFile(
  join(root, ".tools/qa/results", process.env.BB_ARTIFACT_STORAGE_REPORT || "artifact-storage.json"),
  JSON.stringify(report, null, 2),
)
for (const check of report.checks) console.log("PASS", check)
