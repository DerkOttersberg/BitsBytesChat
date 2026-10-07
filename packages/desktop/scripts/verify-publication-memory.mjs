import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

if(!process.env.BB_PUBLICATION_MODULE||!process.env.BB_ARTIFACT_PYTHON)throw Error('Set BB_PUBLICATION_MODULE and BB_ARTIFACT_PYTHON for an isolated comparison')
const root=resolve('../..'),tag=process.env.BB_PUBLICATION_REPORT||'publication-memory'
const profile=join(root,'.tools/qa',tag+'-'+Date.now()),source=join(root,'.tools/qa/streaming-fixtures/memory-100000.csv')
await mkdir(profile,{recursive:true})
const {BBArtifacts}=await import(pathToFileURL(resolve(process.env.BB_PUBLICATION_MODULE)).href)
const artifacts=new BBArtifacts(profile,'',resolve('resources/bitsbytes'),()=>{})
artifacts.runtime.python=process.env.BB_ARTIFACT_PYTHON
try {
  await artifacts.start()
  const started=performance.now(),item=await artifacts.publish(source,'ses_memory')
  while(item.status==='queued'||item.status==='exporting'){
    if(performance.now()-started>10000)throw Error('Publication did not become ready')
    await new Promise(resolve=>setTimeout(resolve,20))
  }
  assert.equal(item.status,'ready')
  assert.match(item.hash,/^[a-f0-9]{64}$/)
  const report={node:process.version,elapsedMs:performance.now()-started,maxRSSKiB:process.resourceUsage().maxRSS,hash:item.hash}
  await writeFile(join(root,'.tools/qa/results',tag+'.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report))
}finally {
  if(!resolve(profile).startsWith(join(root,'.tools/qa')+sep))throw Error('Unexpected cleanup path')
  await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:50})
}
