import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { captureHidden } from "./qa-capture.mjs"

const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const before = process.env.BB_QA_BEFORE === "1"
const profile = join(root, ".tools/qa/ff-" + randomUUID().slice(0, 8))
const data = join(profile, "BitsBytesChat")
const directory = join(data, "workspace")
const results = join(root, ".tools/qa/results")
const executablePath = process.env.BB_QA_EXECUTABLE
assert.ok(executablePath, "Choose the candidate package explicitly")
const name = process.env.BB_QA_REPORT || (before ? "five-flows-before" : "five-flows-after")
const report = {
  checks: [],
  errors: [],
  geometry: [],
  screenshots: [],
  profile,
  before,
  localProvider: true,
  paidRequests: false,
  asarSHA256: createHash("sha256")
    .update(await readFile(join(dirname(executablePath), "resources/app.asar")))
    .digest("hex"),
}
const requests = []
const held = new Set()
const command = Array.from({ length: 100 }, (_, i) => `echo fictional-permission-${i}-${"scope".repeat(10)}`).join("\n")
const todos = Array.from({ length: 32 }, (_, i) => ({
  content: i === 1 ? "Review a long task step " + "with readable wrapping ".repeat(15) : `Fictional step ${i + 1}`,
  status: i === 0 ? "completed" : i === 1 ? "in_progress" : i === 2 ? "cancelled" : "pending",
  priority: "medium",
}))
const fixture = createServer(async (req, res) => {
  let payload = ""
  for await (const part of req) payload += part
  const body = JSON.parse(payload || "{}")
  const last = body.messages?.findLastIndex((row) => row.role === "user") ?? -1
  const latest = JSON.stringify(body.messages?.[last]?.content ?? "")
  const trigger = latest.split("Diagnostic parent snapshot")[0]
  requests.push({ latest })
  const tool = (name) =>
    body.tools?.find((t) => t.function?.name === name || t.function?.name?.endsWith("_" + name))?.function.name
  const ran = (name) =>
    body.messages
      ?.slice(last)
      .some((row) => row.tool_calls?.some((t) => t.function?.name === name || t.function?.name?.endsWith("_" + name)))
  const calls = []
  if (trigger.includes("fixture-oversized") && tool("bash") && !ran("bash"))
    calls.push({ name: tool("bash"), args: { command, description: "Verify 100 fictional scopes" } })
  if (trigger.includes("fixture-todos") && tool("todowrite") && !ran("todowrite"))
    calls.push({
      name: tool("todowrite"),
      args: { todos: trigger.includes("complete") ? todos.map((t) => ({ ...t, status: "completed" })) : todos },
    })
  res.writeHead(200, { "content-type": "text/event-stream" })
  const emit = (delta) =>
    res.write(
      "data: " +
        JSON.stringify({
          id: randomUUID(),
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason: null }],
        }) +
        "\n\n",
    )
  emit({ role: "assistant" })
  if (trigger.includes("fixture-held")) {
    emit({ content: "Working on an owned local fixture." })
    held.add(res)
    res.once("close", () => held.delete(res))
    return
  }
  if (calls.length)
    emit({
      tool_calls: calls.map((c, index) => ({
        index,
        id: "call_" + randomUUID(),
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    })
  else emit({ content: "Local fixture completed." })
  res.end(
    "data: " +
      JSON.stringify({
        id: "end",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
      }) +
      "\n\ndata: [DONE]\n\n",
  )
})
await new Promise((done) => fixture.listen(0, "127.0.0.1", done))
await Promise.all([directory, results, join(data, "config/opencode")].map((p) => mkdir(p, { recursive: true })))
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    provider: {
      "five-qa": {
        name: "Local QA",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `http://127.0.0.1:${fixture.address().port}/v1`, apiKey: "fixture-only" },
        models: {
          fixture: {
            name: "Five flows fixture",
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 1000000, output: 8192 },
          },
        },
      },
    },
    model: "five-qa/fixture",
  }),
)
const check = (label) => {
  report.checks.push(label)
  console.log("PASS", label)
}
const poll = async (read, accept, label) => {
  for (let i = 0; i < 240; i++) {
    const result = await read()
    if (accept(result)) return result
    await new Promise((done) => setTimeout(done, 100))
  }
  throw Error("Timed out: " + label)
}
let app, page
try {
  app = await _electron.launch({
    executablePath,
    env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", BB_QA_CAPTURE: "1", LOCALAPPDATA: profile },
    timeout: 90000,
  })
  page = await app.firstWindow({ timeout: 120000 })
  report.todoRequests = []
  page.on("response", async (response) => {
    if (!response.url().includes("/todo")) return
    const body = await response.json().catch(() => undefined)
    report.todoRequests.push({ status: response.status(), count: Array.isArray(body) ? body.length : undefined })
  })
  page.on("pageerror", (e) => report.errors.push(e.message))
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.webContents.setBackgroundThrottling(false)
    w.webContents.setZoomFactor(1)
    w.setContentSize(1080, 600)
  })
  const server = await page.evaluate(() => window.api.awaitInitialization())
  const headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) }
  if (server.password)
    headers.authorization =
      "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")
  const api = async (path, method = "GET", body) => {
    const response = await fetch(server.url + path, {
      method,
      headers,
      signal: AbortSignal.timeout(45000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    assert.ok(response.ok, `${method} ${path}: ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }
  const call = (method, args = {}) =>
    page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
  await page.locator(".bb-org-sidebar").waitFor({ state: "attached", timeout: 90000 })
  await poll(
    () => api("/agent"),
    (rows) => rows.some((r) => r.name === "build"),
    "workspace",
  )
  await api("/api/organization/migrate", "POST", { projects: [{ directory }], defaultDirectory: directory })
  const model = { providerID: "five-qa", modelID: "fixture" }
  const create = async (title) => {
    const chat = await api("/session", "POST", {
      title,
      permission: [
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "read", pattern: "*", action: "allow" },
        { permission: "todowrite", pattern: "*", action: "allow" },
      ],
    })
    await api(`/session/${chat.id}/prompt_async`, "POST", {
      noReply: true,
      agent: "build",
      model,
      parts: [{ type: "text", text: "Owned fixture chat" }],
    })
    return chat
  }
  const open = async (chat) => {
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), {
      directory,
      sessionID: chat.id,
    })
    await page
      .locator(`.bb-workspace-chat[data-bb-chat="${chat.id}"] [contenteditable=true]`)
      .first()
      .waitFor({ timeout: 60000 })
  }
  const send = async (chat, text) => {
    await open(chat)
    const main = page.locator(`.bb-workspace-chat[data-bb-chat="${chat.id}"]`)
    // A restored draft can mount before the selected model is available.
    await main.getByRole("button", { name: /Five flows fixture/ }).waitFor({ timeout: 60000 })
    const editor = main.locator("[contenteditable=true]").first()
    await editor.fill(text)
    await main.locator('[data-action="prompt-submit"]').click()
  }
  const capture = async (label) => {
    const path = join(results, name + "-" + label + ".png")
    report.screenshots.push({ label, path, ...(await captureHidden(app, page, path)) })
  }
  const chat = await create("Long approval")
  await send(chat, "fixture-oversized")
  const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await dock.waitFor({ timeout: 60000 })
  const geometry = await dock.evaluate((node) => ({
    height: innerHeight,
    rect: node.getBoundingClientRect().toJSON(),
    content: node.querySelector('[data-slot="permission-content"]').getBoundingClientRect().toJSON(),
    buttons: [...node.querySelectorAll("button")].map((b) => ({
      label: b.textContent,
      rect: b.getBoundingClientRect().toJSON(),
      visible: b.getBoundingClientRect().bottom <= innerHeight && b.getBoundingClientRect().top >= 0,
    })),
  }))
  report.geometry.push({ label: "long-approval", ...geometry })
  report.permissionPatterns = (await api("/permission"))
    .filter((r) => r.sessionID === chat.id)
    .map((r) => r.patterns.length)
  await capture("approval")
  if (before) {
    assert.ok(
      geometry.rect.top < 0 || geometry.buttons.some((b) => !b.visible),
      "Current package should reproduce clipped approval",
    )
    check("Confirmed current production approval exceeds available chat height")
  } else {
    assert.ok(
      geometry.rect.top >= 0 && geometry.buttons.every((b) => b.visible),
      "All approval controls must remain on screen",
    )
    assert.ok(geometry.content.height < geometry.rect.height)
    check("100-scope approval keeps decisions and Stop in view with scrollable content")
    await dock.getByRole("button", { name: "Allow once", exact: true }).click()
    await poll(
      () => api(`/session/${chat.id}/message`),
      (rows) => rows.at(-1)?.info.finish === "stop",
      "approved continuation",
    )
    assert.equal((await api("/permission")).filter((r) => r.sessionID === chat.id).length, 0)
    check("Allow once resumes the blocked tool and completes the chat")
    await send(chat, "fixture-oversized again")
    await dock.waitFor({ timeout: 60000 })
    await dock.getByRole("button", { name: "Deny", exact: true }).click()
    await poll(
      () => api("/permission"),
      (rows) => !rows.some((r) => r.sessionID === chat.id),
      "denied request",
    )
    check("Deny clears the request without a stuck responding state")
    await send(chat, "fixture-oversized stop")
    await dock.waitFor({ timeout: 60000 })
    await dock.getByRole("button", { name: "Stop", exact: true }).click()
    await poll(
      () => api("/permission"),
      (rows) => !rows.some((r) => r.sessionID === chat.id),
      "stopped request",
    )
    check("Stop releases a pending approval")
    const first = await create("Busy chat A"),
      second = await create("Busy chat B")
    await send(first, "fixture-held A")
    await send(second, "fixture-held B")
    const activity = (id) => page.locator(`.bb-org-row[data-session-id="${id}"] .bb-org-activity[data-state="working"]`)
    await activity(first.id).waitFor()
    await activity(second.id).waitFor()
    assert.equal(await page.locator(".bb-org-status").count(), 0)
    const animated = await activity(first.id)
      .locator("svg")
      .evaluate((n) => getComputedStyle(n).animationName)
    assert.equal(animated, "bb-chat-spin")
    await capture("concurrent")
    check("Two concurrent chats animate independently and decorative idle dots are gone")
    await page.reload()
    await activity(first.id).waitFor({ timeout: 60000 })
    await activity(second.id).waitFor({ timeout: 60000 })
    check("Active chat indicators are restored from server state after renderer reload")
    await page.emulateMedia({ reducedMotion: "reduce" })
    assert.equal(
      await activity(first.id)
        .locator("svg")
        .evaluate((n) => getComputedStyle(n).animationName),
      "none",
    )
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await call("runs.stop", { sessionID: first.id })
    await call("runs.stop", { sessionID: second.id })
    await poll(
      () => activity(first.id).count(),
      (count) => count === 0,
      "spinner cleared",
    )
    check("Stop clears activity and reduced motion retains a static status")
    const task = await create("Todo widget")
    await send(task, "fixture-todos")
    const main = page.locator(`.bb-workspace-chat[data-bb-chat="${task.id}"]`)
    const widget = main.locator('[data-component="session-todo-widget"]')
    await widget.waitFor()
    assert.equal(await main.locator('[data-component="session-todo-dock"]').count(), 0)
    await widget.click()
    const popup = page.locator(".bb-todo-popup")
    await popup.waitFor()
    assert.equal(await popup.locator("li").count(), todos.length)
    assert.ok(await popup.locator(".bb-todo-list").evaluate((n) => n.scrollHeight > n.clientHeight))
    await capture("todos")
    await page.keyboard.press("Escape")
    await popup.waitFor({ state: "hidden" })
    check("Real todos move to the top right with bounded detail, long steps and keyboard dismissal")
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setContentSize(780, 480)
      w.webContents.setZoomFactor(1.25)
    })
    await widget.click()
    await popup.waitFor()
    const bounds = await popup.evaluate((n) => ({
      rect: n.getBoundingClientRect().toJSON(),
      w: innerWidth,
      h: innerHeight,
    }))
    report.geometry.push({ label: "narrow-todos", ...bounds })
    assert.ok(bounds.rect.left >= 0 && bounds.rect.right <= bounds.w + 1 && bounds.rect.bottom <= bounds.h + 1)
    await capture("narrow")
    check("Todo details stay inside a short narrow window at 125% zoom")
    await page.keyboard.press("Escape")
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.webContents.setZoomFactor(1)
      w.setContentSize(1080, 700)
    })
    await send(task, "fixture-todos complete")
    await poll(
      () => widget.innerText(),
      (text) => text.includes("32/32"),
      "completed todo progress",
    )
    await poll(
      () => api(`/session/${task.id}/message`),
      (rows) => rows.at(-1)?.info.finish === "stop",
      "todo completion",
    )
    await page.reload()
    await widget.waitFor({ timeout: 60000 })
    assert.match(await widget.innerText(), /32\/32/)
    check("Completed todos remain reviewable through completion and reload")
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 800))
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:side-chat", { detail })), {
      source: task.id,
      directory,
      model,
      agent: "build",
    })
    const side = page.locator(".bb-embedded-chat").first()
    const sideEditor = side.locator("[contenteditable=true]").first()
    await sideEditor.waitFor({ timeout: 60000 })
    const sideID = await side.getAttribute("data-bb-chat")
    await sideEditor.fill("fixture-side conversation")
    await sideEditor.press("Enter")
    await poll(
      () => api(`/session/${sideID}/message`),
      (rows) => rows.at(-1)?.info.finish === "stop",
      "read-only side reply",
    )
    const sideWidget = side.locator('[data-component="session-todo-widget"]')
    assert.equal(await sideWidget.count(), 0)
    assert.match(await widget.innerText(), /32\/32/)
    await widget.click()
    await popup.waitFor()
    const sideBounds = await popup.evaluate((n) => ({
      rect: n.getBoundingClientRect().toJSON(),
      w: innerWidth,
      h: innerHeight,
    }))
    assert.ok(
      sideBounds.rect.left >= 0 &&
        sideBounds.rect.right <= sideBounds.w + 1 &&
        sideBounds.rect.bottom <= sideBounds.h + 1,
    )
    await capture("side-todos")
    await page.keyboard.press("Escape")
    check(
      "Split-view todo details fit the main chat and its completed progress is not copied to the read-only side chat",
    )
    await widget.click()
    await popup.waitFor()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(620, 520))
    await popup.waitFor({ state: "hidden" })
    assert.equal(await main.getAttribute("aria-hidden"), "true")
    await sideEditor.fill("An editable read-only conversation draft")
    await capture("side-overlay")
    check("Narrow side-panel overlays dismiss hidden main-chat todo details and keep side-chat controls usable")
    await page.locator(".bb-panel-collapse button").click()
    await send(task, "fixture-oversized narrow")
    await dock.waitFor({ timeout: 60000 })
    const sideApproval = dock
    assert.ok(
      await sideApproval.locator("button").evaluateAll((nodes) =>
        nodes.every((n) => {
          const rect = n.getBoundingClientRect()
          return rect.top >= 0 && rect.bottom <= innerHeight
        }),
      ),
    )
    await capture("narrow-approval")
    await sideApproval.getByRole("button", { name: "Stop", exact: true }).click()
    await sideApproval.waitFor({ state: "hidden" })
    check("Oversized approval decisions and Stop remain accessible in a short narrow chat after closing a side overlay")
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1080, 700))
    await open(first)
    assert.equal(
      await page
        .locator(`.bb-workspace-chat[data-bb-chat="${first.id}"] [data-component="session-todo-widget"]`)
        .count(),
      0,
    )
    check("Todo widgets use their own chat state")
    const files = await create("Any file attachments")
    await open(files)
    const fileMain = page.locator(`.bb-workspace-chat[data-bb-chat="${files.id}"]`)
    const input = fileMain.locator('input[type="file"]').first()
    assert.equal(await input.getAttribute("accept"), null)
    const bin = join(directory, "fixture-save.nbt"),
      audio = join(directory, "fixture-voice.wav"),
      word = join(directory, "fixture-notes.docx")
    const opaque = Buffer.from([0, 255, 32, 1, 0, 99])
    const { ZipWriter, Uint8ArrayWriter, TextReader } = await import("@zip.js/zip.js")
    const writer = new ZipWriter(new Uint8ArrayWriter())
    await writer.add(
      "word/document.xml",
      new TextReader("<w:document><w:p>Fictional attached Word source.</w:p></w:document>"),
    )
    const office = Buffer.from(await writer.close())
    await Promise.all([
      writeFile(bin, opaque),
      writeFile(audio, Buffer.from("RIFF\0\0\0\0WAVE\0fixture")),
      writeFile(word, office),
    ])
    await input.setInputFiles([bin, audio, word])
    await poll(
      () => fileMain.innerText(),
      (text) =>
        text.includes("fixture-save.nbt") && text.includes("fixture-voice.wav") && text.includes("fixture-notes.docx"),
      "binary attachment chips",
    )
    await page.evaluate(() => {
      const transfer = new DataTransfer()
      transfer.items.add(
        new File([new Uint8Array([0, 1, 255, 0])], "dropped.unknown", { type: "application/octet-stream" }),
      )
      document.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }))
    })
    await poll(
      () => fileMain.innerText(),
      (text) => text.includes("dropped.unknown"),
      "arbitrary file drop",
    )
    await page.waitForTimeout(700)
    await page.reload()
    await fileMain.locator("[contenteditable=true]").first().waitFor({ timeout: 60000 })
    assert.match(await fileMain.innerText(), /fixture-save\.nbt/)
    assert.match(await fileMain.innerText(), /dropped\.unknown/)
    check("Multiple Office, audio, opaque and dropped files are accepted and their draft survives reload")
    await send(files, "fixture-attachments")
    const messages = await poll(
      () => api(`/session/${files.id}/message`),
      (rows) => rows.at(-1)?.info.finish === "stop",
      "binary attachment send",
    )
    const attachments = messages.findLast((row) => row.info.role === "user").parts.filter((p) => p.type === "file")
    assert.equal(attachments.length, 4)
    for (const attachment of attachments) {
      assert.match(attachment.url, /^bitsbytes:\/\/attachment\/[a-f0-9]{64}$/)
      const stored = join(data, "attachments", attachment.url.split("/").at(-1))
      const metadata = JSON.parse(await readFile(join(stored, "file.json"), "utf8"))
      const bytes = await readFile(join(stored, "source" + metadata.suffix))
      const original =
        metadata.filename === "fixture-save.nbt"
          ? opaque
          : metadata.filename === "fixture-notes.docx"
            ? office
            : metadata.filename === "dropped.unknown"
              ? Buffer.from([0, 1, 255, 0])
              : await readFile(audio)
      assert.deepEqual(bytes, original)
    }
    const source = requests.findLast((r) => r.latest.includes("fixture-attachments"))?.latest ?? ""
    assert.match(source, /Saved exact source:/)
    assert.match(source, /Fictional attached Word source/)
    assert.doesNotMatch(source, /data:application\/octet-stream/)
    await capture("attachments")
    check("Binary inputs reach the model as usable file context and tools receive exact durable source bytes")
  }
  assert.deepEqual(report.errors, [])
} catch (error) {
  report.failure = error.stack
  if (page) await captureHidden(app, page, join(results, name + "-failure.png")).catch(() => {})
  throw error
} finally {
  held.forEach((res) => res.end())
  if (app) await app.close()
  fixture.closeAllConnections()
  fixture.close()
  await writeFile(join(results, name + ".json"), JSON.stringify(report, null, 2))
}
