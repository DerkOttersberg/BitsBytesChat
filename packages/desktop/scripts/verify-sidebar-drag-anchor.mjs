import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { join, resolve } from "node:path"

// Focused native pointer check. No screenshots, user profiles or paid requests.
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/sidebar-drag-anchor-" + randomUUID())
const data = join(profile, "BitsBytesChat")
const directory = join(data, "workspace")
const output = join(root, ".tools/qa/results")
const fixture = createServer((_, response) => {
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Fictional QA response" }, finish_reason: "stop" }] }))
})
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve))
await Promise.all([directory, join(data, "config/opencode"), output].map(path => mkdir(path, { recursive: true })))
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(join(data, "config/opencode/opencode.json"), JSON.stringify({
  provider: { "drag-qa": {
    name: "Local QA", npm: "@ai-sdk/openai-compatible",
    options: { baseURL: "http://127.0.0.1:" + fixture.address().port + "/v1", apiKey: "fixture-only" },
    models: { fixture: { name: "Drag QA fixture", limit: { context: 128000, output: 8192 } } },
  } }, model: "drag-qa/fixture",
}))
const report = { checks: [], errors: [], alignments: [], screenshots: 0 }
let app
try {
  app = await _electron.launch({
    executablePath: process.env.BB_QA_EXECUTABLE || join(root, ".tools/qa/sidebar-drag-anchor-package/win-unpacked/BitsBytesChat.exe"),
    ...(process.env.BB_QA_MAIN ? { args: [process.env.BB_QA_MAIN] } : {}),
    env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", BB_QA_CAPTURE: "0", LOCALAPPDATA: profile }, timeout: 90000,
  })
  const page = await app.firstWindow()
  page.on("pageerror", error => report.errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setBackgroundThrottling(false)
    window.setContentSize(1380, 900)
  })
  const server = await page.evaluate(() => window.api.awaitInitialization())
  const headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) }
  if (server.password) headers.authorization = "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")
  const api = async (path, method = "GET", body) => {
    const response = await fetch(server.url + path, { method, headers, signal: AbortSignal.timeout(45000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.ok(response.ok, `${method} ${path}: ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }
  await page.locator(".bb-org-sidebar").waitFor({ timeout: 90000 })
  const project = await api("/api/organization/projects", "POST", { name: "Drag target" })
  const chats = []
  for (const title of ["Short title", "A longer fictional conversation title that exceeds the compact drag preview width"]) {
    const chat = await api("/session", "POST", { title })
    await api(`/session/${chat.id}/prompt_async`, "POST", {
      noReply: true, agent: "build", model: { providerID: "drag-qa", modelID: "fixture" }, parts: [{ type: "text", text: title }],
    })
    chats.push(chat)
  }
  const target = page.locator(`section[data-project-id="${project.id}"] .bb-org-children`)
  await target.waitFor()
  const preview = page.locator(".bb-org-drag-preview")
  const begin = async (chat, fraction) => {
    const link = page.locator(`.bb-org-row[data-session-id="${chat.id}"] .bb-org-chat-link`).first()
    await link.scrollIntoViewIfNeeded()
    const box = await link.boundingBox()
    await page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2)
    await page.mouse.down()
    const point = { x: box.x + box.width * fraction + 12, y: box.y + box.height / 2 + 10 }
    await page.mouse.move(point.x, point.y, { steps: 4 })
    await preview.waitFor()
    return point
  }
  const aligned = async (point, fraction, state) => {
    const box = await preview.boundingBox()
    assert.ok(box && point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height, "Cursor must remain inside its drag card")
    const errorX = Math.abs(box.x + box.width * fraction - point.x)
    const errorY = Math.abs(box.y + box.height / 2 - point.y)
    assert.ok(errorX < 2 && errorY < 2, `Pickup anchor shifted: ${errorX}, ${errorY}`)
    report.alignments.push({ ...state, fraction, errorX, errorY })
  }
  const smoke = process.env.BB_QA_SMOKE === "1"
  for (const zoom of smoke ? [1.25] : [1, 1.25]) {
    await app.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), zoom)
    await page.waitForFunction(zoom => Math.abs(innerWidth - 1380 / zoom) < 1, zoom)
    for (const scheme of smoke ? ["light"] : ["dark", "light"]) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForFunction(scheme => document.documentElement.dataset.colorScheme === scheme, scheme)
      for (const chat of chats) for (const fraction of [0.15, 0.85]) {
        const state = { zoom, scheme, title: chat.title }
        await aligned(await begin(chat, fraction), fraction, state)
        const box = await target.boundingBox()
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        await page.mouse.move(point.x, point.y, { steps: 8 })
        await aligned(point, fraction, state)
        await page.keyboard.press("Escape")
        await page.mouse.up()
        assert.equal(await preview.count(), 0)
      }
    }
  }
  report.checks.push(`${report.alignments.length} cursor/pickup alignments pass for short/long cards and two pickup positions${smoke ? " at 125% scaling" : ", both themes and 100%/125% scaling"}`)
  assert.equal((await api("/api/organization/chats/query", "POST", { projectID: project.id })).data.length, 0)
  report.checks.push(`All ${report.alignments.length / 2} Escape cancellations remove the preview without changing membership`)
  await begin(chats[0], 0.5)
  const box = await target.boundingBox()
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(point.x, point.y, { steps: 8 })
  await aligned(point, 0.5, { zoom: 1.25, scheme: "light", title: chats[0].title })
  await page.mouse.up()
  let saved = false
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await api("/api/organization/chats/query", "POST", { projectID: project.id })
    if (result.data.some(chat => chat.id === chats[0].id)) { saved = true; break }
    await page.waitForTimeout(100)
  }
  assert.ok(saved, "Drop must save membership")
  assert.equal((await api("/session/" + chats[0].id)).directory.toLowerCase(), directory.toLowerCase())
  report.checks.push("Dropping the anchored card inside project contents saves membership and preserves its execution folder")
  assert.deepEqual(report.errors, [])
  assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocused())))
  report.checks.push("Zero renderer errors; every QA window stayed hidden/unfocused; no screenshots were taken")
} catch (error) {
  report.failure = error.stack || String(error)
  process.exitCode = 1
} finally {
  await app?.close()
  await new Promise(resolve => fixture.close(resolve))
  await writeFile(join(output, (process.env.BB_QA_REPORT || "sidebar-drag-anchor") + ".json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
