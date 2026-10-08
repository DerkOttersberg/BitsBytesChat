import { captureHidden } from "./qa-capture.mjs"
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { constants, setPriority } from 'node:os'
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)

const root = resolve('../..')
const { _electron } = createRequire(join(root, '.tools/qa/package.json'))('playwright')
const version = JSON.parse(await readFile(join(root, 'packages/desktop/package.json'), 'utf8')).version
const profile = root + '/.tools/qa/followup-' + randomUUID()
const data = profile + '/BitsBytesChat'
const report = { checks: [], errors: [], requests: [], profile }
const requests = []
const firstSlow = { entered: false, active: true, release: Promise.withResolvers() }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const fixture = createServer(async (req, res) => {
  if (req.url === '/browser') { res.end('<html><title>QA browser</title><button id="example">Example</button></html>'); return }
  let body = ''; for await (const chunk of req) body += chunk
  const input = JSON.parse(body || '{}'); requests.push(input)
  const users = (input.messages ?? []).filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
  const latest = users.at(-1) ?? ''
  const hasTool = input.messages?.at(-1)?.role === 'tool'
  const named = suffix => input.tools?.find(tool => tool.function?.name.endsWith(suffix))?.function.name
  const calls = []
  let text = 'Completed this request.'
  if (latest.includes('slow-first') && !hasTool) {
    if (firstSlow.active) { firstSlow.active = false; firstSlow.entered = true; await firstSlow.release.promise }
    else await wait(6000)
  }
  if (latest.includes('markdown-preview') && !hasTool) calls.push({ name: named('create_artifact'), args: { job_id: 'qa-markdown', spec: { filename: 'QA-notes.md', text: '# QA document\n\nA fictional Markdown document created for preview testing.' } } })
  if (latest.includes('image-preview') && !hasTool) calls.push({ name: named('run_artifact_script'), args: { job_id: 'qa-image', code: "from PIL import Image\nImage.new('RGB', (640, 400), (30, 100, 180)).save('QA-image.png')\n", files: ['QA-image.png'] } })
  if (latest.includes('provider-failure')) { res.writeHead(400, { 'content-type':'application/json' }); res.end(JSON.stringify({error:{message:'Synthetic QA provider unavailable',type:'invalid_request_error'}})); return }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = delta => res.write('data: ' + JSON.stringify({ id: 'chatcmpl-' + randomUUID(), object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'qa-model', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
  emit({ role: 'assistant' })
  if (calls.length) emit({ tool_calls: calls.map((call, index) => ({ index, id: 'call_' + randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) })
  else emit({ content: text })
  res.end('data: ' + JSON.stringify({ id: 'end', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }) + '\n\ndata: [DONE]\n\n')
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const url = 'http://127.0.0.1:' + fixture.address().port
await mkdir(data + '/config/opencode', { recursive: true })
await symlink(process.env.LOCALAPPDATA + '/BitsBytesChat/runtime', data + '/runtime', 'junction')
await writeFile(data + '/config/opencode/opencode.json', JSON.stringify({ provider: { 'bitsbytes-qa': { name: 'Local QA', npm: '@ai-sdk/openai-compatible', options: { baseURL: url + '/v1', apiKey: 'fixture-only' }, models: { 'qa-model': { name: 'QA model', limit: { context: 128000, output: 8192 }, variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } } } } } }, model: 'bitsbytes-qa/qa-model' }))
const app = await _electron.launch({ executablePath: process.env.BB_QA_EXECUTABLE || join(root, `packages/desktop/dist/${version}/win-unpacked/BitsBytesChat.exe`), ...(process.env.BB_QA_MAIN ? { args: [process.env.BB_QA_MAIN] } : {}), env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", BB_QA_CAPTURE: "1", LOCALAPPDATA: profile }, timeout: 90000 })
await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide() })
let page, call, engine
const sessions = []
try {
  page = await app.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', error => report.errors.push(error.message))
  await page.evaluate(()=>{ window.__qaArtifacts=[]; window.api.bitsbytes.subscribe(event=>{if(event.type==='artifact')window.__qaArtifacts.push({published:event.published,name:event.artifact.filename,turn:event.artifact.turnID})}) })
  await page.locator('.bb-nav').waitFor({ timeout: 90000 })
  await page.locator('[contenteditable=true]').first().waitFor({ timeout: 90000 })
  call = (method, args = {}) => page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
  const server = await page.evaluate(() => window.api.awaitInitialization())
  const headers = { 'content-type': 'application/json', 'x-opencode-directory': encodeURIComponent(join(data, 'workspace')) }
  if (server.password) headers.authorization = 'Basic ' + Buffer.from(`${server.username ?? 'opencode'}:${server.password}`).toString('base64')
  engine = async (path, method = 'GET', body) => { const response = await fetch(server.url + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000) }); if (!response.ok) throw Error(path + ' ' + response.status + ' ' + (await response.text()).slice(0,500)); return response.status === 204 ? null : response.json() }
  const create = async title => { const session = await engine('/session', 'POST', { title }); sessions.push(session.id); return session }
  const open = async session => { await page.evaluate(detail => window.dispatchEvent(new CustomEvent('bitsbytes:session', { detail })), { directory: join(data, 'workspace'), sessionID: session.id }); await page.locator(`.bb-workspace-chat[data-bb-chat="${session.id}"] [contenteditable=true]`).first().waitFor(); await wait(200) }
  const submit = async (session, text, delivery = 'queue') => call('runs.admit', { delivery, prompt: { sessionID: session.id, directory: join(data, 'workspace'), id: 'msg_' + ((BigInt(Date.now()) * 4096n) & 0xffffffffffffn).toString(16).padStart(12,'0') + randomUUID().replaceAll('-','').slice(0,14), text, agent: 'build', model: { providerID: 'bitsbytes-qa', modelID: 'qa-model' }, legacyParts: [{ type: 'text', text }] } })
  const idle = async session => { for (let i=0; i<150; i++) { const run = await call('runs.get', { sessionID: session.id }); const status = await engine('/api/session/active'); if (run.last && !run.queue.length && !status.data[session.id] && !run.awaiting) return; await wait(300) } throw Error('Session did not finish: ' + session.id) }

  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const chat = await create('QA document and image approvals')
  await open(chat)
  const main = page.locator('.bb-workspace-chat'), editor = main.locator('[contenteditable=true]').first()
  await call('access.set', { sessionID:chat.id, mode:'ask' })
  for (const [marker, filename, selector] of [['markdown-preview','QA-notes.md','[data-component=file]'], ['image-preview','QA-image.png','.bb-artifact-image img']]) {
    await editor.fill(marker); await editor.press('Enter')
    await main.getByRole('button',{name:'Allow once',exact:true}).waitFor()
    await captureHidden(app, page, root+'/.tools/qa/results/followup-'+marker+'-approval.png')
    await main.getByRole('button',{name:'Allow once',exact:true}).click()
    await idle(chat)
    const item = (await call('artifacts.list')).find(item=>item.filename===filename && item.sessionID===chat.id)
    assert.ok(item, 'Published artifact missing: '+filename)
    await page.evaluate(detail=>window.dispatchEvent(new CustomEvent('bitsbytes:open-artifact',{detail})), {id:item.id})
    await page.locator('.bb-panel-content:visible').locator(selector).waitFor()
    if (filename.endsWith('.png')) await page.locator('.bb-panel-content:visible').locator(selector).evaluate(img=>img.decode())
    await captureHidden(app, page, root+'/.tools/qa/results/followup-'+marker+'.png')
    console.log('PASS approval and preview '+filename)
  }
  await editor.fill('provider-failure'); await editor.press('Enter'); await idle(chat)
  await editor.fill('Fresh message after the failed provider turn'); await editor.press('Enter'); await idle(chat)
  assert.equal((await call('runs.get',{sessionID:chat.id})).queue.length,0)
  console.log('PASS a fresh idle Send after provider failure needs no Steer')
  const goalChat = await create('QA prompt-based Goal'); await open(goalChat)
  await editor.fill('/goal'); await page.locator('[data-suggestion-id]').filter({hasText:'Goal'}).first().click()
  await main.locator('.bb-mode-chip').filter({hasText:'Goal'}).waitFor()
  assert.equal(await main.locator('input[type=number]').count(),0)
  await captureHidden(app,page,root+'/.tools/qa/results/followup-goal-composer.png')
  await editor.fill('Work until the fictional task is complete'); await editor.press('Enter'); await idle(goalChat)
  assert.equal((await call('runs.get',{sessionID:goalChat.id})).goal.minActiveDurationMs,0)
  assert.equal(await main.locator('.bb-goal-row').getByRole('button',{name:'Edit',exact:true}).count(),0)
  await page.evaluate(sessionID=>window.dispatchEvent(new CustomEvent('bitsbytes:run-panel',{detail:{kind:'goal',sessionID}})),goalChat.id)
  assert.equal(await page.getByRole('tab',{name:'Goal',exact:true}).count(),0)
  await call('runs.goal-clear',{sessionID:goalChat.id})
  const slow = await create('QA clean queue editing'); await open(slow)
  await editor.fill('slow-first'); await editor.press('Enter')
  for(let i=0;i<150 && !firstSlow.entered;i++) await wait(100)
  assert.ok(firstSlow.entered)
  await editor.fill('Queued fictional follow-up'); await editor.press('Enter')
  await main.locator('.bb-queue-row').filter({hasText:'Queued fictional follow-up'}).waitFor()
  await captureHidden(app,page,root+'/.tools/qa/results/followup-queue.png')
  await main.locator('.bb-queue-row').getByRole('button',{name:'Queued message actions'}).click()
  await page.getByRole('menuitem',{name:'Edit',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('.bb-workspace-chat [contenteditable=true]')?.textContent==='Queued fictional follow-up')
  assert.equal(await main.locator('.bb-queue-editing').count(),0)
  assert.equal(await main.getByRole('button',{name:'Cancel edit',exact:true}).count(),0)
  assert.equal(await main.locator('[data-component=durable-queue]').count(),0)
  await captureHidden(app,page,root+'/.tools/qa/results/followup-queue-edit.png')
  await editor.fill('Edited fictional follow-up'); await editor.press('Enter')
  firstSlow.release.resolve(); await idle(slow)
  assert.equal(requests.filter(input=>JSON.stringify(input.messages.filter(message=>message.role==='user').at(-1)?.content).includes('Edited fictional follow-up')).length,1)
  assert.deepEqual(errors,[])
  assert.ok(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(window=>!window.isVisible()&&!window.isFocused())))
  console.log('PASS prompt Goal, clean queue edit, no renderer errors, all windows hidden')
} catch(error) { console.error(error); if(page) await captureHidden(app,page,root+'/.tools/qa/results/followup-failure.png').catch(()=>{}); process.exitCode=1 }
finally { firstSlow.release.resolve(); await app.close(); fixture.closeAllConnections(); await new Promise(resolve=>fixture.close(resolve)) }





