import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

// Render the actual settings component in an isolated headless browser. The
// bridge fixture exercises ordered autosaves; it never sends a provider request.
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
const extensions = JSON.stringify(join(root, "packages/desktop/src/renderer/bitsbytes/extensions-settings.tsx").replaceAll("\\", "/"))
await writeFile(join(folder, "fixture.tsx"), `
import { render } from "solid-js/web"
import { ImageGenerationSettings } from ${source}
import { ExtensionsSettings } from ${extensions}
const configuration = { provider: "openrouter", enabled: true, configured: true, available: true, model: "fixture-image", models: ["fixture-image", "fixture-second"], revision: 0 }
const mcp = { name: "QA MCP", status: "disabled", config: { type: "remote", url: "https://example.com/mcp", headers: { "X-Fixture": "nested" }, enabled: false } }
const plugin = { package: "qa-plugin", enabled: false }
const skill = { id: "qa-skill", name: "QA skill", enabled: false, instructions: "Read the source.", defaultPrompt: "", template: "", output: "", revision: 1, versions: [1], files: [] }
window.fixture = { calls: [], failImageSave: false, failSave: true }
window.api = { bitsbytes: {
  subscribe: () => () => {},
  async call(method, args) {
    // Electron also requires cloneable IPC payloads; Solid store proxies fail.
    if (args) structuredClone(args)
    window.fixture.calls.push({ method, args })
    if (method === "state") return { skills: [structuredClone(skill)] }
    if (method === "mcp.settings.list") return { servers: [structuredClone(mcp)] }
    if (method === "mcp.settings.save") {
      if (window.fixture.failSave) throw new Error("bb.error.mcpConfig")
      mcp.config = args.config; mcp.status = args.config.enabled ? "connected" : "disabled"
      return { servers: [structuredClone(mcp)] }
    }
    if (method === "plugins.settings.list") return { plugins: [structuredClone(plugin)], restartRequired: false }
    if (method === "plugins.settings.save") {
      if (window.fixture.failSave) throw new Error("bb.error.pluginConfig")
      plugin.enabled = args.enabled
      return { plugins: [structuredClone(plugin)], restartRequired: true }
    }
    if (method === "skill.save") {
      if (window.fixture.failSave) throw new Error("bb.error.invalidSkill")
      Object.assign(skill, args)
      return [structuredClone(skill)]
    }
    if (method === "images.status") return { ...configuration }
    if (method === "images.models") return configuration.models.map(id => ({ id, name: id }))
    if (method === "images.configure") {
      await new Promise(resolve => setTimeout(resolve, 80))
      if (window.fixture.failImageSave) throw new Error("bb.error.imageStorage")
      configuration.enabled = args.provider !== "none"
      if (configuration.enabled) {
        configuration.provider = args.provider
        configuration.model = args.model || "fixture-image"
      }
      return { ...configuration }
    }
    throw new Error("Unexpected local fixture call")
  }
} }
render(() => <><ImageGenerationSettings /><ExtensionsSettings /></>, document.querySelector("main"))
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
  const imageSettings = page.locator('[data-bb-image-settings]')
  const provider = imageSettings.getByRole("combobox", { name: "Provider", exact: true })
  const model = imageSettings.getByRole("combobox", { name: "Image model", exact: true })
  await page.waitForFunction(() => document.querySelector('[aria-label="Image model"]')?.value === "fixture-image")
  assert.equal(await imageSettings.getByRole("button").count(), 0)
  assert.equal(await imageSettings.locator('input[type="password"]').count(), 0)
  await model.selectOption("fixture-second")
  await provider.selectOption("none")
  await page.waitForFunction(() => !document.querySelector('[data-bb-image-settings] [role="status"]'))
  assert.equal(await provider.inputValue(), "none")
  assert.equal(await model.count(), 0)
  check("Rapid model and Off choices save in order without extra buttons, credentials or billed tests")

  await provider.selectOption("openrouter")
  await page.waitForFunction(() => !document.querySelector('[data-bb-image-settings] [role="status"]') && document.querySelector('[aria-label="Image model"]')?.value === "fixture-second")
  await page.evaluate(() => { window.fixture.failImageSave = true })
  await model.selectOption("fixture-image")
  await imageSettings.getByRole("alert").waitFor()
  assert.equal(await model.inputValue(), "fixture-second")
  await page.evaluate(() => { window.fixture.failImageSave = false })
  await model.selectOption("fixture-image")
  await page.waitForFunction(() => !document.querySelector('[data-bb-image-settings] [role="status"]') && !document.querySelector('[data-bb-image-settings] [role="alert"]'))
  assert.equal(await model.inputValue(), "fixture-image")
  check("Failed autosaves restore the saved selection and a later selection recovers")
  await model.selectOption("fixture-second")
  await provider.selectOption("none")
  await provider.selectOption("openrouter")
  await page.waitForFunction(() => !document.querySelector('[data-bb-image-settings] [role="status"]') && document.querySelector('[aria-label="Image model"]')?.value === "fixture-second")
  check("Changing model then rapidly turning Off and back On retains the latest model")
  assert.equal(await page.evaluate(() => window.fixture.calls.some(call => ["images.verify", "images.job"].includes(call.method))), false)
  assert.deepEqual(report.errors, [])
  const extension = page.locator(".bb-clean-settings").filter({ has: page.getByRole("heading", { name: "Extensions", exact: true }) })
  for (const [tab, label] of [["MCPs", "Enable QA MCP"], ["Plugins", "Enable qa-plugin"], ["Skills", "Enable QA skill"]]) {
    await extension.getByRole("tab", { name: tab, exact: true }).click()
    await page.evaluate(() => { window.fixture.failSave = true })
    const control = extension.getByRole("switch", { name: label, exact: true })
    await control.click()
    await extension.getByRole("alert").waitFor()
    assert.equal(await control.isChecked(), false)
    assert.equal(await control.isEnabled(), true)
    await page.evaluate(() => { window.fixture.failSave = false })
    await control.click()
    await page.waitForFunction(label => { const input = document.querySelector('input[aria-label="' + label + '"]'); return input?.checked && !input.disabled }, label)
    assert.equal(await extension.getByRole("alert").count(), 0)
    check(tab + " restores saved state on failure, remains retryable, and sends cloneable nested settings")
  }
  assert.deepEqual(report.errors, [])
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
