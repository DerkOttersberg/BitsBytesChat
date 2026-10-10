import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { extname, isAbsolute, join, relative, resolve } from "node:path"
import { BBArtifacts } from "../src/main/bitsbytes-artifacts"

// Exercise the real Save copy implementation against the UI run's snapshots.
// The native picker is suppressed in hidden QA; its selection is supplied here.
const root = resolve("../..")
const report = (await Bun.file(
  join(root, ".tools/qa/results", (process.env.BB_QA_REPORT || "image-chat-verified") + ".json"),
).json()) as { profile: string; failure?: string }
assert.equal(report.failure, undefined)
const profile = resolve(report.profile)
const within = relative(join(root, ".tools/qa"), profile)
assert.ok(
  !isAbsolute(within) && !within.startsWith("..") && within.startsWith("ic-"),
  "Only an owned image QA profile is allowed",
)
const data = join(profile, "BitsBytesChat")
const python = join(data, "runtime/artifacts/Scripts/python.exe")
const artifacts = new BBArtifacts(data, python, resolve("resources/bitsbytes"), () => {})
artifacts.runtime.python = python
await artifacts.start()
const copies = join(profile, "verified-downloads")
await mkdir(copies, { recursive: true })
const checks: string[] = []
for (const kind of ["document", "spreadsheet"]) {
  const artifact = artifacts.items.find((item) => item.kind === kind)!
  assert.ok(artifact)
  assert.equal(artifact.revision, 2)
  for (const revision of [1, 2]) {
    const target = join(copies, `${kind}-v${revision}${extname(artifact.filename)}`)
    const saved = await artifacts.saveCopy(artifact.id, target, revision)
    assert.equal(saved.verified, true)
    const selected = artifacts.version(artifact.id, revision)
    assert.ok((await readFile(target)).equals(await readFile(selected.source)))
    const contents = await artifacts.runtime.call<{
      paragraphs?: string[]
      sheets?: { name: string; sample: string[][] }[]
    }>("inspect", { path: target })
    if (kind === "document") {
      assert.deepEqual(contents.paragraphs, [
        revision === 2 ? "QA Notes Revised" : "QA Notes",
        "Clear messages",
        "Visible progress",
        "Safe approvals",
        ...(revision === 2 ? ["Reviewed locally"] : []),
      ])
    }
    if (kind === "spreadsheet") {
      assert.equal(contents.sheets?.[0].name, "Budget")
      assert.deepEqual(contents.sheets?.[0].sample, [
        ["Item", "Cost"],
        ["Paper", "12"],
        ["Pens", revision === 2 ? "10" : "8"],
        ["Total", "=SUM(B2:B3)"],
      ])
    }
    checks.push(`${kind} revision ${revision} saves a validated, byte-identical copy with the expected contents`)
  }
}
const result = { profile, checks, nativePicker: "not exercised in hidden QA", paidRequests: false }
await writeFile(join(root, ".tools/qa/results/artifact-downloads.json"), JSON.stringify(result, null, 2))
checks.forEach((check) => console.log("PASS", check))
