import { createRequire } from "node:module"
import { createServer } from "node:http"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import assert from "node:assert/strict"
import { mobileCopy } from "../src/bitsbytes/mobile-copy.ts"

const root = resolve("../.."), require = createRequire(join(root, ".tools/qa/package.json"))
const { chromium } = require("playwright")
const pdf = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))
const folders = {
  before: process.env.BB_MOBILE_BEFORE || join(root, "packages/desktop/dist/0.3.2/win-unpacked/resources/bitsbytes/mobile"),
  after: process.env.BB_MOBILE_AFTER || join(root, "packages/desktop/resources/bitsbytes/mobile"),
}
let selected = "before"
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname
  try {
    if (request.method === "POST") {
      let source = ""; for await (const bytes of request) source += bytes
      const input = JSON.parse(source), overview = { chats: [], skills: [], models: [{ id: "qa-model", name: "QA model", provider: "Local fixture", providerID: "fixture", variants: [] }], model: "fixture/qa-model", engine: "parakeet" }
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(input.method === "overview" ? overview : {})); return
    }
    if (path === "/uploads") { response.end("[]"); return }
    const bytes = path === "/copy.js" ? Buffer.from("window.BB_COPY=" + JSON.stringify(mobileCopy))
      : await readFile(path === "/pdf.mjs" ? join(pdf, "build/pdf.mjs") : join(folders[selected], path === "/" ? "index.html" : path.slice(1)))
    response.setHeader("content-type", path === "/" ? "text/html" : path.endsWith("css") ? "text/css" : "text/javascript")
    response.setHeader("content-length", bytes.length)
    response.setHeader("cache-control", "no-store")
    response.end(bytes)
  } catch { response.writeHead(404).end() }
})
await new Promise(done => server.listen(0, "127.0.0.1", done))
const browser = await chromium.launch({ headless: true, channel: "msedge" }), samples = []
try {
  for (let i = 0; i < 6; i++) for (const build of ["before", "after"]) {
    selected = build
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    const started = performance.now()
    await page.goto("http://127.0.0.1:" + server.address().port)
    await page.locator("#app").waitFor({ state: "visible" })
    await page.waitForFunction(() => document.querySelector("#model")?.value !== "")
    const bootMs = performance.now() - started
    const resources = await page.evaluate(() => performance.getEntriesByType("resource").map(row => ({ path: new URL(row.name).pathname, bytes: row.decodedBodySize })))
    assert.deepEqual(errors, [])
    samples.push({ build, bootMs, resourceBytes: resources.reduce((sum, row) => sum + row.bytes, 0), resources })
    await context.close()
  }
  const summary = Object.fromEntries(["before", "after"].map(build => {
    const rows = samples.filter(row => row.build === build), times = rows.map(row => row.bootMs).sort((a, b) => a - b)
    return [build, { medianBootMs: (times[2] + times[3]) / 2, resourceBytes: rows[0].resourceBytes }]
  }))
  const report = { workload: "Interleaved cold 390px browser loads until the model overview is usable, local API fixture, six samples per build", summary, samples }
  await writeFile(join(root, ".tools/qa/results/" + (process.env.BB_MOBILE_PERFORMANCE_REPORT || "mobile-performance-033") + ".json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(summary))
} finally { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)) }
