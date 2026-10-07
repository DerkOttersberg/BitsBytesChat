import { createRequire } from 'node:module'
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import assert from 'node:assert/strict'

const root=resolve('../..'),{_electron}=createRequire(join(root,'.tools/qa/package.json'))('playwright')
const profile=join(root,'.tools/qa/csv-preview-'+Date.now()),data=join(profile,'BitsBytesChat'),tag=process.env.BB_CSV_REPORT||'csv-preview'
const report={checks:[],errors:[]}
await mkdir(join(data,'config/opencode'),{recursive:true})
await symlink(join(process.env.LOCALAPPDATA,'BitsBytesChat/runtime'),join(data,'runtime'),'junction')
await writeFile(join(data,'config/opencode/opencode.json'),JSON.stringify({provider:{'bitsbytes-qa':{name:'Local QA',npm:'@ai-sdk/openai-compatible',options:{baseURL:'http://127.0.0.1:9/v1',apiKey:'fixture-only'},models:{'qa-model':{name:'QA model',limit:{context:128000,output:8192}}}}},model:'bitsbytes-qa/qa-model'}))
const wide=join(data,'Wide.csv'),paged=join(data,'Paged.csv')
await writeFile(wide,Array.from({length:5},(_,row)=>Array.from({length:125},(_,column)=>`Row ${row} column ${column}`).join(',')).join('\r\n'))
await writeFile(paged,Array.from({length:450},(_,row)=>`Row ${row},Value ${row}`).join('\r\n'))
let app,page
try {
  app=await _electron.launch({executablePath:process.env.BB_QA_EXECUTABLE||join(root,'packages/desktop/node_modules/electron/dist/electron.exe'),args:[process.env.BB_QA_MAIN||process.cwd()],env:{...process.env,BB_QA_ISOLATED:"1",LOCALAPPDATA:profile},timeout:90000})
  await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.hide()})
  page=await app.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',error=>report.errors.push(error.message))
  await page.locator('[contenteditable=true]').first().waitFor({timeout:90000})
  const server=await page.evaluate(()=>window.api.awaitInitialization()),headers={'content-type':'application/json','x-opencode-directory':encodeURIComponent(join(data,'workspace'))}
  if(server.password)headers.authorization='Basic '+Buffer.from((server.username??'opencode')+':'+server.password).toString('base64')
  const response=await fetch(server.url+'/session',{method:'POST',headers,body:JSON.stringify({title:'QA CSV preview'})});assert.ok(response.ok)
  const session=await response.json()
  await page.evaluate(detail=>window.dispatchEvent(new CustomEvent('bitsbytes:session',{detail})),{directory:join(data,'workspace'),sessionID:session.id})
  await page.locator(`.bb-workspace-chat[data-bb-chat="${session.id}"] [contenteditable=true]`).first().waitFor()
  const call=(method,args)=>page.evaluate(({method,args})=>window.api.bitsbytes.call(method,args),{method,args})
  await call('artifact.publish',{path:wide,sessionID:session.id})
  const panel=page.locator('.bb-panel-content:visible .bb-document-panel')
  await panel.locator('.bb-sheet-scroll td').filter({hasText:'Row 0 column 0'}).first().waitFor()
  assert.equal(await panel.locator('.bb-sheet-scroll tr').first().locator('td').count(),100)
  assert.ok((await panel.innerText()).includes('first 100 columns'))
  assert.ok(!(await panel.locator('.bb-sheet-scroll').innerText()).includes('column 124'))
  report.checks.push('Wide CSV preview shows 100 columns and the existing full-file notice')
  await call('artifact.publish',{path:paged,sessionID:session.id})
  await page.getByRole('tab',{name:'Paged.csv',exact:true}).click()
  await panel.locator('.bb-sheet-scroll tr').first().getByText('Row 0',{exact:true}).waitFor()
  assert.equal(await panel.locator('.bb-sheet-scroll tr').count(),200)
  report.pendingPage=await panel.getByRole('button',{name:'Next rows',exact:true}).evaluate(button=>{
    button.click();const row=button.closest('.bb-document-panel').querySelector('.bb-sheet-scroll tr')
    return {number:row.querySelector('th').textContent,text:row.querySelector('td').textContent,disabled:button.disabled}
  })
  if(process.env.BB_CSV_PENDING_CHECK==='1'){
    assert.equal(Number(report.pendingPage.number),Number(report.pendingPage.text.split(' ')[1])+1)
    assert.equal(report.pendingPage.disabled,true)
    report.checks.push('Pending page reads keep row labels paired with displayed data and hold paging controls')
  }
  await panel.locator('.bb-sheet-scroll tr').first().getByText('Row 200',{exact:true}).waitFor()
  assert.equal(await panel.locator('.bb-sheet-scroll th').first().innerText(),'201')
  await panel.getByRole('button',{name:'Next rows',exact:true}).click()
  await panel.locator('.bb-sheet-scroll tr').first().getByText('Row 400',{exact:true}).waitFor()
  assert.equal(await panel.locator('.bb-sheet-scroll tr').count(),50)
  assert.ok(await panel.getByRole('button',{name:'Next rows',exact:true}).isDisabled())
  await panel.getByRole('button',{name:'Previous rows',exact:true}).click()
  await panel.locator('.bb-sheet-scroll tr').first().getByText('Row 200',{exact:true}).waitFor()
  report.checks.push('CSV paging retains exact row values/numbers, final short page and previous navigation')
  if(process.env.BB_CSV_PENDING_CHECK==='1'){
    const artifact=(await call('artifacts.list',{})).find(item=>item.filename==='Paged.csv')
    assert.ok(resolve(artifact.source).startsWith(resolve(data)+sep))
    await copyFile(artifact.source,artifact.source+'.qa-backup');await rm(artifact.source)
    await panel.getByRole('button',{name:'Next rows',exact:true}).click()
    await panel.getByRole('alert').waitFor();assert.ok(await panel.getByRole('button',{name:'Next rows',exact:true}).isEnabled())
    assert.equal(await panel.locator('.bb-sheet-scroll th').first().innerText(),'201')
    await copyFile(artifact.source+'.qa-backup',artifact.source)
    await panel.getByRole('button',{name:'Next rows',exact:true}).click()
    await panel.locator('.bb-sheet-scroll tr').first().getByText('Row 400',{exact:true}).waitFor()
    await panel.getByRole('alert').waitFor({state:'detached'})
    report.checks.push('A failed page read releases controls, retains consistent data and recovers after its source returns')
  }
  if(process.env.BB_CSV_BOUNDED_CHECK==='1'){
    const dense=join(data,'Dense.csv'),rows=Array.from({length:80},(_,row)=>Array.from({length:100},(_,column)=>`ROW ${row} COL ${column} `+'é🌿'.repeat(120)+' END'))
    const source=rows.map(row=>row.join(',')).join('\r\n')
    await writeFile(dense,source)
    const artifact=await call('artifact.publish',{path:dense,sessionID:session.id})
    await page.getByRole('tab',{name:'Dense.csv',exact:true}).click()
    await panel.locator('.bb-sheet-scroll tr').first().getByText(rows[0][0],{exact:true}).waitFor()
    const offsets=[]
    let offset=0
    while(offset<rows.length){
      assert.equal(await panel.locator('.bb-sheet-scroll th').first().innerText(),String(offset+1))
      const count=await panel.locator('.bb-sheet-scroll tr').count()
      assert.ok(count>0&&count<rows.length)
      assert.equal(await panel.locator('.bb-sheet-scroll tr').first().locator('td').first().innerText(),rows[offset][0])
      assert.equal(await panel.locator('.bb-sheet-scroll tr').last().locator('td').first().innerText(),rows[offset+count-1][0])
      offsets.push(offset);offset+=count
      if(offset<rows.length){await panel.getByRole('button',{name:'Next rows',exact:true}).click();await panel.locator('.bb-sheet-scroll tr').first().getByText(rows[offset][0],{exact:true}).waitFor()}
    }
    assert.ok(await panel.getByRole('button',{name:'Next rows',exact:true}).isDisabled())
    for(const offset of offsets.reverse().slice(1)){await panel.getByRole('button',{name:'Previous rows',exact:true}).click();await panel.locator('.bb-sheet-scroll tr').first().getByText(rows[offset][0],{exact:true}).waitFor()}
    report.boundedPages=offsets.reverse()
    report.checks.push('Dense Unicode CSV uses bounded pages without skipped rows; Previous retraces actual visited pages')
    await panel.getByRole('button',{name:'Next rows',exact:true}).click()
    await panel.locator('.bb-sheet-scroll tr').first().getByText(rows[report.boundedPages[1]][0],{exact:true}).waitFor()
    await writeFile(dense,'"'+'Saved source 🌿 '.repeat(10000)+'\nFINAL SOURCE",Short\r\nLast,End')
    await call('artifact.publish',{path:dense,sessionID:session.id})
    await panel.getByText('Long values and formulas are shortened in this preview. Open or download the file to view the complete contents.',{exact:true}).waitFor()
    assert.equal(await panel.locator('.bb-sheet-scroll th').first().innerText(),'1')
    assert.equal(await panel.locator('.bb-sheet-scroll tr').first().locator('td').first().evaluate(td=>[...td.textContent].length),1025)
    assert.equal(await panel.locator('.bb-sheet-scroll tr').first().locator('td').last().innerText(),'Short')
    await panel.getByRole('combobox',{name:'Version history',exact:true}).selectOption('1')
    await panel.locator('.bb-sheet-scroll tr').first().getByText(rows[0][0],{exact:true}).waitFor()
    assert.equal(await panel.locator('.bb-sheet-scroll th').first().innerText(),'1')
    assert.equal(await panel.getByText('Long values and formulas are shortened in this preview. Open or download the file to view the complete contents.',{exact:true}).count(),0)
    assert.equal(await readFile(artifact.source,'utf8'),source)
    report.checks.push('Long-cell disclosure is explicit; changing saved revisions resets paging and preserves exact original bytes')
  }
  assert.equal(report.errors.length,0)
  await page.screenshot({path:join(root,'.tools/qa/results',tag+'.png')})
  console.log('PASS',report.checks.join('\nPASS '))
}catch(error){report.failure=String(error);console.error('FAIL',report.failure);if(page)await page.screenshot({path:join(root,'.tools/qa/results',tag+'-failure.png')});process.exitCode=1}
finally {await writeFile(join(root,'.tools/qa/results',tag+'.json'),JSON.stringify(report,null,2));if(app)await app.close()}
