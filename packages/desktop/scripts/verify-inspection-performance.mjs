import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = resolve('../..')
const modules = process.env.BB_INSPECTION_BEFORE ? [
  { label: 'before', path: process.env.BB_INSPECTION_BEFORE },
  { label: 'after', path: process.env.BB_INSPECTION_MODULE || 'src/main/bitsbytes-engine.ts' },
] : [{ label: 'baseline', path: process.env.BB_INSPECTION_MODULE || 'src/main/bitsbytes-engine.ts' }]
for (const module of modules) module.inspect = (await import(pathToFileURL(resolve(module.path)).href)).inspectEngine
const source = 'Synthetic conversation data. '.repeat(1200)
const rows = Array.from({ length: 128 }, (_, index) => ({ id: 'msg_' + index, type: index % 2 ? 'assistant' : 'user', text: source, tokens: { input: 10, output: 5 } }))
const payloads = {
  v1: JSON.stringify(rows.map(row => ({ info: { id: row.id, role: row.type, tokens: row.tokens }, parts: [{ type: 'text', text: row.text }] }))),
  v2: JSON.stringify({ data: rows }),
}
const counts = { requests: 0, history: 0, bytes: 0 }
let busy = true, protocol = 'v1'
const fixture = createServer((request, response) => {
  counts.requests++
  const history = request.url.endsWith('/message') || request.url.endsWith('/context')
  if (history) counts.history++
  const text = history ? payloads[protocol] : request.url === '/session/status' ? JSON.stringify({ ses_perf: { type: busy ? 'busy' : 'idle' } }) : JSON.stringify({ data: busy ? { ses_perf: { type: 'running' } } : {} })
  counts.bytes += Buffer.byteLength(text)
  response.setHeader('content-type', 'application/json'); response.end(text)
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const server = { url: 'http://127.0.0.1:' + fixture.address().port, username: null, password: null }
const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2 }
const report = { node: process.version, workload: '128 synthetic messages; busy polling with history optional, followed by an idle full-history check', samples: [], summary: [] }
try {
  for (protocol of ['v1', 'v2']) {
    busy = true
    const prompt = { id: 'msg_probe', sessionID: 'ses_perf', directory: 'D:\\QA', text: 'Probe', protocol }
    for (const module of modules) {
      module.protocols = new Map()
      for (let index = 0; index < 3; index++) await module.inspect(server, prompt, module.protocols, { readBusyMessages: false })
    }
    for (let index = 0; index < 20; index++) {
      for (const module of index % 2 ? [...modules].reverse() : modules) {
        const before = { ...counts }, started = performance.now()
        const result = await module.inspect(server, prompt, module.protocols, { readBusyMessages: false })
        const elapsedMs = performance.now() - started
        assert.equal(result.busy, true)
        assert.ok(result.messages.length === 0 || result.messages.length === rows.length)
        report.samples.push({ protocol, label: module.label, elapsedMs, requests: counts.requests - before.requests, history: counts.history - before.history, bytes: counts.bytes - before.bytes })
      }
    }
    busy = false
    for (const module of modules) {
      const result = await module.inspect(server, prompt, module.protocols, { readBusyMessages: false })
      assert.equal(result.busy, false); assert.equal(result.messages.length, rows.length)
      assert.equal(result.messages.at(-1).text, source)
    }
    for (const module of modules) {
      const samples = report.samples.filter(sample => sample.protocol === protocol && sample.label === module.label)
      report.summary.push({ protocol, label: module.label, samples: samples.length, medianMs: median(samples.map(sample => sample.elapsedMs)), totalHistoryRequests: samples.reduce((sum, sample) => sum + sample.history, 0), responseBytes: samples.reduce((sum, sample) => sum + sample.bytes, 0) })
    }
  }
  await writeFile(join(root, '.tools/qa/results', (process.env.BB_INSPECTION_REPORT || 'inspection-performance') + '.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report.summary))
} finally {
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve))
}
