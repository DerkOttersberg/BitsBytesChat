import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const checkout = resolve('../..')
assert.ok(process.env.BB_RUNS_MODULE, 'Set BB_RUNS_MODULE to a captured run-journal module')
const modulePath = resolve(process.env.BB_RUNS_MODULE)
const { BBRuns } = await import(pathToFileURL(modulePath).href)
const report = { workload: '100 paused queue admissions, eight chats, 8192-character frozen prompts; no engine requests', module: modulePath, samples: [] }
const count = Number(process.env.BB_JOURNAL_SAMPLES || 3)
assert.ok(Number.isInteger(count) && count > 0 && count <= 10)
for (let sample = 0; sample < count; sample++) {
  const root = join(checkout, '.tools/qa/journal-' + randomUUID())
  await mkdir(root, { recursive: true })
  let notifications = 0, dispatched = 0
  const runs = new BBRuns(root, async () => ({ busy: false, messages: [] }), async () => { dispatched++ }, () => { notifications++ })
  try {
    await runs.start(); runs.close()
    const prompts = Array.from({ length: 100 }, (_, index) => ({ sessionID: 'ses_' + index % 8, directory: root, id: 'msg_' + index, text: String(index).padStart(4, '0') + 'x'.repeat(8188), files: [{ uri: 'bitsbytes://transcript/frozen-' + index + '?revision=2' }] }))
    for (const prompt of prompts) runs.get(prompt.sessionID).paused = true
    const start = performance.now()
    await Promise.all(prompts.map(prompt => runs.call('admit', { prompt })))
    const milliseconds = performance.now() - start
    const bytes = await readFile(join(root, 'chat-runs.json'))
    const saved = JSON.parse(bytes)
    for (const prompt of prompts) {
      const stored = saved[prompt.sessionID].queue.find(row => row.id === prompt.id)
      assert.equal(stored.prompt.text, prompt.text)
      assert.deepEqual(stored.prompt.files, prompt.files)
      assert.equal(stored.status, 'pending')
    }
    assert.equal(dispatched, 0)
    assert.equal(notifications, 100)
    const restarted = new BBRuns(root, async () => ({ busy: false, messages: [] }), async () => { dispatched++ }, () => {})
    await restarted.start(); restarted.close()
    assert.equal(Object.values(restarted.chats).reduce((count, chat) => count + chat.queue.length, 0), 100)
    assert.ok(Object.values(restarted.chats).every(chat => chat.paused))
    assert.equal(dispatched, 0)
    report.samples.push({ sample, milliseconds, journalBytes: bytes.length, notifications, dispatched })
  } finally {
    runs.close()
    const path = relative(join(checkout, '.tools/qa'), root)
    assert.ok(path && !path.startsWith('..') && !path.includes(':'), 'Cleanup must stay inside QA scratch space')
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
}
const ordered = report.samples.map(sample => sample.milliseconds).sort((left, right) => left - right)
report.medianMilliseconds = ordered[Math.floor(ordered.length / 2)]
await writeFile(join(checkout, '.tools/qa/results', process.env.BB_JOURNAL_REPORT || 'run-journal-before.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
