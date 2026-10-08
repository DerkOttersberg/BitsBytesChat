import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import assert from "node:assert/strict"

if (!process.env.BB_QA_PROFILE) throw Error("Set BB_QA_PROFILE to an isolated fixture profile.")
const root = resolve("../.."), current = JSON.parse(await readFile("package.json", "utf8")).version
const builds = { before: process.env.BB_BEFORE_VERSION || "0.3.2", after: current }, rows = []
const release = process.env.BB_COMPARE_TAG || current.replaceAll(".", "")
for (let round = 0; round < 3; round++) {
  for (const label of round % 2 ? ["after", "before"] : ["before", "after"]) {
    const tag = `${release}-controlled-${round}-${label}`
    const executable = process.env[label === "before" ? "BB_BEFORE_EXECUTABLE" : "BB_AFTER_EXECUTABLE"]
      || join(root, `packages/desktop/dist/${builds[label]}/win-unpacked/BitsBytesChat.exe`)
    await promisify(execFile)(process.execPath, ["scripts/verify-composer-performance.mjs", tag, "--settled"], {
      cwd: process.cwd(), env: { ...process.env, BB_QA_EXECUTABLE: executable, BB_QA_MAIN: process.env[label === "before" ? "BB_BEFORE_MAIN" : "BB_AFTER_MAIN"] || "" }, timeout: 120000, windowsHide: true,
    })
    const report = JSON.parse(await readFile(join(root, ".tools/qa/results/composer-" + tag + ".json"), "utf8"))
    assert.equal(report.isolated, true)
    rows.push({ round, label, rendererVersion: builds[label], ...report })
    console.log("PASS", round, label, report.medianMs)
  }
}
const median = samples => { const sorted = [...samples].sort((a, b) => a - b), middle = sorted.length / 2; return (sorted[Math.floor(middle)] + sorted[Math.ceil(middle) - 1]) / 2 }
const report = { workload: process.env.BB_COMPARE_WORKLOAD || "Serial interleaved production launches, identical fixture profile, fonts ready, warm 55,000-character input; three runs and fifteen samples per build", builds, rows,
  summary: Object.fromEntries(Object.keys(builds).map(label => [label, { medianMs: median(rows.filter(row => row.label === label).flatMap(row => row.samplesMs)) }])) }
await writeFile(join(root, ".tools/qa/results/composer-controlled-" + release + ".json"), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report.summary))
