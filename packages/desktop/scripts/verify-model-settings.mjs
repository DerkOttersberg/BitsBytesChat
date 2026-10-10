import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { join, resolve } from "node:path"
import { captureHidden } from "./qa-capture.mjs"

// All configuration, credentials, windows and catalogues belong to this isolated fixture.
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/model-settings-" + randomUUID())
const config = join(profile, "BitsBytesChat/config/opencode")
const results = join(root, ".tools/qa/results")
const name = process.env.BB_QA_REPORT || "model-settings"
const report = { profile, checks: [], errors: [], paidRequests: false }
await Promise.all([config, results].map(path => mkdir(path, { recursive: true })))
const writeCatalog = async (extra = false) => {
  const model = name => ({ name, tool_call: true, limit: { context: 128000, output: 8192 } })
  await writeFile(join(config, "opencode.json"), JSON.stringify({
    model: "opencode/fixture", small_model: "opencode/fixture",
    provider: {
      opencode: { name: "Free fixture", npm: "@ai-sdk/openai-compatible", whitelist: ["fixture"], options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "fictional" }, models: { fixture: model("Free fixture") } },
      openrouter: { name: "OpenRouter", whitelist: ["fixture/alpha", "fixture/beta", ...(extra ? ["fixture/new"] : [])], options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "fictional" }, models: {
        "fixture/alpha": model("Router Alpha fixture"), "fixture/beta": model("Router Beta fixture"), ...(extra ? { "fixture/new": model("Router New fixture") } : {}),
      } },
    },
  }))
}
await writeCatalog()
const poll = async (read, accept, label) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read()
    if (accept(value)) return value
    await new Promise(done => setTimeout(done, 100))
  }
  throw Error("Timed out: " + label)
}
const check = label => { report.checks.push(label); console.log("PASS", label) }
let app, page
const settings = () => page.locator(".settings-v2-dialog")
const group = () => settings().locator('[data-component="settings-models-provider"]').filter({ hasText: "OpenRouter" })
const toggle = () => group().getByRole("switch", { name: "All OpenRouter models", exact: true })
const model = name => group().getByRole("switch", { name, exact: true })
const showModels = async () => {
  await page.locator(".bb-org-account").getByRole("button", { name: "Settings", exact: true }).click()
  await settings().getByRole("tab", { name: "Models", exact: true }).click()
  await toggle().waitFor()
  await poll(() => toggle().isEnabled(), value => value, "model preferences ready")
}
const launch = async () => {
  app = await _electron.launch({
    executablePath: process.env.BB_QA_EXECUTABLE,
    ...(process.env.BB_QA_MAIN ? { args: [process.env.BB_QA_MAIN] } : {}),
    env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", BB_QA_CAPTURE: "1", LOCALAPPDATA: profile }, timeout: 90000,
  })
  page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  page.on("pageerror", error => report.errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setBackgroundThrottling(false)
    window.setContentSize(1380, 900)
  })
  await page.locator(".bb-org-sidebar").waitFor({ timeout: 90000 })
  await page.evaluate(() => window.api.awaitInitialization())
  await showModels()
}
try {
  await launch()
  assert.equal(await toggle().isChecked(), false)
  assert.equal(await model("Router Alpha fixture").isChecked(), false)
  assert.equal(await model("Router Beta fixture").isChecked(), false)
  check("First connection defaults every OpenRouter model off")
  await settings().getByRole("searchbox", { name: "Search models", exact: true }).fill("Router Alpha")
  await model("Router Alpha fixture").waitFor()
  assert.equal(await model("Router Beta fixture").count(), 0)
  await toggle().focus()
  await toggle().press("Space")
  assert.equal(await toggle().isChecked(), true)
  await settings().getByRole("searchbox", { name: "Search models", exact: true }).fill("")
  assert.equal(await model("Router Alpha fixture").isChecked(), true)
  assert.equal(await model("Router Beta fixture").isChecked(), true)
  await toggle().locator("..").locator('[data-slot="switch-control"]').click()
  assert.equal(await model("Router Alpha fixture").isChecked(), false)
  assert.equal(await model("Router Beta fixture").isChecked(), false)
  await model("Router Beta fixture").locator("..").locator('[data-slot="switch-control"]').click()
  assert.equal(await toggle().isChecked(), false)
  assert.equal(await model("Router Beta fixture").isChecked(), true)
  await captureHidden(app, page, join(results, name + ".png"))
  check("Provider switch changes the complete catalogue during search; individual selections remain available")
  await page.keyboard.press("Escape")
  await page.locator('[data-action="prompt-model"]').click()
  await page.locator('[data-option-key="openrouter:fixture/beta"]').waitFor()
  assert.equal(await page.locator('[data-option-key="openrouter:fixture/alpha"]').count(), 0)
  await page.keyboard.press("Escape")
  check("The mounted chat model picker immediately uses the updated provider visibility")
  await showModels()
  assert.equal(await model("Router Beta fixture").isChecked(), true)
  await page.keyboard.press("Escape")
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible() || window.isFocused())), false)
  await app.close()
  app = undefined
  await writeCatalog(true)
  await launch()
  assert.equal(await toggle().isChecked(), false)
  assert.equal(await model("Router Alpha fixture").isChecked(), false)
  assert.equal(await model("Router Beta fixture").isChecked(), true)
  assert.equal(await model("Router New fixture").isChecked(), false)
  const free = settings().getByRole("switch", { name: "Free fixture", exact: true })
  assert.equal(await free.isChecked(), true)
  check("Restart preserves the manual selection; catalogue additions stay off and other providers are unchanged")
  assert.deepEqual(report.errors, [])
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible() || window.isFocused())), false)
} catch (error) { report.failure = error.stack || String(error); throw error }
finally {
  await app?.close()
  await writeFile(join(results, name + ".json"), JSON.stringify(report, null, 2))
}
