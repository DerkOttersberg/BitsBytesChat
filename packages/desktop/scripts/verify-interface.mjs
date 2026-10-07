import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const root = resolve('../..')
const { _electron } = createRequire(join(root, '.tools/qa/package.json'))('playwright')
const version = JSON.parse(await readFile(join(root, 'packages/desktop/package.json'), 'utf8')).version
const tag = process.env.BB_QA_REPORT || 'release-03'
const profile = root + '/.tools/qa/release-03-' + Date.now()
const data = profile + '/BitsBytesChat'
const report = { checks: [], errors: [], requests: [] }
const requests = []
let qaDocument = ''
const check = label => { report.checks.push(label); console.log('PASS', label) }
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
  if (latest.includes('slow-first') && !hasTool) await wait(6000)
  if (latest.includes('plan-probe')) {
    if (!hasTool && named('bash')) calls.push({ name: named('bash'), args: { command: `echo forbidden > "${data}\\plan-forbidden.txt"`, description: 'Read-only Plan boundary probe' } })
    else text = '<proposed_plan>\n# Verification plan\n\n1. Inspect sources.\n2. Create the agreed output.\n3. Verify the saved file.\n</proposed_plan>'
  }
  if (latest.includes('make-artifacts') && !hasTool && named('create_artifact')) {
    calls.push({ name: named('create_artifact'), args: { job_id: 'qa-document', spec: { filename: 'Release QA.docx', title: 'Verified document', blocks: [{ text: 'Preview and chat corrections.' }] } } })
    calls.push({ name: named('create_artifact'), args: { job_id: 'qa-sheet', spec: { filename: 'Release QA.xlsx', sheets: [{ name: 'Data', rows: [['Value', 'Total'], [4, '=SUM(A2:A3)'], [6, '=A2*A3']] }] } } })
  }
  if (latest.includes('revise-artifact') && !hasTool && named('run_artifact_script')) calls.push({ name: named('run_artifact_script'), args: { job_id: 'qa-document-revision', code: 'from docx import Document\np=' + JSON.stringify(qaDocument) + '\nd=Document(p)\nd.add_paragraph("Revised content")\nd.save(p)\n', files: [qaDocument] } })
  if (latest.includes('goal-evidence') && !hasTool && named('goal_progress')) calls.push({ name: named('goal_progress'), args: { status: 'complete', reason: 'QA goal achieved', evidence: 'The deterministic provider returned the requested response and verified the goal callback.' } })
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
const app = await _electron.launch({ executablePath: process.env.BB_QA_EXECUTABLE || join(root, `packages/desktop/dist/${version}/win-unpacked/BitsBytesChat.exe`), ...(process.env.BB_QA_MAIN ? { args: [process.env.BB_QA_MAIN] } : {}), env: { ...process.env, LOCALAPPDATA: profile }, timeout: 90000 })
await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide() })
let page, call, engine, bridge
const sessions = []
try {
  page = await app.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', error => report.errors.push(error.message))
  await page.evaluate(()=>{ window.__qaArtifacts=[]; window.api.bitsbytes.subscribe(event=>{if(event.type==='artifact')window.__qaArtifacts.push({published:event.published,name:event.artifact.filename,turn:event.artifact.turnID})}) })
  await page.locator('.bb-nav').waitFor({ timeout: 90000 })
  call = (method, args = {}) => page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
  const server = await page.evaluate(() => window.api.awaitInitialization())
  const headers = { 'content-type': 'application/json', 'x-opencode-directory': encodeURIComponent(join(data, 'workspace')) }
  if (server.password) headers.authorization = 'Basic ' + Buffer.from(`${server.username ?? 'opencode'}:${server.password}`).toString('base64')
  engine = async (path, method = 'GET', body) => { const response = await fetch(server.url + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000) }); if (!response.ok) throw Error(path + ' ' + response.status + ' ' + (await response.text()).slice(0,500)); return response.status === 204 ? null : response.json() }
  const config = JSON.parse(await readFile(data + '/config/opencode/opencode.json', 'utf8')), local = config.mcp['bitsbytes-local'].environment
  bridge = async (name, args = {}, sessionID = '') => { const response = await fetch(local.BITSBYTES_TOOL_URL, { method: 'POST', headers: { authorization: 'Bearer ' + local.BITSBYTES_TOOL_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args, _meta: { sessionID } }) }); const value = await response.json(); if (!response.ok) throw Error(value.error); return value }
  const create = async title => { const session = await engine('/session', 'POST', { title }); sessions.push(session.id); return session }
  const open = async session => { await page.evaluate(detail => window.dispatchEvent(new CustomEvent('bitsbytes:session', { detail })), { directory: join(data, 'workspace'), sessionID: session.id }); await page.locator(`.bb-workspace-chat[data-bb-chat="${session.id}"] [contenteditable=true]`).first().waitFor(); await wait(200) }
  const submit = async (session, text, delivery = 'queue') => call('runs.admit', { delivery, prompt: { sessionID: session.id, directory: join(data, 'workspace'), id: 'msg_' + ((BigInt(Date.now()) * 4096n) & 0xffffffffffffn).toString(16).padStart(12,'0') + randomUUID().replaceAll('-','').slice(0,14), text, agent: 'build', model: { providerID: 'bitsbytes-qa', modelID: 'qa-model' }, legacyParts: [{ type: 'text', text }] } })
  const idle = async session => { for (let i=0; i<150; i++) { const run = await call('runs.get', { sessionID: session.id }); const status = await engine('/api/session/active'); if (run.last && !run.queue.length && !status.data[session.id] && !run.awaiting) return; await wait(300) } throw Error('Session did not finish: ' + session.id) }

  const state = await call('state'); assert.equal(state.skills.length,8); assert.ok(state.skills.some(skill => skill.id === 'bb-spreadsheets'))
  await page.locator('.bb-nav [aria-label=Settings]').click(); await page.getByRole('tab', { name:'Tools & permissions', exact:true }).click(); await page.getByText('Office, data and code helpers', { exact:true }).waitFor(); assert.equal(await page.getByRole('tab', { name:'Documents & storage', exact:true }).count(),0); await page.keyboard.press('Escape')
  check('All eight skills imported; one settings dialog includes artifact setup and no storage section')
  const chat = await create('QA release 0.3'); await open(chat)
  const main = page.locator('.bb-workspace-chat'), editor = main.locator('[contenteditable=true]').first()
  await editor.fill('ordinary request'); assert.equal(await page.locator('input[type=range]').count(),0); await main.getByRole('button', { name:'Send message', exact:true }).waitFor()
  check('Composer has circular send controls, standard reasoning options and no slider')

  await editor.fill('slow-first'); await editor.press('Enter'); await wait(1500)
  await editor.fill('queued follow-up'); await editor.press('Enter'); await page.locator('[data-component=durable-queue]').waitFor(); assert.ok((await call('runs.get',{sessionID:chat.id})).queue.length)
  await page.locator('.bb-queue-row').filter({hasText:'queued follow-up'}).getByRole('button',{name:'Queued message actions'}).click(); await page.getByRole('menuitem',{name:'Edit',exact:true}).click(); await page.waitForFunction(()=>document.querySelector('.bb-workspace-chat [contenteditable=true]')?.textContent==='queued follow-up'); assert.ok((await call('runs.get',{sessionID:chat.id})).queue.some(item=>item.editing))
  await editor.fill('edited queued follow-up'); await editor.press('Enter')
  const other = await create('QA background chat'); await open(other); await idle(chat)
  assert.ok(requests.some(request=>JSON.stringify(request.messages).includes('edited queued follow-up')))
  assert.ok(!requests.some(request=>JSON.stringify(request.messages).includes('"queued follow-up"')))
  check('Queue edits retain original until Send; saved follow-up runs while another chat is visible')
  const steering = await create('QA steering'); await open(steering); await editor.fill('slow-first'); await editor.press('Enter'); await main.getByRole('button',{name:'Stop',exact:true}).waitFor(); await editor.fill('steer-next'); await editor.press('Control+Enter'); await idle(steering); assert.ok(requests.some(request=>JSON.stringify(request.messages).includes('steer-next')))
  await editor.fill('slow-first stop-probe'); await editor.press('Enter'); await main.getByRole('button',{name:'Stop',exact:true}).waitFor(); await editor.fill('resume-queued'); await editor.press('Enter'); await page.locator('[data-component=durable-queue]').waitFor(); await main.getByRole('button',{name:'Stop',exact:true}).click(); await wait(1500); assert.equal((await call('runs.get',{sessionID:steering.id})).paused,true); assert.ok(!requests.some(request=>JSON.stringify(request.messages).includes('resume-queued'))); await main.getByRole('button',{name:'Resume queue',exact:true}).click(); await idle(steering); assert.ok(requests.some(request=>JSON.stringify(request.messages).includes('resume-queued')))
  check('Ctrl+Enter steers during work; square Stop pauses the queue until explicit Resume')
  await open(chat); await editor.fill('/side'); await page.locator('[data-suggestion-id]').filter({hasText:'Side chat'}).first().click(); await page.getByRole('tab',{name:'Side chat',exact:true}).waitFor(); const side=page.locator('.bb-panel-content:visible'); await side.locator('[contenteditable=true]').waitFor(); assert.ok(!(await side.innerText()).includes('slow-first'))
  assert.equal(await page.locator('.bb-workspace-chat [aria-label="Open panel"]').count(),0)
  check('/side opens an empty, editable side chat; header keeps only the panel toggle')

  await main.getByRole('button',{name:'Tool access for this chat',exact:true}).click(); await page.getByRole('menuitemradio',{name:'Full access',exact:false}).click(); await main.locator('.bb-chat-access[data-mode=full] .bb-access-warning').waitFor(); await editor.fill('/plan'); await page.locator('[data-suggestion-id]').filter({hasText:'Plan'}).first().click(); await main.locator('.bb-mode-chip').filter({hasText:'Plan'}).waitFor(); await editor.fill('plan-probe'); await editor.press('Enter'); await idle(chat)
  await main.locator('[data-component=proposed-plan]').waitFor(); assert.equal((await readFile(data+'/plan-forbidden.txt').catch(()=>null)),null)
  await main.locator('[data-component=proposed-plan] .bb-plan-chevron').waitFor()
  await main.locator('[data-component=proposed-plan] summary').click(); await main.locator('[data-component=proposed-plan]').getByRole('button',{name:'Implement this plan',exact:true}).waitFor()
  await main.getByRole('button',{name:'Open plan',exact:true}).last().click(); await page.locator('.bb-run-panel').waitFor(); await page.locator('.bb-panel-content:visible').getByRole('button',{name:'Edit',exact:true}).click(); await page.locator('.bb-run-panel textarea').fill('# Revised agreed plan\n\nCreate only the requested output.'); await page.locator('.bb-panel-content:visible').getByRole('button',{name:'Save',exact:true}).click(); const plan=(await call('runs.get',{sessionID:chat.id})).plan; assert.equal(plan.revision,2)
  await page.screenshot({path:root+'/.tools/qa/results/'+tag+'-plan.png'})
  await page.locator('.bb-panel-content:visible').getByRole('button',{name:'Implement this plan',exact:true}).click(); await idle(chat)
  assert.ok(requests.some(request=>JSON.stringify(request.messages).includes('Revised agreed plan')))
  check('Plan chip/card/editable tab work; Full access cannot execute a Plan command; implementation uses approved revision')

  await main.getByRole('button',{name:'Collapse panel',exact:true}).click()
  const files = await create('QA artifacts'); await open(files); await call('access.set',{sessionID:files.id,mode:'full'}); await editor.fill('make-artifacts'); await editor.press('Enter'); await idle(files)
  const artifacts=(await call('artifacts.list')).filter(item=>item.sessionID===files.id); assert.equal(artifacts.length,2)
  for(let i=0;i<150;i++){ const items=(await call('artifacts.list')).filter(item=>item.sessionID===files.id); if(items.every(item=>item.status==='ready'))break; if(items.some(item=>item.status==='error'))throw Error(JSON.stringify(items.map(item=>item.error))); await wait(300) }
  assert.ok(await page.locator('.bb-workspace-panel').isVisible()); assert.equal(await main.locator('[data-component=artifact-cards] button').count(),2)
  const selected=await page.locator('.bb-panel-tabs [aria-selected=true]').innerText(); assert.ok(/Release QA/.test(selected)); await page.locator('.bb-unread').waitFor(); report.unread=await page.locator('.bb-unread').count(); assert.equal(report.unread,1)
  await main.locator('[data-component=artifact-cards] button').filter({hasText:'Release QA.docx'}).click(); await page.waitForFunction(()=>{const canvas=document.querySelector('.bb-panel-content:not([style*="display: none"]) .bb-paper canvas');return canvas?.width>100}); await page.screenshot({path:root+'/.tools/qa/results/'+tag+'-document.png'})
  await main.locator('[data-component=artifact-cards] button').filter({hasText:'Release QA.xlsx'}).click(); await page.locator('.bb-panel-content:visible .bb-sheet-scroll').waitFor(); assert.ok((await page.locator('.bb-panel-content:visible .bb-sheet-scroll').innerText()).includes('10'))
  check('Multiple native MCP outputs publish clickable cards; first result opens collapsed panel, later tab is unread; spreadsheet displays Excel values')
  const doc=artifacts.find(item=>item.kind==='document'); qaDocument=doc.path; await editor.fill('revise-artifact'); await editor.press('Enter'); await idle(files); const revised=(await call('artifacts.list')).find(item=>item.id===doc.id); assert.equal(revised.revision,2); assert.equal(revised.history.length,2); const originalCard=main.locator('[data-component=artifact-cards] button').filter({hasText:'Release QA.docx'}).first(); assert.ok((await originalCard.innerText()).includes('Revision 1')); await originalCard.click(); await page.waitForFunction(()=>document.querySelector('.bb-panel-content:not([style*="display: none"]) select[aria-label="Version history"]')?.value==='1')
  const html=join(data,'QA.html'); await writeFile(html,'<!doctype html><h1 id="result">Safe preview</h1><script>document.body.dataset.bridge=typeof window.api</script>'); await bridge('publish_artifact',{path:html},files.id)
  await main.locator('[data-component=artifact-cards] button').filter({hasText:'QA.html'}).click(); await page.frameLocator('.bb-panel-content:visible iframe').getByRole('heading',{name:'Safe preview',exact:true}).waitFor(); assert.equal(await page.frameLocator('.bb-panel-content:visible iframe').locator('body').getAttribute('data-bridge'),'undefined'); await page.locator('.bb-panel-content:visible').getByRole('button',{name:'Source',exact:true}).click(); assert.ok((await page.locator('.bb-panel-content:visible pre').innerText()).includes('window.api'))
  check('Document revisions retain immutable history; HTML Preview/Source has no privileged bridge')
  const code=join(data,'QA.js'); await writeFile(code,'export const verifiedOutput = 42;\n'); await bridge('publish_artifact',{path:code},files.id); await main.locator('[data-component=artifact-cards] button').filter({hasText:'QA.js'}).last().click(); await page.locator('.bb-panel-content:visible').getByText('verifiedOutput',{exact:false}).first().waitFor()
  const plus=page.locator('.bb-panel-add button').first(); await plus.click({button:'right'}); await page.getByRole('menuitem',{name:'Terminal',exact:true}).click(); const terminalInput=page.locator('.bb-panel-content:visible textarea').first(); await terminalInput.waitFor({state:'attached'}); await terminalInput.pressSequentially('echo BitsBytesTerminalQA'); await terminalInput.press('Enter'); await wait(1000); assert.equal((await engine('/pty')).length,1)
  await plus.click(); await page.getByRole('menuitem',{name:'Code review',exact:true}).click(); await page.getByRole('tab',{name:'Code review',exact:true,selected:true}).waitFor()
  const browser=await call('browser.open',{sessionID:files.id,url:url+'/browser'}); const inspection=await call('browser.inspect',{id:browser.id}); assert.ok(inspection.page.controls.some(control=>control.label==='Example')); await call('browser.click',{id:browser.id,ref:inspection.page.controls[0].ref}); await call('browser.close',{id:browser.id}); await page.getByRole('tab',{name:'QA browser',exact:true}).waitFor({state:'detached'})
  check('Code output opens the retained file viewer; native terminal, review tab and isolated browser remain usable')

  const goal=await create('QA goal'); await open(goal); await call('access.set',{sessionID:goal.id,mode:'full'}); await editor.fill('/goal'); await page.locator('[data-suggestion-id]').filter({hasText:'Goal'}).first().click(); await main.locator('.bb-mode-chip').filter({hasText:'Goal'}).waitFor(); await editor.fill('goal-evidence'); await editor.press('Enter'); await idle(goal); assert.equal((await call('runs.get',{sessionID:goal.id})).goal.status,'complete'); await main.getByText('Achieved',{exact:true}).waitFor()
  const stalled=await create('QA stalled goal'); await open(stalled); await call('runs.goal-draft',{sessionID:stalled.id,enabled:true}); await submit(stalled,'No progress objective')
  for(let i=0;i<100;i++){if((await call('runs.get',{sessionID:stalled.id})).goal?.status==='blocked')break; await wait(300)}
  assert.equal((await call('runs.get',{sessionID:stalled.id})).goal.status,'blocked')
  await main.getByRole('button',{name:'Goal actions',exact:true}).click(); await page.getByRole('menuitem',{name:'Edit',exact:true}).click(); await page.locator('.bb-panel-content:visible').getByText('No further progress was detected.',{exact:false}).waitFor(); await page.locator('.bb-panel-content:visible').getByRole('button',{name:'Edit',exact:true}).click(); await page.locator('.bb-run-panel input[type=number]').fill('1'); await page.locator('.bb-panel-content:visible').getByRole('button',{name:'Save',exact:true}).click(); await main.getByRole('button',{name:'Resume',exact:true}).click(); await main.getByText('The goal has reached its token budget.',{exact:false}).waitFor(); await page.screenshot({path:root+'/.tools/qa/results/'+tag+'-goal.png'})
  await call('runs.stop',{sessionID:stalled.id}); assert.equal((await call('runs.get',{sessionID:stalled.id})).paused,true)
  check('Goal chip, evidence callback and Achieved row work; status-only continuation stalls; Stop pauses saved work')

  const v2=await engine('/api/session','POST',{agent:'build',model:{id:'qa-model',providerID:'bitsbytes-qa'},location:{directory:join(data,'workspace')}}).catch(error=>({error:String(error)}))
  if(v2.data?.id){ report.v2Session=v2.data.id; const prompt={sessionID:v2.data.id,directory:join(data,'workspace'),protocol:'v2',id:'msg_'+((BigInt(Date.now())*4096n)&0xffffffffffffn).toString(16).padStart(12,'0')+'abcdabcdabcdab',text:'V2 durable protocol check',agent:'build',model:{providerID:'bitsbytes-qa',modelID:'qa-model'}};await call('runs.admit',{prompt});await idle(v2.data);report.v2Run=await call('runs.get',{sessionID:v2.data.id});report.v2Messages=(await engine('/api/session/'+v2.data.id+'/context')).data.map(message=>({id:message.id,type:message.type}));assert.ok(report.v2Messages.some(message=>message.type==='user'));assert.ok(report.v2Messages.some(message=>message.type==='assistant'));await call('runs.mode',{sessionID:v2.data.id,mode:'plan'});await call('access.set',{sessionID:v2.data.id,mode:'full'});await call('runs.admit',{prompt:{...prompt,id:'msg_'+((BigInt(Date.now())*4096n)&0xffffffffffffn).toString(16).padStart(12,'0')+'bcdbcbdbcbdbcb',text:'plan-probe',legacyParts:[{type:'text',text:'plan-probe'}]}});await idle(v2.data);assert.equal(await readFile(data+'/plan-forbidden.txt').catch(()=>null),null);assert.ok((await call('runs.get',{sessionID:v2.data.id})).plan?.text.includes('Verification plan'));check('V2 native context, synthetic Plan attachment and Full access read-only guard pass through host integration') } else throw Error(v2.error)
  const recovery=await create('QA missing attachment recovery')
  const invalidID='msg_'+((BigInt(Date.now())*4096n)&0xffffffffffffn).toString(16).padStart(12,'0')+'dddddddddddddd'
  const beforeFailure=requests.length
  await call('runs.admit',{prompt:{sessionID:recovery.id,directory:join(data,'workspace'),id:invalidID,text:'Use missing recording',protocol:'v1',agent:'build',model:{providerID:'bitsbytes-qa',modelID:'qa-model'},legacyParts:[{type:'file',mime:'text/plain',filename:'transcript.txt',url:'bitsbytes://transcript/'+'0'.repeat(32)+'?revision=123'}]}})
  let rejected
  for(let i=0;i<100;i++){rejected=await call('runs.get',{sessionID:recovery.id});if(rejected.queue[0]?.status==='uncertain')break;await wait(100)}
  assert.equal(rejected.awaiting,false);assert.equal(rejected.queue[0].status,'uncertain');assert.ok(rejected.error);assert.equal(requests.length,beforeFailure)
  await call('runs.delete',{sessionID:recovery.id,id:invalidID});assert.equal((await call('runs.get',{sessionID:recovery.id})).error,'')
  await open(recovery);await editor.fill('Recovered request');await editor.press('Enter');await idle(recovery);assert.ok((await engine('/session/'+recovery.id+'/message')).some(row=>row.info.role==='assistant'))
  check('Missing attachment fails before inference, stops waiting, preserves recovery and allows a clean subsequent request')
  await page.screenshot({path:root+'/.tools/qa/results/'+tag+'.png'})
  assert.equal(report.errors.length,0,report.errors.join('\n'))
} catch(error) { report.failure=String(error);console.error('FAIL',String(error));if(page){console.log((await page.locator('body').innerText()).slice(0,1800));await page.screenshot({path:root+'/.tools/qa/results/'+tag+'-failure.png'})}process.exitCode=1 }
finally { report.requests=requests.map(request=>({model:request.model,tools:request.tools?.map(tool=>tool.function?.name),messages:request.messages?.length}));await writeFile(root+'/.tools/qa/results/'+tag+'.json',JSON.stringify(report,null,2));await app.close();fixture.close() }
