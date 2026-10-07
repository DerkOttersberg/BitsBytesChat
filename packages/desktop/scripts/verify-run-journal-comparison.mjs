import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const checkout = resolve('../..')
assert.ok(process.env.BB_RUNS_BEFORE && process.env.BB_RUNS_AFTER, 'Set both captured run-journal modules')
const execute = promisify(execFile)
const report = { workload: 'Six separate Node processes, serial alternating builds, 100 paused admissions each; exact saved source/restart checks', samples: [] }
for (let round = 0; round < 3; round++) {
  for (const build of ['before', 'after']) {
    const filename = `run-journal-${build}-${round}.json`
    await execute(process.execPath, ['scripts/verify-run-journal-performance.mjs'], { cwd: process.cwd(), env: { ...process.env, BB_RUNS_MODULE: process.env[build === 'before' ? 'BB_RUNS_BEFORE' : 'BB_RUNS_AFTER'], BB_JOURNAL_SAMPLES: '1', BB_JOURNAL_REPORT: filename }, timeout: 60000 })
    const result = JSON.parse(await readFile(join(checkout, '.tools/qa/results', filename), 'utf8'))
    report.samples.push({ round, build, ...result.samples[0] })
  }
}
report.medians = Object.fromEntries(['before', 'after'].map(build => {
  const values = report.samples.filter(sample => sample.build === build).map(sample => sample.milliseconds).sort((left, right) => left - right)
  return [build, values[1]]
}))
await writeFile(join(checkout, '.tools/qa/results/run-journal-comparison.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
