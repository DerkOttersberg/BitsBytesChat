import { createRequire } from "node:module"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import assert from "node:assert/strict"
import { mobileCopy } from "../src/bitsbytes/mobile-copy.ts"

const root = resolve("../..")
const assets = process.env.BB_MOBILE_ASSETS || join(root, "packages/desktop/resources/bitsbytes/mobile")
const { chromium } = createRequire(join(process.env.BB_QA_ROOT || root, ".tools/qa/package.json"))("playwright")
const report = { checks: [], errors: [], sends: 0 }
const fixture = { failOverview: false, revoked: false, hold: false, held: null, requests: 0 }
const chats = [{ id: "ses_a", title: "Chat A" }, { id: "ses_b", title: "Chat B" }]
const chat = (id, text = "Current " + id) => ({
  title: chats.find(row => row.id === id)?.title,
  messages: [{ info: { id: "msg_" + id, role: "assistant" }, parts: [{ type: "text", text }] }],
  status: { type: "idle" }, access: { mode: "ask" }, run: { queue: [], awaiting: false, paused: false },
  permissions: [], questions: [],
})
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname
  try {
    if (req.method === "GET") {
      if (path === "/favicon.ico") { res.writeHead(204).end(); return }
      if (path === "/uploads") { res.end("[]"); return }
      const bytes = path === "/copy.js" ? "window.BB_COPY=" + JSON.stringify(mobileCopy)
        : await readFile(join(assets, path === "/" ? "index.html" : path.slice(1)))
      res.setHeader("content-type", path === "/" ? "text/html" : path.endsWith("css") ? "text/css" : "text/javascript")
      res.end(bytes); return
    }
    let source = ""; for await (const bytes of req) source += bytes
    const input = JSON.parse(source)
    res.setHeader("content-type", "application/json")
    if (fixture.revoked) { res.writeHead(401).end(JSON.stringify({ error: mobileCopy.unauthorised })); return }
    if (input.method === "overview" && fixture.failOverview) {
      fixture.failOverview = false
      res.writeHead(503).end(JSON.stringify({ error: "Temporary fixture failure" })); return
    }
    if (input.method === "send") report.sends++
    if (input.method === "chat") {
      fixture.requests++
      if (fixture.hold && input.args.sessionID === "ses_a") {
        fixture.hold = false
        fixture.held = res
        return
      }
    }
    res.end(JSON.stringify(input.method === "overview" ? { chats, skills: [], models: [] }
      : input.method === "chat" ? chat(input.args.sessionID) : input.method === "artifacts" ? [] : {}))
  } catch (error) { report.errors.push(error.message); res.writeHead(500).end("{}") }
})
await new Promise(done => server.listen(0, "127.0.0.1", done))
const origin = "http://127.0.0.1:" + server.address().port
const browser = await chromium.launch({ headless: true, channel: "msedge" })
const open = async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  page.on("pageerror", error => report.errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem("bb.session", "ses_a")
    localStorage.setItem("bb.draft.ses_a", JSON.stringify({ text: "Keep my unsent draft" }))
  })
  await page.goto(origin)
  return { context, page }
}
const select = async (page, title) => {
  await page.locator("#menu-button").click()
  await page.getByRole("button", { name: title, exact: true }).click()
}
const held = async page => {
  for (let i = 0; i < 100 && !fixture.held; i++) await page.waitForTimeout(50)
  assert.ok(fixture.held, "The fixture did not receive the delayed chat request")
}
const check = name => { report.checks.push(name); console.log("PASS", name) }
try {
  if (!process.env.BB_RECOVERY_CHECK || process.env.BB_RECOVERY_CHECK === "boot") {
    fixture.failOverview = true
    const { context, page } = await open()
    await page.locator("#app").waitFor({ state: "visible", timeout: 4000 })
    await page.getByText("Current ses_a", { exact: true }).waitFor({ timeout: 8000 })
    assert.equal(await page.locator("#prompt").inputValue(), "Keep my unsent draft")
    await context.close()
    check("A transient startup failure retries while preserving a usable composer and unsent draft")
  }
  if (!process.env.BB_RECOVERY_CHECK || process.env.BB_RECOVERY_CHECK === "stale") {
    const { context, page } = await open()
    await page.getByText("Current ses_a", { exact: true }).waitFor()
    fixture.held = null; fixture.hold = true
    await select(page, "Chat A"); await held(page)
    await select(page, "Chat B")
    await page.getByText("Current ses_b", { exact: true }).waitFor()
    await select(page, "Chat A")
    await page.getByText("Current ses_a", { exact: true }).waitFor()
    fixture.held.end(JSON.stringify(chat("ses_a", "Stale response must stay hidden")))
    fixture.held = null
    await page.waitForTimeout(300)
    assert.equal(await page.getByText("Stale response must stay hidden", { exact: true }).count(), 0)
    assert.equal(await page.locator("#prompt").inputValue(), "Keep my unsent draft")
    await context.close()
    check("A delayed response cannot overwrite the chat after switching A → B → A")
  }
  if (!process.env.BB_RECOVERY_CHECK || process.env.BB_RECOVERY_CHECK === "timeout") {
    const { context, page } = await open()
    await page.getByText("Current ses_a", { exact: true }).waitFor()
    fixture.held = null; fixture.hold = true
    await held(page)
    await page.waitForFunction(text => document.querySelector("#connection")?.textContent === text, mobileCopy.disconnected, { timeout: 22000 })
    const count = fixture.requests
    await page.waitForFunction(text => document.querySelector("#connection")?.textContent === text, mobileCopy.paired, { timeout: 8000 })
    assert.ok(fixture.requests > count)
    assert.equal(await page.locator("#prompt").inputValue(), "Keep my unsent draft")
    fixture.held.destroy(); fixture.held = null
    await context.close()
    check("A hung poll expires and reconnects without replaying a message or discarding the draft")
  }
  fixture.revoked = true
  const { context, page } = await open()
  await page.locator("#pair-screen").waitFor({ state: "visible" })
  assert.equal(await page.locator("#app").isVisible(), false)
  assert.equal(await page.locator("#pair-status").textContent(), mobileCopy.unauthorised)
  await context.close()
  check("Revoked access still returns to pairing")
  assert.equal(report.sends, 0)
  assert.deepEqual(report.errors, [])
} finally {
  await browser.close()
  server.closeAllConnections(); await new Promise(done => server.close(done))
  await mkdir(join(root, ".tools/qa/results"), { recursive: true })
  await writeFile(join(root, ".tools/qa/results/" + (process.env.BB_MOBILE_REPORT || "mobile-recovery") + ".json"), JSON.stringify(report, null, 2))
}
