import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
const root = resolve('../..')
const { _electron } = createRequire(join(root, '.tools/qa/package.json'))('playwright')
const version = JSON.parse(await readFile(join(root, 'packages/desktop/package.json'), 'utf8')).version
if (!process.env.BB_QA_PROFILE) throw Error('Set BB_QA_PROFILE to an isolated QA profile; never benchmark the user profile.')
const app = await _electron.launch({ executablePath: process.env.BB_QA_EXECUTABLE || join(root, `packages/desktop/dist/${version}/win-unpacked/BitsBytesChat.exe`), ...(process.env.BB_QA_MAIN ? { args: [process.env.BB_QA_MAIN] } : {}), env: { ...process.env, BB_QA_ISOLATED: "1", LOCALAPPDATA: process.env.BB_QA_PROFILE }, timeout: 90000 })
let clean
try {
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.webContents.setBackgroundThrottling(false); window.hide() } })
  const state = await page.evaluate(() => window.api.bitsbytes.call('state'))
  const server = await page.evaluate(() => window.api.awaitInitialization())
  // Engine initialization can finish before the renderer's navigation listener mounts.
  await page.locator('[contenteditable=true]').first().waitFor({ timeout: 90000 })
  const directory = join(state.root, 'workspace')
  const headers = { 'content-type': 'application/json', 'x-opencode-directory': encodeURIComponent(directory) }
  if (server.password) headers.authorization = 'Basic ' + Buffer.from(`${server.username ?? 'opencode'}:${server.password}`).toString('base64')
  const session = await fetch(server.url + '/session', { method: 'POST', headers, body: JSON.stringify({ title: 'QA benchmark — no AI request' }) }).then(r => r.json())
  clean = async () => { await page.evaluate(async()=>{const node=[...document.querySelectorAll('[data-titlebar-tab-title]')].find(n=>n.textContent?.startsWith('QA benchmark'));node?.closest('[data-titlebar-tab]')?.querySelector('[data-slot=tab-close] button')?.click();await new Promise(r=>setTimeout(r,100))});await fetch(server.url + '/session/' + session.id, { method: 'DELETE', headers }) }
  await page.evaluate(detail => window.dispatchEvent(new CustomEvent('bitsbytes:session', { detail })), { directory, sessionID: session.id })
  const editor = page.locator(`.bb-workspace-chat[data-bb-chat="${session.id}"] [contenteditable=true]`).first()
  await editor.waitFor({ timeout: 90000 })
  if (process.argv.includes('--settled')) {
    await page.evaluate(() => document.fonts.ready)
    await editor.fill('A recorded conversation. '.repeat(2200))
    await page.waitForTimeout(1500)
  }
  const timing = await editor.evaluate(async (node) => {
    const original = node.innerHTML
    const times = []
    for (let i = 0; i < 5; i++) {
      const start = performance.now()
      node.textContent = 'A recorded conversation. '.repeat(2200)
      node.dispatchEvent(new InputEvent('input', { bubbles: true }))
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      times.push(performance.now() - start)
    }
    node.innerHTML = original
    node.dispatchEvent(new InputEvent('input', { bubbles: true }))
    return times
  })
  const report = { settled: process.argv.includes('--settled'), isolated: Boolean(process.env.BB_QA_PROFILE), hiddenWithThrottlingDisabled: true, samplesMs: timing, medianMs: [...timing].sort((a,b) => a-b)[2], characters: 55000 }
  await writeFile(root + '/.tools/qa/results/composer-' + (process.argv[2] ?? 'before') + '.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await clean?.(); await app.close() }
