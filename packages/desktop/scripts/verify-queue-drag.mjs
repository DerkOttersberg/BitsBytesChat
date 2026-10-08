import { captureHidden } from "./qa-capture.mjs"
import { createRequire } from "node:module"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile, symlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { constants, setPriority } from "node:os"
import assert from "node:assert/strict"

// Run from packages/desktop. Only this script's hidden app/profile is touched.
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const version = JSON.parse(await readFile(join(root, "packages/desktop/package.json"), "utf8")).version
const profile = join(root, ".tools/qa/queue-preview-" + randomUUID())
const data = join(profile, "BitsBytesChat")
const basename = process.env.BB_QA_REPORT || "queue-preview"
const report = { checks: [], errors: [], colors: {}, drags: [], profile }
const held = Promise.withResolvers()
let entered = false
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const fixture = createServer(async (req, res) => {
  let body = ""
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body || "{}")
  const latest = input.messages?.filter(message => message.role === "user").at(-1)
  if (JSON.stringify(latest?.content).includes("queue-drag-hold")) {
    entered = true
    await held.promise
  }
  res.writeHead(200, { "content-type": "text/event-stream" })
  const chunk = delta => JSON.stringify({ id: "qa-" + randomUUID(), object: "chat.completion.chunk", model: "qa-model", choices: [{ index: 0, delta, finish_reason: null }] })
  res.write("data: " + chunk({ role: "assistant", content: "Completed the fictional QA request." }) + "\n\n")
  res.end("data: " + JSON.stringify({ id: "qa-end", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }) + "\n\ndata: [DONE]\n\n")
})
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve))
await mkdir(join(data, "config/opencode"), { recursive: true })
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(join(data, "config/opencode/opencode.json"), JSON.stringify({ provider: { "bitsbytes-qa": { name: "Local QA", npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:" + fixture.address().port + "/v1", apiKey: "fixture-only" }, models: { "qa-model": { name: "QA model", limit: { context: 128000, output: 8192 } } } } }, model: "bitsbytes-qa/qa-model" }))
const app = await _electron.launch({
  executablePath: process.env.BB_QA_EXECUTABLE || join(root, `packages/desktop/dist/${version}/win-unpacked/BitsBytesChat.exe`),
  ...(process.env.BB_QA_MAIN ? { args: [process.env.BB_QA_MAIN] } : {}),
  env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", BB_QA_CAPTURE: "1", LOCALAPPDATA: profile },
  timeout: 90000,
})
let page
try {
  page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  page.on("pageerror", error => report.errors.push(error.message))
  await page.locator(".bb-nav").waitFor({ timeout: 90000 })
  await page.locator("[contenteditable=true]").first().waitFor({ timeout: 90000 })
  const call = (method, args = {}) => page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
  const server = await page.evaluate(() => window.api.awaitInitialization())
  const directory = join(data, "workspace")
  const headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) }
  if (server.password) headers.authorization = "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")
  const response = await fetch(server.url + "/session", { method: "POST", headers, body: JSON.stringify({ title: "QA queue drag regression" }), signal: AbortSignal.timeout(45000) })
  assert.ok(response.ok)
  const chat = await response.json()
  await page.evaluate(detail => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), { directory, sessionID: chat.id })
  const main = page.locator(`.bb-workspace-chat[data-bb-chat="${chat.id}"]`)
  const editor = main.locator("[contenteditable=true]").first()
  const composer = main.locator("form:has([contenteditable=true])").first()
  await editor.waitFor()
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.webContents.setBackgroundThrottling(false)
    win.setMinimumSize(0, 0)
    win.setContentSize(828, 740)
  })
  const check = text => { report.checks.push(text); console.log("PASS", text) }
  const color = () => composer.evaluate(node => getComputedStyle(node).backgroundColor)
  const theme = async scheme => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForFunction(scheme => document.documentElement.dataset.colorScheme === scheme, scheme)
  }
  const overlay = () => composer.evaluate(node => node.classList.contains("border-dashed"))
  const send = async text => {
    await editor.fill(text)
    await main.locator("[data-action=prompt-submit]").click()
  }
  const queue = () => call("runs.get", { sessionID: chat.id }).then(run => run.queue.map(item => item.prompt.text))
  await theme("light")
  report.colors.lightIdle = await color()
  await theme("dark")
  report.colors.darkIdle = await color()
  assert.equal(report.colors.darkIdle, "rgb(54, 54, 54)")
  // Prepare the held turn through the public API before testing queue controls;
  // startup agent discovery can still be pending when the new editor mounts.
  await call("runs.admit", { delivery: "queue", prompt: { sessionID: chat.id, directory, id: "msg_" + ((BigInt(Date.now()) * 4096n) & 0xffffffffffffn).toString(16).padStart(12, "0") + randomUUID().replaceAll("-", "").slice(0, 14), text: "queue-drag-hold", agent: "build", model: { providerID: "bitsbytes-qa", modelID: "qa-model" }, legacyParts: [{ type: "text", text: "queue-drag-hold" }] } })
  for (let i = 0; i < 450 && !entered; i++) await wait(100)
  assert.ok(entered)
  report.colors.darkBusy = await color()
  await theme("light")
  report.colors.lightBusy = await color()
  await send("fds")
  const first = main.locator(".bb-queue-row").filter({ hasText: "fds" })
  await first.waitFor()
  await send("QA queued second")
  const second = main.locator(".bb-queue-row").filter({ hasText: "QA queued second" })
  await second.waitFor()
  report.colors.lightQueued = await color()
  await theme("dark")
  report.colors.darkQueued = await color()
  assert.equal(report.colors.darkBusy, report.colors.darkIdle)
  assert.equal(report.colors.darkQueued, report.colors.darkIdle)
  assert.equal(report.colors.lightBusy, report.colors.lightIdle)
  assert.equal(report.colors.lightQueued, report.colors.lightIdle)
  check("Light and dark composer backgrounds stay constant when idle, busy and queued")

  await page.mouse.move(1, 1)
  assert.equal(await first.locator(".bb-queue-grip").isVisible(), false)
  assert.ok(await first.locator(".bb-queue-symbol").isVisible())
  await first.hover()
  assert.ok(await first.locator(".bb-queue-grip").isVisible())
  assert.equal(await first.locator(".bb-queue-symbol").isVisible(), false)
  await first.getByRole("button", { name: "Queued message actions" }).focus()
  await page.mouse.move(1, 1)
  assert.ok(await first.locator(".bb-queue-grip").isVisible())
  await editor.focus()
  check("Queue symbol becomes a visible grip on hover or keyboard focus without moving the text")

  await page.evaluate(() => {
    window.__queueQADrags = []
    document.addEventListener("dragstart", event => window.__queueQADrags.push({ event: event.type }), true)
    document.addEventListener("drop", event => window.__queueQADrags.push({ event: event.type, types: [...event.dataTransfer.types] }), true)
  })
  const firstBefore = await first.boundingBox(), secondBefore = await second.boundingBox()
  await page.mouse.move(firstBefore.x + 8, firstBefore.y + firstBefore.height / 2)
  await page.mouse.down()
  await page.mouse.move(firstBefore.x + 8, secondBefore.y + secondBefore.height / 2, { steps: 8 })
  await page.waitForFunction(() => document.querySelector('.bb-queue-row[data-dragging="true"]')?.style.transform.includes("32px"))
  await wait(200)
  assert.deepEqual(await queue(), ["fds", "QA queued second"])
  assert.ok(Math.abs((await second.boundingBox()).y - firstBefore.y) < 1)
  assert.ok(Math.abs((await first.boundingBox()).y - secondBefore.y) < 1)
  await captureHidden(app, page, join(root, ".tools/qa/results/" + basename + "-preview.png"))
  check("Neighbors visibly swap positions before mouse release; the durable queue is unchanged during preview")
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelector(".bb-queue-row .bb-queue-text")?.textContent === "QA queued second")
  assert.deepEqual(await queue(), ["QA queued second", "fds"])
  report.drags = await page.evaluate(() => window.__queueQADrags)
  assert.deepEqual(report.drags, [])
  check("Release commits the previewed order without native drag events or a blocked-drop cursor")

  const from = await first.boundingBox(), to = await editor.boundingBox()
  await page.mouse.move(from.x + 8, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + 8, from.y + from.height / 2 - 8, { steps: 3 })
  await page.mouse.move(to.x + 30, to.y + to.height / 2, { steps: 5 })
  await page.mouse.move(to.x + 40, to.y + to.height / 2)
  assert.equal(await first.getAttribute("data-dragging"), "true")
  assert.ok(await first.locator(".bb-queue-grip").isVisible())
  assert.equal(await overlay(), false)
  assert.equal(await editor.evaluate(node => getComputedStyle(node).cursor), "grabbing")
  await captureHidden(app, page, join(root, ".tools/qa/results/" + basename + "-active.png"))
  await page.mouse.up()
  assert.equal(await first.getAttribute("data-dragging"), null)
  assert.equal(await overlay(), false)
  assert.equal(await editor.textContent(), "")
  assert.deepEqual(await queue(), ["QA queued second", "fds"])
  check("Grip stays visible while dragging; dropping over chat neither shows file UI nor inserts or reorders anything")

  const escapeFrom = await first.boundingBox(), escapeTo = await second.boundingBox()
  await page.mouse.move(escapeFrom.x + 8, escapeFrom.y + 16)
  await page.mouse.down()
  await page.mouse.move(escapeFrom.x + 8, escapeTo.y + 16, { steps: 8 })
  await page.waitForFunction(() => !!document.querySelector('[data-dragging="true"]'))
  await call("runs.goal-draft", { sessionID: chat.id, enabled: false })
  await wait(200)
  assert.equal(await first.getAttribute("data-dragging"), "true")
  await page.keyboard.press("Escape")
  await page.mouse.up()
  assert.equal(await first.getAttribute("data-dragging"), null)
  assert.deepEqual(await queue(), ["QA queued second", "fds"])
  assert.equal((await call("runs.get", { sessionID: chat.id })).paused, false)
  check("Same-ID host refreshes retain pointer capture; Escape cancels the preview without changing the queue")

  for (let i = 0; i < 12; i++) {
    await send("QA scroll " + i + " extra")
    await main.locator(".bb-queue-row").filter({ hasText: "QA scroll " + i + " extra" }).waitFor()
  }
  const list = main.locator(".bb-queue-list")
  await list.evaluate(node => { node.scrollTop = 0 })
  const scrollFrom = await second.boundingBox(), scrollTo = await list.boundingBox()
  await page.mouse.move(scrollFrom.x + 8, scrollFrom.y + 16)
  await page.mouse.down()
  await page.mouse.move(scrollFrom.x + 8, scrollTo.y + scrollTo.height - 5, { steps: 12 })
  await page.waitForFunction(() => document.querySelector('.bb-queue-list')?.scrollTop > 0)
  await page.keyboard.press("Escape")
  await page.mouse.up()
  assert.deepEqual((await queue()).slice(0, 2), ["QA queued second", "fds"])
  for (let i = 0; i < 12; i++) await main.locator(".bb-queue-row").filter({ hasText: "QA scroll " + i + " extra" }).getByRole("button", { name: "Delete", exact: true }).click()
  check("Long queues scroll while dragging at an edge; cancelling keeps the original order")

  await main.getByRole("button", { name: "Stop", exact: true }).click()
  await main.locator(".bb-queue-paused").waitFor()
  assert.equal((await call("runs.get", { sessionID: chat.id })).pauseReason, "user-stop")
  await second.getByRole("button", { name: "Delete", exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.bb-queue-row').length === 1)
  assert.deepEqual(await queue(), ["fds"])
  const paused = main.locator(".bb-queue-paused")
  assert.ok(await paused.getByText("Queue paused because you interrupted", { exact: true }).isVisible())
  assert.equal((await paused.boundingBox()).height, 33)
  assert.equal(await paused.getByRole("button", { name: "Resume queue" }).textContent(), "Resume")
  const capturePaused = async scheme => {
    await theme(scheme)
    const full = join(root, ".tools/qa/results/" + basename + "-paused-" + scheme + "-full.png")
    await captureHidden(app, page, full)
    const q = await main.locator('.bb-run-queue').boundingBox(), c = await composer.boundingBox(), scale = await page.evaluate(() => devicePixelRatio)
    const png = await app.evaluate(({ nativeImage }, { png, clip }) => nativeImage.createFromBuffer(Buffer.from(png, 'base64')).crop(clip).toPNG().toString('base64'), { png: (await readFile(full)).toString('base64'), clip: { x: Math.floor((c.x - 10) * scale), y: Math.floor((q.y - 12) * scale), width: Math.round((c.width + 14) * scale), height: Math.ceil((c.y + c.height - q.y + 22) * scale) } })
    await writeFile(join(root, ".tools/qa/results/" + basename + "-paused-" + scheme + ".png"), Buffer.from(png, 'base64'))
  }
  await page.mouse.move(1, 1)
  await capturePaused("light")
  await capturePaused("dark")
  check("Actual Stop keeps the queue and shows the reference's 33px pause header, divider and Resume control in both themes")

  held.resolve()
  await paused.getByRole("button", { name: "Resume queue" }).click()
  await page.waitForFunction(() => document.querySelectorAll(".bb-queue-row").length === 0, null, { timeout: 45000 })
  assert.equal(await main.locator(".bb-queue-paused").count(), 0)
  check("Resume starts the preserved request and removes the paused tray header")
  for (let i = 0; i < 150; i++) {
    const run = await call("runs.get", { sessionID: chat.id })
    if (run.last && !run.queue.length && !run.awaiting) break
    if (i === 149) throw Error("QA chat did not become idle")
    await wait(200)
  }
  report.colors.darkFinished = await color()
  await theme("light")
  report.colors.lightFinished = await color()
  assert.equal(report.colors.darkFinished, report.colors.darkIdle)
  assert.equal(report.colors.lightFinished, report.colors.lightIdle)
  check("Composer colors stay constant after the queue finishes and disappears")

  const fileDrag = type => composer.evaluate((node, type) => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(["Fictional QA file contents."], "queue-drag-test.txt", { type: "text/plain" }))
    node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }))
  }, type)
  await fileDrag("dragenter")
  await fileDrag("dragover")
  assert.ok(await overlay())
  await fileDrag("drop")
  await page.waitForFunction(() => document.querySelector('[data-component="prompt-input-v2"]')?.textContent.includes("queue-drag-test.txt"))
  assert.equal(await overlay(), false)
  check("File DataTransfer still shows the attachment overlay and adds its text file")
  await composer.evaluate(node => {
    const dataTransfer = new DataTransfer()
    dataTransfer.setData("text/plain", "file:QA-mentioned.md")
    node.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }))
    node.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }))
  })
  await page.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.textContent.includes("QA-mentioned.md"))
  assert.equal(await overlay(), false)
  check("File-path mention drags keep working through the existing text protocol")
  assert.deepEqual(report.errors, [])
  assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocused())))
  check("Zero renderer errors; QA windows stayed hidden and unfocused")
} catch (error) {
  report.failure = String(error.stack)
  console.error(error)
  if (page) await captureHidden(app, page, join(root, ".tools/qa/results/" + basename + "-failure.png")).catch(() => {})
  process.exitCode = 1
} finally {
  held.resolve()
  await writeFile(join(root, ".tools/qa/results/" + basename + ".json"), JSON.stringify(report, null, 2))
  await app.close()
  fixture.closeAllConnections()
  await new Promise(resolve => fixture.close(resolve))
}
