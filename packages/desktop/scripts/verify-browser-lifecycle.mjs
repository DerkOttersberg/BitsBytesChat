import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve('../..')
const { _electron } = createRequire(join(root, '.tools/qa/package.json'))('playwright')
const version = JSON.parse(await readFile('package.json', 'utf8')).version
const profile = join(root, '.tools/qa/browser-lifecycle-' + Date.now())
const report = { checks: [], failures: [], errors: [], states: [] }
const fixture = createServer((request, response) => {
  if (request.url === '/failed') { request.socket.destroy(); return }
  if (request.url === '/stalled') return
  response.setHeader('content-type', 'text/html')
  response.end('<!doctype html><title>Browser lifecycle QA</title><button>Usable</button>')
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
await mkdir(profile, { recursive: true })
const url = 'http://127.0.0.1:' + fixture.address().port
let app
try {
  app = await _electron.launch({ executablePath: process.env.BB_QA_EXECUTABLE || join(root, `packages/desktop/dist/${version}/win-unpacked/BitsBytesChat.exe`), ...(process.env.BB_QA_MAIN ? { args: [process.env.BB_QA_MAIN] } : {}), env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", LOCALAPPDATA: profile }, timeout: 90000 })
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide() })
  const page = await app.firstWindow()
  page.on('pageerror', error => report.errors.push(error.message))
  await page.locator('.bb-nav').waitFor({ timeout: 90000 })
  await page.evaluate(() => { window.__qaBrowserEvents = []; window.api.bitsbytes.subscribe(event => { if (event.type === 'browser') window.__qaBrowserEvents.push({ id: event.id, closed: !!event.closed }) }) })
  const call = (method, args = {}) => page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
  const state = () => app.evaluate(({ BrowserWindow, webContents }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { listeners: window.listenerCount('closed'), views: window.contentView.children.length, contents: webContents.getAllWebContents().length }
  })
  const cleanup = async () => { for (const tab of await call('browser.list')) await call('browser.close', { id: tab.id }) }
  const check = async (name, action) => {
    let timer
    try { await Promise.race([action(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Browser lifecycle check timed out')), 20000) })]); report.checks.push(name); console.log('PASS', name) }
    catch (error) { report.failures.push({ name, error: String(error) }); console.log('FAIL', name, String(error)); process.exitCode = 1 }
    finally { clearTimeout(timer); await cleanup() }
  }
  const initial = await state(); report.states.push({ stage: 'initial', ...initial })
  await check('An omitted chat owner is rejected before creating a tab', async () => {
    await assert.rejects(call('browser.open', { url }), /bb.error.browserMissing/)
    assert.equal((await call('browser.list')).length, 0)
  })
  await check('Invalid URL does not create an orphan tab or native view', async () => {
    for (const url of ['file:///invalid.html', 'http://127.0.0.1:invalid']) await assert.rejects(call('browser.open', { sessionID: 'ses_browser_qa', url }), /bb.error.browserURL/)
    assert.equal((await call('browser.list')).length, 0)
    assert.equal((await state()).views, initial.views)
  })
  await check('Failed initial navigation releases the tab and native view', async () => {
    await assert.rejects(call('browser.open', { sessionID: 'ses_browser_qa', url: url + '/failed' }))
    assert.equal((await call('browser.list')).length, 0)
    assert.equal((await state()).views, initial.views)
  })
  await check('Stopping an initial load releases the failed tab', async () => {
    const pending = call('browser.open', { sessionID: 'ses_browser_qa', url: url + '/stalled' }).then(value => ({ value }), error => ({ error: String(error) }))
    let tab
    const started = Date.now()
    while (!tab) {
      tab = (await call('browser.list')).at(-1)
      if (Date.now() - started > 5000) throw Error('Loading browser tab did not appear')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await call('browser.stop', { id: tab.id })
    const result = await pending
    assert.ok(result.error)
    assert.equal((await call('browser.list')).length, 0)
    assert.equal((await state()).views, initial.views)
  })
  await check('Twenty open/close cycles return window listeners and native views to baseline', async () => {
    const before = await state()
    for (let index = 0; index < 20; index++) {
      const tab = await call('browser.open', { sessionID: 'ses_browser_qa', url })
      const inspected = await call('browser.inspect', { id: tab.id })
      assert.ok(inspected.page.controls.some(control => control.label === 'Usable'))
      await call('browser.close', { id: tab.id })
    }
    const after = await state(); report.states.push({ stage: 'before cycles', ...before }, { stage: 'after cycles', ...after })
    assert.equal(after.listeners, before.listeners)
    assert.equal(after.views, before.views)
    assert.equal((await call('browser.list')).length, 0)
    const started = Date.now()
    while ((await state()).contents !== before.contents) {
      if (Date.now() - started > 3000) throw Error('Closed native web contents were retained')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const events = await page.evaluate(() => window.__qaBrowserEvents)
    for (const event of events.filter(event => event.closed)) assert.ok(events.filter(row => row.id === event.id).at(-1).closed, 'Closed tab emitted a later active update')
  })
  await check('Closing a secondary QA window releases only its own browser tabs', async () => {
    const opened = app.waitForEvent('window')
    const windowID = await app.evaluate(async ({ BrowserWindow, app }) => {
      const window = new BrowserWindow({ show: false, webPreferences: { preload: app.getAppPath() + '/out/preload/index.js', sandbox: true, contextIsolation: true } })
      await window.loadURL('about:blank')
      return window.id
    })
    const secondary = await opened
    await secondary.waitForFunction(() => !!window.api?.bitsbytes, undefined, { timeout: 5000 })
    const primary = await call('browser.open', { sessionID: 'ses_primary_qa', url })
    await secondary.evaluate(url => window.api.bitsbytes.call('browser.open', { sessionID: 'ses_secondary_qa', url }), url)
    assert.equal((await call('browser.list')).length, 2)
    await app.evaluate(({ BrowserWindow }, id) => new Promise(resolve => { const window = BrowserWindow.fromId(id); window.once('closed', resolve); window.close() }), windowID)
    const tabs = await call('browser.list')
    assert.deepEqual(tabs.map(tab => tab.id), [primary.id])
    assert.ok((await call('browser.inspect', { id: primary.id })).page.controls.some(control => control.label === 'Usable'))
  })
  assert.deepEqual(report.errors, [])
} catch (error) {
  report.failures.push({ name: 'Harness', error: String(error) }); process.exitCode = 1
} finally {
  await writeFile(join(root, '.tools/qa/results', (process.env.BB_QA_REPORT || 'browser-lifecycle') + '.json'), JSON.stringify(report, null, 2))
  await app?.close()
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve))
}
