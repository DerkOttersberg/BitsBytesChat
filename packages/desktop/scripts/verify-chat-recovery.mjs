import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve('../..')
const { _electron } = createRequire(join(root, '.tools/qa/package.json'))('playwright')
const version = JSON.parse(await readFile('package.json', 'utf8')).version
const profile = join(root, '.tools/qa/chat-recovery-' + Date.now())
const data = join(profile, 'BitsBytesChat')
const report = { checks: [], errors: [] }
const item = id => ({ id, status: 'pending', delivery: 'queue', prompt: { id, sessionID: 'ses_recovery_qa', directory: join(data, 'workspace'), text: 'Saved source for ' + id, draft: { transcript: 'bitsbytes://transcript/fixture?revision=7' } } })
const source = JSON.stringify({ ses_recovery_qa: { sessionID: 'ses_recovery_qa', mode: 'plan', goalDraft: false, paused: false, error: '', queue: [item('msg_saved_first'), null, { ...item('msg_saved_second'), status: 'sending' }, { ...item('msg_mismatched'), prompt: { ...item('msg_mismatched').prompt, id: 'msg_wrong' } }], plan: { text: 'Damaged optional plan', versions: null }, goal: { objective: 'Damaged optional goal', status: 'unknown' } } })
await mkdir(data, { recursive: true })
await writeFile(join(data, 'chat-runs.json'), source)
let app
try {
  app = await _electron.launch({ executablePath: process.env.BB_QA_EXECUTABLE || join(root, `packages/desktop/dist/${version}/win-unpacked/BitsBytesChat.exe`), ...(process.env.BB_QA_MAIN ? { args: [process.env.BB_QA_MAIN] } : {}), env: { ...process.env, LOCALAPPDATA: profile }, timeout: 90000 })
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide() })
  const page = await app.firstWindow()
  page.on('pageerror', error => report.errors.push(error.message))
  await page.locator('.bb-nav').waitFor({ timeout: 90000 })
  const chat = await page.evaluate(() => window.api.bitsbytes.call('runs.get', { sessionID: 'ses_recovery_qa' }))
  assert.deepEqual(chat.queue.map(item => item.id), ['msg_saved_first', 'msg_saved_second'])
  assert.deepEqual(chat.queue.map(item => item.status), ['pending', 'uncertain'])
  assert.equal(chat.paused, true)
  assert.equal(chat.mode, 'plan')
  assert.equal(chat.queue[0].prompt.draft.transcript, 'bitsbytes://transcript/fixture?revision=7')
  assert.equal(chat.plan, undefined); assert.equal(chat.goal, undefined)
  report.checks.push('Application startup preserves neighbouring requests, frozen sources and Plan mode without dispatching damaged state')
  const backup = (await readdir(data)).find(name => name.startsWith('chat-runs-recovery-'))
  assert.ok(backup)
  assert.equal(await readFile(join(data, backup), 'utf8'), source)
  report.checks.push('Original damaged bytes remain recoverable')
  const saved = JSON.parse(await readFile(join(data, 'chat-runs.json'), 'utf8'))
  assert.deepEqual(saved.ses_recovery_qa.queue.map(item => item.id), ['msg_saved_first', 'msg_saved_second'])
  assert.equal(saved.ses_recovery_qa.paused, true)
  assert.equal((await page.evaluate(() => window.api.bitsbytes.call('state'))).account, '')
  assert.deepEqual(report.errors, [])
  report.checks.push('Repaired journal is durable and startup stays usable without provider credentials')
  for (const check of report.checks) console.log('PASS', check)
} catch (error) {
  report.failure = String(error); process.exitCode = 1; console.error(report.failure)
} finally {
  await writeFile(join(root, '.tools/qa/results', (process.env.BB_QA_REPORT || 'chat-recovery') + '.json'), JSON.stringify(report, null, 2))
  await app?.close()
}
