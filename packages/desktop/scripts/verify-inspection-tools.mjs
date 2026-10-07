import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const root=resolve('../..'),{_electron}=createRequire(join(root,'.tools/qa/package.json'))('playwright')
const profile=join(root,'.tools/qa/inspection-tools-'+Date.now()),data=join(profile,'BitsBytesChat'),sourcePath=join(data,'Source.md')
const source='BEGIN SOURCE\n'+('Quoted source é 😀.\n').repeat(3000)+'END SOURCE'
const report={checks:[],errors:[],parts:[],modelRequests:0},parts=[]
const fixture=createServer(async(req,res)=>{
  try {
    let body='';for await(const chunk of req)body+=chunk
    const input=JSON.parse(body||'{}');report.modelRequests++
    const tool=input.tools?.find(tool=>tool.function?.name.endsWith('inspect_artifact'))?.function.name
    assert.ok(tool,'Inspection tool must reach the provider')
    const previous=input.messages?.at(-1)
    let args={path:sourcePath},text=''
    if(previous?.role==='tool'){
      const content=typeof previous.content==='string'?previous.content:previous.content.filter(row=>row.type==='text').map(row=>row.text).join('')
      let value=JSON.parse(content)
      if(value.content)value=JSON.parse(value.content.filter(row=>row.type==='text').map(row=>row.text).join(''))
      assert.equal(value.format,'json');assert.equal(value.part,parts.length)
      if(parts.length)assert.equal(value.source_id,report.sourceID)
      else {report.sourceID=value.source_id;await writeFile(sourcePath,'Changed during the tool conversation')}
      parts.push(value.text);report.parts.push({part:value.part,total:value.total,bytes:Buffer.byteLength(content)})
      if(value.next===null){assert.equal(JSON.parse(parts.join('')).text,source);text='Verified the complete saved source, including END SOURCE.'}
      else args={path:sourcePath,source_id:value.source_id,part:value.next}
    }
    res.writeHead(200,{'content-type':'text/event-stream'})
    const delta=text?{content:text}:{tool_calls:[{index:0,id:'call_'+randomUUID(),type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]}
    res.write('data: '+JSON.stringify({id:'qa-'+randomUUID(),object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]})+'\n\n')
    res.end('data: '+JSON.stringify({id:'end',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:text?'stop':'tool_calls'}],usage:{prompt_tokens:50,completion_tokens:20,total_tokens:70}})+'\n\ndata: [DONE]\n\n')
  }catch(error){report.errors.push(String(error));res.writeHead(500);res.end('Fixture assertion failed')}
})
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve))
await mkdir(join(data,'config/opencode'),{recursive:true});await writeFile(sourcePath,source)
await symlink(join(process.env.LOCALAPPDATA,'BitsBytesChat/runtime'),join(data,'runtime'),'junction')
await writeFile(join(data,'config/opencode/opencode.json'),JSON.stringify({provider:{'bitsbytes-qa':{name:'Local QA',npm:'@ai-sdk/openai-compatible',options:{baseURL:'http://127.0.0.1:'+fixture.address().port+'/v1',apiKey:'fixture-only'},models:{'qa-model':{name:'QA model',limit:{context:128000,output:8192}}}}},model:'bitsbytes-qa/qa-model'}))
let app
try {
  app=await _electron.launch({executablePath:process.env.BB_QA_EXECUTABLE||join(root,'packages/desktop/node_modules/electron/dist/electron.exe'),args:[process.env.BB_QA_MAIN||process.cwd()],env:{...process.env,BB_QA_ISOLATED:"1",LOCALAPPDATA:profile},timeout:90000})
  await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.hide()})
  const page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message))
  const server=await page.evaluate(()=>window.api.awaitInitialization())
  const headers={'content-type':'application/json','x-opencode-directory':encodeURIComponent(join(data,'workspace'))}
  if(server.password)headers.authorization='Basic '+Buffer.from((server.username??'opencode')+':'+server.password).toString('base64')
  const response=await fetch(server.url+'/session',{method:'POST',headers,body:JSON.stringify({title:'QA numbered document inspection'})});assert.ok(response.ok)
  const session=await response.json(),call=(method,args)=>page.evaluate(({method,args})=>window.api.bitsbytes.call(method,args),{method,args})
  await call('runs.admit',{prompt:{sessionID:session.id,directory:join(data,'workspace'),id:'msg_'+((BigInt(Date.now())*4096n)&0xffffffffffffn).toString(16).padStart(12,'0')+randomUUID().replaceAll('-','').slice(0,14),text:'Inspect the complete source in numbered parts.',protocol:'v1',agent:'build',model:{providerID:'bitsbytes-qa',modelID:'qa-model'}}})
  let rows=[]
  for(let index=0;index<180;index++){
    const response=await fetch(server.url+'/session/'+session.id+'/message',{headers,signal:AbortSignal.timeout(15000)})
    if(response.ok)rows=await response.json()
    if(rows.some(row=>row.info.role==='assistant'&&row.parts.some(part=>part.type==='text'&&part.text?.includes('Verified the complete saved source'))))break
    await new Promise(resolve=>setTimeout(resolve,250))
  }
  assert.ok(rows.some(row=>row.parts.some(part=>part.type==='text'&&part.text?.includes('Verified the complete saved source'))))
  assert.ok(report.parts.length>1);assert.equal(report.parts.length,report.parts[0].total)
  assert.ok(report.parts.every(part=>part.bytes<100000));assert.equal(report.errors.length,0)
  report.checks.push('Actual engine → MCP → host inspection reads every numbered source part under Ask access','Saved snapshot remains consistent while the original changes','Bounded tool responses reconstruct Unicode, beginning and final content')
  console.log('PASS',report.checks.join('\nPASS '))
}catch(error){report.failure=String(error);console.error('FAIL',report.failure);process.exitCode=1}
finally {await writeFile(join(root,'.tools/qa/results',process.env.BB_INSPECTION_TOOL_REPORT||'inspection-tools.json'),JSON.stringify(report,null,2));if(app)await app.close();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve))}
