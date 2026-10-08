import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { join, resolve } from "node:path"
import { captureHidden } from "./qa-capture.mjs"

setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const basename = process.env.BB_QA_REPORT || "interface-previews"
const profile = join(root, ".tools/qa/interface-previews-" + randomUUID())
const data = join(profile, "BitsBytesChat"), directory = join(data, "workspace")
const results = join(root, ".tools/qa/results")
const path = join(directory, "Project plan.md"), imagePath = join(directory, "Recorded logo.png")
const workingPath = join(directory, "Working plan.md"), diagramPath = join(directory, "assets/diagram.png")
const original = await readFile(join(root, "packages/desktop/icons/bitsbytes/icon.png"))
const diagram = await readFile(join(root, "packages/desktop/icons/bitsbytes/64x64.png"))
const changed = await readFile(join(root, "packages/desktop/icons/bitsbytes/32x32.png"))
const first = "# Project plan\n\nA readable preview keeps the original Markdown available.\n\n## First revision\n\n| Task | Status |\n| --- | --- |\n| Review the design | Complete |\n| Inspect the logo | Next |\n\n- [x] Keep source formatting\n- [ ] Review the recorded image\n\n```ts\nconst revision = 1\n```\n\n![Saved diagram](assets/diagram.png)\n\n" + Array.from({ length: 60 }, (_, index) => `### Review note ${index + 1}\n\nThe source and preview retain their own position while the saved revision remains unchanged.\n`).join("\n")
const second = "# Updated project plan\n\n## Second revision\n\nThe original revision remains available for review.\n\n- [x] Review the design\n- [x] Inspect the logo\n\n![Saved diagram](assets/diagram.png)\n"
const working = "# Workspace plan\n\nThis Markdown file stays in the chat workspace.\n\n![Workspace diagram](assets/diagram.png)\n\n[Project document](Project%20plan.md)\n"
const report = { profile, checks: [], errors: [], captures: [], requests: [] }
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const check = label => { report.checks.push(label); console.log("PASS", label) }
const readPrompts = new Set()
const fixture = createServer(async (request, response) => {
  try {
    let body = ""
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body || "{}")
    const tool = input.tools?.find(tool => tool.function?.name === "read" || tool.function?.name.endsWith("_read"))?.function.name
    report.requests.push({ model: input.model, toolNames: input.tools?.map(tool => tool.function?.name) ?? [] })
    assert.ok(tool, "The actual engine must offer its image-read tool")
    // The provider adapter may represent image tool results as user payloads.
    // Count the explicit QA requests, not those synthetic image payloads.
    const prompt = input.messages?.some(message => message.role === "user" && JSON.stringify(message.content).includes("from this diagnostic side chat")) ? "side-image" : "main-image"
    const calls = readPrompts.has(prompt) ? [] : [{ name: tool, args: { filePath: imagePath } }]
    readPrompts.add(prompt)
    response.writeHead(200, { "content-type": "text/event-stream" })
    const emit = delta => response.write("data: " + JSON.stringify({ id: "qa-" + randomUUID(), object: "chat.completion.chunk", model: "preview-fixture", choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\n")
    emit({ role: "assistant" })
    if (calls.length) emit({ tool_calls: calls.map((call, index) => ({ index, id: "call_" + randomUUID(), type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) })
    else emit({ content: "The recorded app logo is 512 × 512 pixels. Your project plan remains open; choose Open image to inspect the recorded copy." })
    response.end("data: " + JSON.stringify({ id: "end", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 } }) + "\n\ndata: [DONE]\n\n")
  } catch (error) { report.errors.push(String(error)); response.writeHead(500); response.end("Local fixture assertion failed") }
})
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve))
await mkdir(join(data, "config/opencode"), { recursive: true })
await mkdir(directory, { recursive: true })
await mkdir(join(directory, "assets"), { recursive: true })
await mkdir(results, { recursive: true })
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(path, first)
await writeFile(workingPath, working)
await writeFile(diagramPath, diagram)
await writeFile(imagePath, original)
await writeFile(join(data, "config/opencode/opencode.json"), JSON.stringify({
  model: "preview-qa/preview-fixture",
  provider: { "preview-qa": { name: "Preview fixture", npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${fixture.address().port}/v1`, apiKey: "fixture-only" }, models: { "preview-fixture": { name: "Preview fixture", limit: { context: 128000, output: 8192 } } } } },
}))
let app, page
try {
  app = await _electron.launch({
    executablePath: process.env.BB_QA_EXECUTABLE || join(root, ".tools/qa/interface-patch-final-package/win-unpacked/BitsBytesChat.exe"),
    ...(process.env.BB_QA_MAIN ? { args: [process.env.BB_QA_MAIN] } : {}),
    env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", BB_QA_CAPTURE: "1", LOCALAPPDATA: profile }, timeout: 90000,
  })
  page = await app.firstWindow()
  const suppressNotifications = () => Object.defineProperty(window, "Notification", { configurable: true, value: class extends EventTarget {
    static permission = "denied"
    static requestPermission = async () => "denied"
    close() {}
  } })
  await page.addInitScript(suppressNotifications)
  await page.evaluate(suppressNotifications)
  page.setDefaultTimeout(20000)
  page.on("pageerror", error => report.errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isVisible() || window.isFocused()) throw Error("QA window became visible")
      window.setSize(1440, 960)
    }
  })
  await page.locator("[contenteditable=true]").first().waitFor({ timeout: 90000 })
  const call = (method, args = {}) => page.evaluate(async ({ method, args }) => {
    const portable = value => value instanceof Uint8Array ? Array.from(value) : Array.isArray(value) ? value.map(portable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item)])) : value
    return portable(await window.api.bitsbytes.call(method, args))
  }, { method, args })
  const server = await page.evaluate(() => window.api.awaitInitialization())
  const headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) }
  if (server.password) headers.authorization = "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")
  const engine = async (path, method = "GET", input) => {
    const response = await fetch(server.url + path, { method, headers, ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw Error(`QA engine request failed: ${method} ${path} (${response.status})`)
    return response.status === 204 ? null : response.json()
  }
  const session = await engine("/session", "POST", { title: "Documents and recorded images" })
  if (process.env.BB_QA_SKIP_WORKSPACE !== "1") await page.evaluate(({ directory, sessionID, path }) => {
    const id = "file://Working%20plan.md"
    localStorage.setItem(`bitsbytes.panels.v2:${directory}:${sessionID}`, JSON.stringify({ tabs: [{ id, path, owner: sessionID, title: "Working plan.md", kind: "file" }], active: id, collapsed: false, width: 520 }))
  }, { directory, sessionID: session.id, path: workingPath })
  await page.evaluate(detail => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), { directory, sessionID: session.id })
  const main = page.locator(`.bb-workspace-chat[data-bb-chat="${session.id}"]`)
  await main.locator("[contenteditable=true]").first().waitFor()
  await call("access.set", { sessionID: session.id, mode: "full" })
  const capture = async (name, scheme) => {
    if (scheme) { await page.emulateMedia({ colorScheme: scheme }); await page.waitForFunction(value => document.documentElement.dataset.colorScheme === value, scheme) }
    const target = join(results, `${basename}-${name}${scheme ? "-" + scheme : ""}.png`)
    const viewport = await captureHidden(app, page, target)
    report.captures.push({ name, scheme, path: target, viewport })
  }
  const panel = page.locator(".bb-panel-content:visible")
  if (process.env.BB_QA_SKIP_WORKSPACE !== "1") {
  await panel.getByRole("heading", { name: "Workspace plan", exact: true }).waitFor()
  await page.waitForFunction(() => {
    const image = document.querySelector('.bb-panel-content:not([style*="display: none"]) .bb-markdown-preview img')
    return image?.naturalWidth === 64 && image.src.startsWith("blob:")
  })
  assert.equal((await call("artifacts.list")).length, 0)
  const resources = await call("document.resources", { sessionID: session.id, directory, path: "Working plan.md", text: working })
  assert.equal(resources.path, workingPath)
  assert.equal(Buffer.from(resources.resources[0].data).compare(diagram), 0)
  for (const scheme of ["dark", "light"]) await capture("workspace-markdown", scheme)
  await panel.getByRole("button", { name: "Source", exact: true }).click()
  await page.waitForFunction(() => {
    const text = node => (node.nodeType === Node.TEXT_NODE ? node.textContent : "") + [...node.childNodes].map(text).join("") + (node.shadowRoot ? text(node.shadowRoot) : "")
    return [...document.querySelectorAll(".bb-markdown-source:not([hidden])")].some(node => text(node).includes("# Workspace plan"))
  })
  for (const scheme of ["dark", "light"]) await capture("workspace-markdown-source", scheme)
  await panel.getByRole("button", { name: "Preview", exact: true }).click()
  await page.getByRole("tab", { name: "Working plan.md", exact: true }).locator("..").getByRole("button", { name: "Close tab", exact: true }).click()
  check("Restored workspace Markdown preserves its Source editor and resolves bounded relative images from the authorized chat folder without publishing an artifact")
  } else report.skipped = ["Restored workspace file stage is awaiting the component self-loading patch in the next package"]

  const artifact = await call("artifact.publish", { path, sessionID: session.id })
  const openRevision = revision => page.evaluate(detail => window.dispatchEvent(new CustomEvent("bitsbytes:open-artifact", { detail })), { id: artifact.id, revision })
  await openRevision(1)
  await panel.getByRole("heading", { name: "Project plan", exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('.bb-panel-content:not([style*="display: none"]) .bb-markdown-preview img')?.naturalWidth === 64)
  assert.equal(await panel.locator(".bb-markdown-preview table").count(), 1)
  for (const scheme of ["dark", "light"]) await capture("markdown-preview", scheme)
  await panel.getByRole("button", { name: "Source", exact: true }).click()
  await panel.locator(".bb-markdown-source:not([hidden])").waitFor()
  await page.waitForFunction(() => {
    const text = node => (node.nodeType === Node.TEXT_NODE ? node.textContent : "") + [...node.childNodes].map(text).join("") + (node.shadowRoot ? text(node.shadowRoot) : "")
    return [...document.querySelectorAll(".bb-markdown-source:not([hidden])")].some(node => text(node).includes("# Project plan"))
  })
  for (const scheme of ["dark", "light"]) await capture("markdown-source", scheme)
  await panel.getByRole("button", { name: "Preview", exact: true }).click()
  check("Markdown renders headings, tables and code, with an explicit Source toggle in both themes")

  await panel.locator(".bb-markdown-preview").evaluate(element => { element.scrollTop = 360 })
  await page.waitForFunction(id => JSON.parse(localStorage.getItem(`bitsbytes.markdown-scroll:${id}:1`) || "{}").preview?.top === 360, artifact.id)
  await panel.getByRole("button", { name: "Source", exact: true }).click()
  await panel.locator(".bb-markdown-source").evaluate(element => { element.scrollTop = 240 })
  await page.waitForFunction(id => JSON.parse(localStorage.getItem(`bitsbytes.markdown-scroll:${id}:1`) || "{}").source?.top === 240, artifact.id)
  await panel.getByRole("button", { name: "Preview", exact: true }).click()

  await writeFile(path, second)
  await writeFile(diagramPath, changed)
  await call("artifact.publish", { path, sessionID: session.id })
  await openRevision(1)
  await panel.getByRole("heading", { name: "First revision", exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('.bb-panel-content:not([style*="display: none"]) .bb-markdown-preview')?.scrollTop === 360)
  await panel.getByRole("button", { name: "Source", exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.bb-panel-content:not([style*="display: none"]) .bb-markdown-source')?.scrollTop === 240)
  await panel.getByRole("button", { name: "Preview", exact: true }).click()
  await panel.locator(".bb-markdown-preview").evaluate(element => { element.scrollTop = 0 })
  await page.waitForFunction(() => document.querySelector('.bb-panel-content:not([style*="display: none"]) .bb-markdown-preview img')?.naturalWidth === 64)
  check("Preview and Source preserve their separate positions across revision remounts")
  assert.equal(await panel.getByRole("heading", { name: "Updated project plan", exact: true }).count(), 0)
  assert.equal((await call("artifact.content", { id: artifact.id, revision: 1 })).text, first)
  for (const scheme of ["dark", "light"]) await capture("markdown-historical", scheme)
  await openRevision(2)
  await panel.getByRole("heading", { name: "Second revision", exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('.bb-panel-content:not([style*="display: none"]) .bb-markdown-preview img')?.naturalWidth === 32)
  await writeFile(path, "Unpublished working copy")
  await writeFile(diagramPath, original)
  assert.equal((await call("artifact.content", { id: artifact.id, revision: 2 })).text, second)
  assert.equal(Buffer.from((await call("artifact.resource", { id: artifact.id, revision: 1, href: "assets/diagram.png" })).data).compare(diagram), 0)
  assert.equal(Buffer.from((await call("artifact.resource", { id: artifact.id, revision: 2, href: "assets/diagram.png" })).data).compare(changed), 0)
  check("Selecting an older Markdown revision displays its exact saved text and images, independent of latest or unpublished source")

  const selectedBefore = await page.locator('.bb-panel-tabs [aria-selected="true"]').innerText()
  const prompt = "Inspect the app logo, report its dimensions, and keep my project plan open until I choose Open image."
  await call("runs.admit", { prompt: { sessionID: session.id, directory, id: "msg_" + ((BigInt(Date.now()) * 4096n) & 0xffffffffffffn).toString(16).padStart(12, "0") + randomUUID().replaceAll("-", "").slice(0, 14), text: prompt, agent: "build", model: { providerID: "preview-qa", modelID: "preview-fixture" }, legacyParts: [{ type: "text", text: prompt }] } })
  const openImage = main.getByRole("button", { name: "Open image", exact: true }).first()
  await openImage.waitFor({ timeout: 60000 })
  await main.getByText("512 × 512 px", { exact: true }).first().waitFor()
  assert.equal(await page.locator('.bb-panel-tabs [aria-selected="true"]').innerText(), selectedBefore)
  assert.equal(await page.locator(".bb-recorded-image-panel").count(), 0)
  for (const scheme of ["dark", "light"]) await capture("recorded-image-action", scheme)
  await writeFile(imagePath, changed)
  await openImage.click()
  const recorded = page.locator(".bb-panel-content:visible .bb-recorded-image-panel")
  await recorded.locator("img").waitFor()
  await recorded.getByText("512 × 512 px · Recorded image", { exact: true }).waitFor()
  const loaded = await recorded.locator("img").evaluate(async image => Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer())))
  assert.equal(createHash("sha256").update(Buffer.from(loaded)).digest("hex"), createHash("sha256").update(original).digest("hex"))
  assert.equal(await page.getByRole("tab", { name: "Project plan.md", exact: true }).count(), 1)
  for (const scheme of ["dark", "light"]) await capture("recorded-image-panel", scheme)
  const savedPanels = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("bitsbytes.panels.v2:")).map(([, value]) => value))
  assert.ok(savedPanels.some(value => value.includes('"kind":"image"')))
  assert.ok(savedPanels.every(value => !value.includes("data:image") && !value.includes("base64")))
  check("Image reading leaves the current document open; Open image displays immutable recorded bytes after the original file changes")
  check("Recorded image panel persistence contains the snapshot reference, never base64 image bytes")

  await writeFile(imagePath, original)
  await page.evaluate(detail => window.dispatchEvent(new CustomEvent("bitsbytes:side-chat", { detail })), {
    source: session.id, directory, agent: "build", model: { providerID: "preview-qa", modelID: "preview-fixture" },
  })
  const side = page.locator(".bb-embedded-chat[data-bb-chat]").first()
  await side.locator("[contenteditable=true]").first().waitFor()
  const sideID = await side.getAttribute("data-bb-chat")
  assert.ok(sideID && sideID !== session.id)
  const sidePrompt = "Inspect the recorded app logo again from this diagnostic side chat. Report its dimensions without changing files."
  await call("runs.admit", { prompt: { sessionID: sideID, directory, id: "msg_" + ((BigInt(Date.now()) * 4096n) & 0xffffffffffffn).toString(16).padStart(12, "0") + randomUUID().replaceAll("-", "").slice(0, 14), text: sidePrompt, agent: "build", model: { providerID: "preview-qa", modelID: "preview-fixture" }, legacyParts: [{ type: "text", text: sidePrompt }] } })
  const sideImage = side.getByRole("button", { name: "Open image", exact: true }).first()
  await sideImage.waitFor({ timeout: 60000 })
  assert.equal(await page.locator('.bb-panel-tabs [aria-selected="true"]').innerText(), "Side chat")
  await writeFile(imagePath, changed)
  await sideImage.click()
  await recorded.getByText("512 × 512 px · Recorded image", { exact: true }).waitFor()
  const childSnapshot = await page.evaluate(({ directory, parentID, sideID }) => {
    const state = JSON.parse(localStorage.getItem(`bitsbytes.panels.v2:${directory}:${parentID}`))
    return state.tabs.find(tab => tab.kind === "image" && tab.owner === sideID)
  }, { directory, parentID: session.id, sideID })
  assert.ok(childSnapshot?.uri)
  assert.equal(childSnapshot.owner, sideID)
  assert.equal(Buffer.from((await call("image.read", { id: childSnapshot.uri, sessionID: sideID })).data).compare(original), 0)
  await assert.rejects(() => call("image.read", { id: childSnapshot.uri, sessionID: session.id }))
  assert.equal(await page.getByRole("tab", { name: "Project plan.md", exact: true }).count(), 1)
  for (const scheme of ["dark", "light"]) await capture("side-chat-recorded-image", scheme)
  await page.locator('.bb-panel-tabs [aria-selected="true"]').locator("..").getByRole("button", { name: "Close tab", exact: true }).click()
  await page.getByRole("tab", { name: "Side chat", exact: true }).locator("..").getByRole("button", { name: "Close tab", exact: true }).click()
  await page.getByRole("tab", { name: "Side chat", exact: true }).waitFor({ state: "detached" })
  await page.getByRole("tab", { name: "Project plan.md", exact: true }).click()
  check("A side chat opens its recorded image in the containing panel, preserves the parent document, and keeps the snapshot owned by the source chat")

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("bitsbytes:open-settings")))
  await page.getByRole("tab", { name: "Tools & permissions", exact: true }).click()
  const settings = page.locator("[data-bb-image-settings]")
  await settings.getByText("Image generation is not connected.", { exact: true }).waitFor()
  assert.equal(await settings.getByRole("button", { name: "Test and enable image generation", exact: true }).isDisabled(), true)
  assert.equal(await settings.locator('input[type="password"]').inputValue(), "")
  assert.equal((await call("images.status")).available, false)
  assert.ok(report.requests.every(row => row.toolNames.every(name => !name?.endsWith("generate_image"))))
  await settings.scrollIntoViewIfNeeded()
  for (const scheme of ["dark", "light"]) await capture("image-provider-settings", scheme)
  await page.keyboard.press("Escape")
  check("Image settings distinguish the separate API connection and disable verification until a key is saved; the unverified image tool is absent")

  assert.ok(!(await page.locator("body").innerText()).includes("OpenCode"))
  const links = await page.locator('link[rel="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]').evaluateAll(rows => rows.map(row => row.getAttribute("href")))
  assert.ok(links.every(href => href.includes("bitsbytes-icon")))
  check("Packaged entry points use the Bits & Bytes title and dedicated regular icon assets")

  // Reload only this isolated QA renderer with a controlled unhealthy response.
  // The app and its engine remain running; no real user window is touched.
  for (const endpoint of ["**/api/health", "**/global/health"]) await page.route(endpoint, async route => {
    await wait(120)
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ healthy: false }) })
  })
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.locator('[data-component="logo-splash"]').first().waitFor()
  assert.equal(await page.locator('[data-component="logo-splash"]').first().getAttribute("aria-label"), "Bits & Bytes Chat")
  await capture("branded-loading")
  await page.getByText("Retrying automatically...", { exact: true }).waitFor({ timeout: 30000 })
  for (const scheme of ["dark", "light"]) await capture("branded-connection-error", scheme)
  assert.ok(!(await page.locator("body").innerText()).includes("OpenCode"))
  assert.equal(await page.locator('[data-component="logo-splash"] image').count(), 1)
  check("Actual loading and unreachable-server screens show the Bits & Bytes mark without upstream branding")
  assert.equal(report.errors.length, 0, report.errors.join("\n"))
} catch (error) {
  report.failure = error.stack || String(error)
  console.error("FAIL", report.failure)
  if (page && app) await captureHidden(app, page, join(results, `${basename}-failure.png`)).catch(() => undefined)
  process.exitCode = 1
} finally {
  await writeFile(join(results, basename + ".json"), JSON.stringify(report, null, 2))
  if (app) await app.close()
  fixture.closeAllConnections()
  await new Promise(resolve => fixture.close(resolve))
}
