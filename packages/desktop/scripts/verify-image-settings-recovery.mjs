import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

// Render the actual settings component in an isolated headless browser. The
// bridge fixture returns a failed poll; it never sends a provider request.
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const require = createRequire(join(root, "packages/app/package.json"))
const { chromium } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const { build } = await import(pathToFileURL(require.resolve("vite")).href)
const { default: solid } = await import(pathToFileURL(require.resolve("vite-plugin-solid")).href)
const solidRoot = dirname(require.resolve("solid-js/package.json"))
const folder = join(root, ".tools/qa/image-settings", randomUUID())
await mkdir(folder, { recursive: true })
const source = JSON.stringify(join(root, "packages/desktop/src/renderer/bitsbytes/image-settings.tsx").replaceAll("\\", "/"))
await writeFile(join(folder, "fixture.tsx"), `
import { render } from "solid-js/web"
import { ImageGenerationSettings } from ${source}
const configuration = { configured: true, available: false, model: "fixture-image", models: ["fixture-image"], revision: 0 }
window.fixture = { calls: [], outcome: "error" }
window.api = { bitsbytes: {
  subscribe: () => () => {},
  async call(method, args) {
    window.fixture.calls.push({ method, args })
    if (method === "images.status") return { ...configuration }
    if (method === "images.verify") return { job_id: "local-verification", status: "preparing", capability: { ...configuration } }
    if (method === "images.job") {
      if (window.fixture.outcome === "error") throw new Error("bb.error.imageStorage")
      configuration.available = true
      return { job_id: "local-verification", status: "ready", capability: { ...configuration } }
    }
    if (method === "images.configure") {
      configuration.configured = !args.disconnect
      configuration.available = false
      return { ...configuration }
    }
    throw new Error("Unexpected local fixture call")
  }
} }
render(() => <ImageGenerationSettings />, document.querySelector("main"))
`)
await writeFile(join(folder, "index.html"), '<!doctype html><meta charset="utf-8"><main></main><script type="module" src="/fixture.tsx"></script>')
await build({ configFile: false, root: folder, publicDir: false, logLevel: "error", plugins: [solid()],
  resolve: { alias: [
    { find: /^solid-js$/, replacement: join(solidRoot, "dist/solid.js") },
    { find: /^solid-js\/web$/, replacement: join(solidRoot, "web/dist/web.js") },
    { find: /^solid-js\/store$/, replacement: join(solidRoot, "store/dist/store.js") },
  ] }, build: { outDir: join(folder, "dist"), emptyOutDir: false } })
const server = createServer(async (request, response) => {
  const path = request.url === "/" ? "index.html" : request.url.slice(1)
  if (!/^(?:index\.html|assets\/[a-zA-Z0-9_.-]+\.(?:js|css))$/.test(path)) { response.writeHead(404).end(); return }
  const body = await readFile(join(folder, "dist", path))
  response.writeHead(200, { "content-type": path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : "text/html" })
  response.end(body)
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const report = { checks: [], errors: [] }
const check = label => { report.checks.push(label); console.log("PASS", label) }
let browser
try {
  browser = await chromium.launch({ headless: true, channel: "msedge" })
  const page = await browser.newPage()
  page.on("pageerror", error => report.errors.push(error.message))
  page.setDefaultTimeout(10000)
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const save = page.getByRole("button", { name: "Save connection", exact: true })
  const verify = page.getByRole("button", { name: "Test and enable image generation", exact: true })
  const disconnect = page.getByRole("button", { name: "Disconnect image generation", exact: true })
  const input = page.locator('input[type="password"]')
  const failure = page.getByRole("alert")
  await verify.click()
  await failure.waitFor()
  await save.click()
  await page.waitForFunction(() => !document.querySelector('input[type="password"]').disabled)
  assert.equal(await verify.isEnabled(), true)
  assert.equal(await disconnect.isEnabled(), true)
  assert.equal(await failure.count(), 0)
  check("A failed verification poll releases its job state so saving the connection leaves all configured controls usable")

  await verify.click()
  await failure.waitFor()
  await disconnect.click()
  await page.getByText("Image generation is not connected.", { exact: true }).waitFor()
  assert.equal(await input.isEnabled(), true)
  assert.equal(await verify.isDisabled(), true)
  await input.fill("fixture-only-key")
  await save.click()
  await page.getByText("Connection saved. Run the image test to enable generation.", { exact: true }).waitFor()
  assert.equal(await input.inputValue(), "")
  assert.equal(await verify.isEnabled(), true)
  check("Disconnect and reconnect remain usable after polling fails, and the entered credential is cleared after saving")

  await page.evaluate(() => { window.fixture.outcome = "ready" })
  await verify.click()
  await page.getByText("Image generation is verified and available.", { exact: true }).waitFor()
  assert.equal(await input.isEnabled(), true)
  assert.equal(await save.isEnabled(), true)
  assert.equal(await disconnect.isEnabled(), true)
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call.method === "images.job").length), 3)
  assert.deepEqual(report.errors, [])
  check("A later successful verification clears its pending state and restores normal controls")
} catch (error) {
  report.failure = String(error.stack ?? error)
  console.error(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
  await mkdir(join(root, ".tools/qa/results"), { recursive: true })
  await writeFile(join(root, ".tools/qa/results/image-settings-recovery.json"), JSON.stringify(report, null, 2))
}
