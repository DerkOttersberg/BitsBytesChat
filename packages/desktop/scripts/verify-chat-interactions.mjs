import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { mkdir, readFile, rmdir, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { constants, setPriority } from "node:os"
import { captureHidden } from "./qa-capture.mjs"

// Controlled provider + real production renderer/engine. Every process and
// profile created here belongs to this run; no live account or desktop input.
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const { _electron, chromium } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/interactions-" + randomUUID())
const data = join(profile, "BitsBytesChat"),
  directory = join(data, "workspace")
const reportName = process.env.BB_QA_REPORT || "035-interactions"
const results = join(root, ".tools/qa/results")
const report = { checks: [], errors: [], observations: [], profile, syntheticProvider: true }
const requests = [],
  holds = new Map()
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGNUSFjAgA0wYRUdtBIA5UgBMGHyow0AAAAASUVORK5CYII="
const textPath = join(directory, "tiny-features.txt"),
  pngPath = join(directory, "recorded-image.png")
const wizardQuestions = [
  {
    header: "Layout",
    question: "Choose a layout",
    options: [
      { label: "Compact (Recommended)", description: "Keep controls close to the composer." },
      { label: "Roomy", description: "Allow more spacing." },
    ],
  },
  {
    header: "Checks",
    question: "Choose checks",
    multiple: true,
    options: [
      { label: "Reliability", description: "Verify cancellation and recovery." },
      { label: "Performance", description: "Measure the interface." },
    ],
  },
  {
    header: "Notes",
    question: "Add a note",
    options: [
      { label: "Keep existing defaults", description: "Use the previous settings." },
      { label: "No extra note (Recommended)", description: "Use the selected preferences." },
    ],
  },
]
const fixture = createServer(async (req, res) => {
  if (req.method === "GET") {
    if (req.url === "/delayed-source") {
      const hold = holds.get("delayed-source")
      hold.entered = true
      await hold.release.promise
      if (res.destroyed) return
    }
    res
      .writeHead(200, { "content-type": "text/html" })
      .end("<!doctype html><title>Recorded QA source</title><p>Recorded reference view</p>")
    return
  }
  let body = ""
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body || "{}")
  const latest = JSON.stringify((input.messages ?? []).filter((row) => row.role === "user").at(-1)?.content ?? "")
  const content = (input.messages ?? []).filter((row) => row.role === "user").at(-1)?.content
  const primary = typeof content === "string" ? content : (content?.find((part) => part.type === "text")?.text ?? "")
  const hasTool = input.messages?.at(-1)?.role === "tool"
  requests.push({ input, latest, at: Date.now() })
  const held = [...holds].find(([marker, hold]) => latest.includes(marker) && !hold.entered)
  if (held) {
    held[1].entered = true
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.flushHeaders()
    const keepalive = setInterval(() => {
      if (!res.destroyed) res.write(": keepalive\n\n")
    }, 15000)
    try {
      await held[1].release.promise
    } finally {
      clearInterval(keepalive)
    }
  }
  if (res.destroyed) return
  const named = (suffix) => input.tools?.find((tool) => tool.function?.name.endsWith(suffix))?.function.name
  const calls = []
  if (!hasTool && latest.includes("wizard-"))
    calls.push({
      name: named("question"),
      args: { questions: wizardQuestions, isBlocking: !latest.includes("optional") },
    })
  if (!hasTool && primary.startsWith("optional-expiry"))
    calls.push({ name: named("question"), args: { questions: wizardQuestions.slice(0, 1), isBlocking: false } })
  if (!hasTool && latest.includes("view-recorded-png")) calls.push({ name: named("read"), args: { filePath: pngPath } })
  if (!hasTool && latest.includes("read-file")) calls.push({ name: named("read"), args: { filePath: textPath } })
  if (!hasTool && latest.includes("edit-file"))
    calls.push({
      name: named("edit"),
      args: { filePath: textPath, oldString: "Original fixture", newString: "Edited fixture" },
    })
  if (!hasTool && latest.includes("patch-file"))
    calls.push({
      name: named("apply_patch"),
      args: {
        patchText:
          "*** Begin Patch\n*** Update File: " +
          textPath.replaceAll("\\", "/") +
          "\n@@\n-Edited fixture\n+Patched fixture\n*** End Patch",
      },
    })
  if (!hasTool && latest.includes("diagnostic-progress")) calls.push({ name: named("parent_progress"), args: {} })
  if (!calls.every((call) => call.name)) {
    report.errors.push("Requested fixture tool was not advertised: " + latest)
    res.writeHead(500).end("Fixture tool missing")
    return
  }
  if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream" })
  const emit = (delta) =>
    res.write(
      "data: " +
        JSON.stringify({
          id: "fixture-" + randomUUID(),
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason: null }],
        }) +
        "\n\n",
    )
  emit({ role: "assistant" })
  if (calls.length)
    emit({
      tool_calls: calls.map((call, index) => ({
        index,
        id: "call_" + randomUUID(),
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    })
  else emit({ content: "Fixture complete: " + latest.slice(0, 120) })
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
await mkdir(join(data, "config/opencode"), { recursive: true })
await mkdir(directory, { recursive: true })
await mkdir(results, { recursive: true })
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(textPath, "Original fixture\n")
await writeFile(pngPath, Buffer.from(png, "base64"))
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    model: "interaction-qa/fixture",
    provider: {
      "interaction-qa": {
        npm: "@ai-sdk/openai-compatible",
        name: "Interaction fixture",
        options: { baseURL: `http://127.0.0.1:${fixture.address().port}/v1`, apiKey: "fixture-only" },
        models: {
          fixture: {
            name: "Interaction fixture",
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 128000, output: 8192 },
          },
          "gpt-5.6-fixture": {
            name: "Local patch fixture",
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 128000, output: 8192 },
          },
        },
      },
    },
  }),
)
const version = JSON.parse(await readFile(join(root, "packages/desktop/package.json"), "utf8")).version
const app = await _electron.launch({
  executablePath:
    process.env.BB_QA_EXECUTABLE || join(root, `packages/desktop/dist/${version}/win-unpacked/BitsBytesChat.exe`),
  ...(process.env.BB_QA_MAIN ? { args: [process.env.BB_QA_MAIN] } : {}),
  env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", BB_QA_CAPTURE: "1", LOCALAPPDATA: profile },
  timeout: 90000,
})
let page, browser, snapshot
const check = (label) => {
  report.checks.push(label)
  console.log("PASS", label)
}
try {
  page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  page.on("pageerror", (error) => report.errors.push(error.message))
  await page.locator("[contenteditable=true]").first().waitFor({ timeout: 90000 })
  const call = (method, args = {}) =>
    page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
  const server = await page.evaluate(() => window.api.awaitInitialization())
  const headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) }
  if (server.password)
    headers.authorization =
      "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")
  const engine = async (path, method = "GET", body) => {
    const response = await fetch(server.url + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    })
    assert.ok(response.ok, path + " " + response.status + " " + (response.ok ? "" : await response.text()))
    return response.status === 204 ? undefined : response.json()
  }
  const eventually = async (predicate, label, timeout = 20000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await predicate()) return
      await delay(100)
    }
    throw Error(label)
  }
  const hidden = async () =>
    assert.ok(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
      "QA must never be visible or focused",
    )
  await hidden()
  const create = (title) => engine("/session", "POST", { title })
  const main = () => page.locator(".bb-workspace-chat")
  const editor = () => main().locator("[contenteditable=true]").first()
  const open = async (chat) => {
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), {
      sessionID: chat.id,
      directory,
    })
    await page.locator(`.bb-workspace-chat[data-bb-chat="${chat.id}"] [contenteditable=true]`).first().waitFor()
  }
  const id = () =>
    "msg_" +
    ((BigInt(Date.now()) * 4096n) & 0xffffffffffffn).toString(16).padStart(12, "0") +
    randomUUID().replaceAll("-", "").slice(0, 14)
  const admit = async (chat, text, extra = {}) =>
    call("runs.admit", {
      immediate: true,
      ...extra,
      prompt: {
        id: id(),
        sessionID: chat.id,
        directory,
        protocol: "v1",
        text,
        agent: "build",
        model: { providerID: "interaction-qa", modelID: "fixture" },
        legacyParts: [{ type: "text", text }],
        ...extra.prompt,
      },
    })
  const idle = (chat) =>
    eventually(async () => {
      const run = await call("runs.get", { sessionID: chat.id })
      return (
        run.last && !run.awaiting && !run.queue.length && (await engine("/session/status"))[chat.id]?.type !== "busy"
      )
    }, "Chat did not settle: " + chat.id)
  const history = (chat) => engine(`/session/${chat.id}/message`)
  snapshot = async (suffix) => {
    const viewport = await captureHidden(app, page, join(results, reportName + "-" + suffix + ".png"))
    report.observations.push({ screenshot: suffix, viewport })
    await hidden()
  }
  report.captureMethod = "Electron offscreen software paint at 10 fps; window stays hidden"
  const hold = (marker) => {
    const value = { entered: false, release: Promise.withResolvers() }
    holds.set(marker, value)
    return value
  }

  const fresh = await create("QA idle and Stop admission")
  await open(fresh)
  await page.evaluate(() => {
    window.__qaQueueFrames = []
    const observer = new MutationObserver(() => {
      if (document.querySelector(".bb-queue-row")) window.__qaQueueFrames.push(performance.now())
    })
    observer.observe(document.querySelector(".bb-workspace-chat"), { childList: true, subtree: true })
    window.__qaQueueObserver = observer
  })
  await editor().fill("idle-message")
  await editor().press("Enter")
  await idle(fresh)
  assert.deepEqual(await page.evaluate(() => window.__qaQueueFrames), [], "An idle send flashed in the queue")
  assert.equal((await history(fresh)).filter((row) => row.info.role === "user").length, 1)
  const slow = hold("stop-held-input")
  await editor().fill("stop-held-input")
  await editor().press("Enter")
  await eventually(() => slow.entered, "Provider hold not entered")
  await main().getByRole("button", { name: "Stop", exact: true }).click()
  await eventually(async () => (await engine("/session/status"))[fresh.id]?.type !== "busy", "Stop did not settle")
  slow.release.resolve()
  await editor().fill("after-stop-new-input")
  await editor().press("Enter")
  await idle(fresh)
  assert.equal((await call("runs.get", { sessionID: fresh.id })).paused, false)
  assert.deepEqual(await page.evaluate(() => window.__qaQueueFrames), [], "A settled Stop-to-Send flashed in the queue")
  const rows = await history(fresh)
  assert.equal(new Set(rows.map((row) => row.info.id)).size, rows.length)
  assert.equal(rows.filter((row) => row.info.role === "user").length, 3)
  await page.evaluate(() => window.__qaQueueObserver.disconnect())
  check("Idle Send and settled Stop-to-Send enter the transcript without queue flash or duplicate IDs")

  const admission = await create("QA durable HTTP admission")
  const input = {
    messageID: id(),
    revision: 1,
    noReply: true,
    agent: "build",
    model: { providerID: "interaction-qa", modelID: "fixture" },
    parts: [{ type: "text", text: "Frozen admission source" }],
  }
  await engine(`/session/${admission.id}/prompt_async`, "POST", input)
  const beforeRetry = await history(admission)
  await engine(`/session/${admission.id}/prompt_async`, "POST", input)
  assert.deepEqual(await history(admission), beforeRetry)
  assert.equal(beforeRetry[0].info.execution.stage, "admitted")
  const conflict = await fetch(server.url + `/session/${admission.id}/prompt_async`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...input, parts: [{ type: "text", text: "Conflicting content" }] }),
  })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json())._tag, "ConflictError")
  assert.deepEqual(await history(admission), beforeRetry)
  check("The real HTTP API durably admits once, preserves exact retries, and rejects conflicting IDs with a typed 409")

  const wizard = await create("QA desktop question wizard")
  await open(wizard)
  await admit(wizard, "wizard-optional")
  const dock = main().locator('[data-component="session-question-dock"]')
  await dock.waitFor()
  await dock.getByText("Choose a layout", { exact: true }).waitFor()
  assert.equal(await dock.getByText("1/3", { exact: true }).count(), 1)
  assert.equal(await dock.getByText("Recommended", { exact: true }).count(), 1)
  assert.equal(await dock.getByRole("timer").count(), 0)
  await snapshot("question-single-light")
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 620))
  await page.waitForFunction(() => innerWidth === 860 && innerHeight === 620)
  await snapshot("question-single-narrow")
  const questionBounds = await dock.boundingBox(),
    mainBounds = await main().boundingBox()
  assert.ok(
    questionBounds.x >= mainBounds.x && questionBounds.x + questionBounds.width <= mainBounds.x + mainBounds.width + 1,
  )
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
  await page.waitForFunction(() => innerWidth === 1280 && innerHeight === 800)
  await dock.getByRole("radio").filter({ hasText: "Compact" }).click()
  await dock.getByText("Choose checks", { exact: true }).waitFor()
  await dock.getByRole("checkbox").filter({ hasText: "Reliability" }).click()
  await dock.getByRole("checkbox").filter({ hasText: "Performance" }).click()
  assert.equal(await dock.getByText("2/3", { exact: true }).count(), 1, "Multi-select must not advance on each click")
  await snapshot("question-multiple")
  await dock.getByRole("button", { name: "Next", exact: true }).last().click()
  await dock.getByText("Add a note", { exact: true }).waitFor()
  await eventually(
    () =>
      dock
        .getByRole("radio")
        .filter({ hasText: "No extra note" })
        .evaluate((node) => node === document.activeElement),
    "The Recommended option must receive focus even when it is not first",
  )
  assert.equal(await dock.locator('[role="radio"][aria-checked="true"]').count(), 0)
  await dock.getByRole("radio").filter({ hasText: "Type your own answer" }).click()
  await dock.locator("textarea").fill("Keep the parent task running 🌿")
  await dock.locator("textarea").press("Enter")
  await dock.getByRole("button", { name: "Submit", exact: true }).click()
  await idle(wizard)
  const answers = (await history(wizard))
    .flatMap((row) => row.parts)
    .find((part) => part.type === "tool" && part.tool === "question")?.state.metadata.answers
  assert.deepEqual(answers, [
    ["Compact (Recommended)"],
    ["Reliability", "Performance"],
    ["Keep the parent task running 🌿"],
  ])
  check(
    "Question wizard badges, numbering, automatic single-choice advance, explicit multi-choice Next and custom Submit preserve exact answers",
  )

  const optional = await create("QA optional Dismiss")
  await open(optional)
  await admit(optional, "wizard-optional")
  await dock.waitFor()
  await dock.getByRole("button", { name: "Skip", exact: true }).click()
  await dock.getByText("2/3", { exact: true }).waitFor()
  await dock.getByRole("button", { name: "Dismiss", exact: true }).click()
  await idle(optional)
  assert.deepEqual(
    (await history(optional))
      .flatMap((row) => row.parts)
      .find((part) => part.type === "tool" && part.tool === "question")?.state.metadata.answers,
    [[], [], []],
  )
  check("Skip advances with an empty answer and optional Dismiss resolves every preference as unanswered")

  const required = await create("QA required Dismiss")
  await open(required)
  await admit(required, "wizard-required")
  await dock.waitFor()
  assert.equal((await engine("/question")).find((request) => request.sessionID === required.id).isBlocking, true)
  await dock.getByRole("button", { name: "Dismiss", exact: true }).click()
  await eventually(
    async () =>
      !(await engine("/question")).some((request) => request.sessionID === required.id) &&
      (await call("runs.get", { sessionID: required.id })).paused,
    "Required dismissal did not stop its chat",
  )
  check("Required Dismiss stops the owning chat instead of answering or starting queued work")

  const requiredStorage = await create("QA required Dismiss storage failure")
  await open(requiredStorage)
  await admit(requiredStorage, "wizard-required")
  await dock.waitFor()
  await admit(requiredStorage, "required-dismiss-queued-follow-up")
  const journalTemporary = join(data, "chat-runs.json.tmp")
  await mkdir(journalTemporary)
  try {
    await dock.getByRole("button", { name: "Dismiss", exact: true }).click()
    await page.getByText("Request failed", { exact: true }).waitFor()
    await eventually(
      async () => !(await engine("/question")).some((request) => request.sessionID === requiredStorage.id),
      "Required Dismiss left its provider waiting after a journal failure",
    )
    assert.notEqual((await engine("/session/status"))[requiredStorage.id]?.type, "busy")
    const run = await call("runs.get", { sessionID: requiredStorage.id })
    assert.equal(run.paused, true)
    assert.equal(run.awaiting, false)
    assert.ok(
      run.queue.some((item) => item.prompt.text === "required-dismiss-queued-follow-up" && item.sentAt === undefined),
    )
    assert.ok(!requests.some((request) => request.latest.includes("required-dismiss-queued-follow-up")))
  } finally {
    await rmdir(journalTemporary)
  }
  await call("runs.stop", { sessionID: requiredStorage.id })
  check(
    "Required Dismiss interrupts its provider despite a journal failure, exposes the error and preserves queued work",
  )
  const expectedFailure = page.locator('[data-component="toast"], .toast-v2').filter({ hasText: "Request failed" })
  if (await expectedFailure.count()) {
    await expectedFailure.first().getByRole("button", { name: "Dismiss", exact: true }).click()
    await expectedFailure.first().waitFor({ state: "hidden" })
  }

  const tools = await create("QA tiny tool presentation")
  await open(tools)
  await call("access.set", { sessionID: tools.id, mode: "full" })
  for (const marker of ["read-file", "edit-file", "patch-file", "view-recorded-png"]) {
    await admit(
      tools,
      marker,
      marker === "patch-file"
        ? { prompt: { model: { providerID: "interaction-qa", modelID: "gpt-5.6-fixture" } } }
        : {},
    )
    await idle(tools)
    await snapshot(marker)
  }
  assert.equal(await readFile(textPath, "utf8"), "Patched fixture\n")
  const toolParts = (await history(tools)).flatMap((row) => row.parts).filter((part) => part.type === "tool")
  assert.ok(
    ["read", "edit", "apply_patch"].every((name) =>
      toolParts.some((part) => part.tool === name && part.state.status === "completed"),
    ),
  )
  await main().getByAltText("recorded-image.png").last().waitFor()
  await writeFile(pngPath, "File changed after the recorded read")
  assert.ok((await main().getByAltText("recorded-image.png").last().getAttribute("src")).includes(png))
  check("Read, Edit, Apply patch and Viewed image use real engine results; the image keeps its recorded bytes")

  const answer = (await history(tools)).findLast((row) => row.info.role === "assistant")
  const text = answer.parts.find((part) => part.type === "text")
  await engine(`/session/${tools.id}/message/${answer.info.id}/part/${text.id}`, "PATCH", {
    ...text,
    metadata: {
      ...text.metadata,
      sources: [
        {
          id: "qa-source",
          sourceType: "url",
          title: "Recorded QA source",
          url: `http://127.0.0.1:${fixture.address().port}/source`,
        },
        { id: "qa-document", sourceType: "document", filename: "Saved report.pdf" },
      ],
    },
  })
  const sources = main().locator('[data-component="message-sources"]').last()
  await sources.getByRole("button").filter({ hasText: "Recorded QA source" }).waitFor()
  await snapshot("sources")
  await sources.getByRole("button").filter({ hasText: "Recorded QA source" }).click()
  await eventually(
    async () =>
      (await call("browser.list")).some(
        (row) =>
          row.sessionID === tools.id &&
          row.url.includes("/source") &&
          !row.loading &&
          row.title === "Recorded QA source",
      ),
    "Recorded citation did not open its in-app browser",
  )
  await page.locator(".bb-panel-tabs").getByRole("tab", { name: "Recorded QA source", exact: true }).waitFor()
  const sourceBrowser = (await call("browser.list")).find(
    (row) => row.sessionID === tools.id && row.url.includes("/source"),
  )
  assert.ok((await call("browser.inspect", { id: sourceBrowser.id })).page.text.includes("Recorded reference view"))
  for (const row of await call("browser.list")) await call("browser.close", { id: row.id })
  check(
    "Recorded URL/document source pills open the source inside the owning chat; native source projection uses a controlled recorded fixture",
  )

  const lateSource = hold("delayed-source")
  await engine(`/session/${tools.id}/message/${answer.info.id}/part/${text.id}`, "PATCH", {
    ...text,
    metadata: {
      ...text.metadata,
      sources: [
        {
          id: "delayed-source",
          sourceType: "url",
          title: "Delayed QA source",
          url: `http://127.0.0.1:${fixture.address().port}/delayed-source`,
        },
      ],
    },
  })
  await sources.getByRole("button").filter({ hasText: "Delayed QA source" }).click()
  await eventually(() => lateSource.entered, "Delayed source did not start loading")
  const otherSourceChat = await create("QA source navigation ownership")
  await open(otherSourceChat)
  await open(tools)
  lateSource.release.resolve()
  await eventually(
    async () => !(await call("browser.list")).length,
    "Late source leaked a browser after A → B → A navigation",
  )
  assert.equal(await main().getAttribute("data-bb-chat"), tools.id)
  assert.equal(
    await page.locator(".bb-panel-tabs").getByRole("tab", { name: "Recorded QA source", exact: true }).count(),
    0,
  )
  check(
    "A delayed source opened before A → B → A navigation releases its native browser instead of attaching to the later visit",
  )

  // Copy stays in an owned renderer buffer. Never touch the player's clipboard.
  await page.evaluate(() => {
    const original = document.execCommand.bind(document)
    document.execCommand = (command, ...args) => {
      if (command === "copy") {
        window.__qaCopiedText = document.activeElement?.value
        return true
      }
      return original(command, ...args)
    }
  })
  const response = main().locator('[data-component="text-part"]').last()
  await response.hover()
  await response.getByRole("button", { name: "Copy response", exact: true }).click()
  assert.equal(await page.evaluate(() => window.__qaCopiedText), text.text)
  await response.hover()
  await snapshot("hover-response")
  await response.getByRole("button", { name: "Branch in new chat", exact: true }).click()
  await eventually(
    async () => (await main().getAttribute("data-bb-chat")) !== tools.id,
    "Hover branch did not navigate",
  )
  const branched = await main().getAttribute("data-bb-chat")
  assert.equal((await call("access.get", { sessionID: branched })).mode, "full")
  const branchRows = await engine(`/session/${branched}/message`)
  assert.ok(branchRows.some((row) => row.parts.some((part) => part.type === "text" && part.text === text.text)))
  assert.ok(branchRows.filter((row) => row.info.role === "user").every((row) => !row.info.execution))
  assert.equal((await call("runs.get", { sessionID: branched })).goal, undefined)
  check(
    "Response hover exposes Copy and inclusive Branch; branching preserves access and drops execution/Goal ownership",
  )

  const parent = await create("QA diagnostic parent Goal")
  await open(parent)
  await call("access.set", { sessionID: parent.id, mode: "full" })
  const parentHold = hold("main-goal-active")
  await admit(parent, "main-goal-active: build the original fixture", {
    prompt: { goal: true },
    minActiveDurationMs: 36000000,
  })
  await eventually(() => parentHold.entered, "Parent Goal not active")
  const parentGoalID = (await call("runs.get", { sessionID: parent.id })).goal.id
  await page.evaluate(() => {
    window.__qaMainRoot = document.querySelector(".bb-workspace-chat")
    window.__qaMainEditor = window.__qaMainRoot.querySelector("[contenteditable=true]")
    window.__qaMainTrace = []
    window.__qaMainObserver = new MutationObserver(() => {
      if (!window.__qaMainRoot.isConnected || !window.__qaMainEditor.isConnected)
        window.__qaMainTrace.push({
          time: performance.now(),
          root: window.__qaMainRoot.isConnected,
          editor: window.__qaMainEditor.isConnected,
        })
    })
    window.__qaMainObserver.observe(document.body, { subtree: true, childList: true })
  })
  const topTabs = await page.locator("[data-titlebar-tab]").count()
  const terminalCount = (await engine("/pty")).length
  await snapshot("side-before")
  await editor().fill("/side")
  await editor().press("Enter")
  await page.locator(".bb-embedded-chat [contenteditable=true]").first().waitFor()
  await snapshot("side-open")
  assert.equal(await page.locator("[data-titlebar-tab]").count(), topTabs)
  const sideID = await page.locator(".bb-embedded-chat [data-bb-chat]").getAttribute("data-bb-chat")
  const side = { id: sideID }
  assert.equal((await call("runs.get", { sessionID: sideID })).goal, undefined)
  await call("access.set", { sessionID: sideID, mode: "full" })
  await page
    .locator(".bb-embedded-chat [contenteditable=true]")
    .first()
    .fill("diagnostic-progress: what is taking the parent so long?")
  await page.locator(".bb-embedded-chat [contenteditable=true]").first().press("Enter")
  await idle(side)
  const sideRequest = requests.find((row) => row.latest.includes("diagnostic-progress"))
  assert.ok(sideRequest)
  assert.deepEqual(
    sideRequest.input.tools.map((tool) => tool.function.name).sort(),
    ["glob", "grep", "parent_progress", "read"].sort(),
  )
  const progress = await call("side.progress", { sessionID: sideID })
  assert.equal(progress.parentID, parent.id)
  assert.equal(progress.phase, "busy")
  assert.ok(progress.objective.includes("main-goal-active"))
  await assert.rejects(call("runs.goal-draft", { sessionID: sideID, enabled: true }), /sideReadOnly/)
  const denied = await fetch(server.url + `/session/${sideID}/shell`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: "build",
      model: { providerID: "interaction-qa", modelID: "fixture" },
      command: "echo forbidden",
    }),
  })
  assert.ok(!denied.ok, "A diagnostic must refuse direct shell execution even under Full access")
  assert.equal((await engine("/session/status"))[parent.id]?.type, "busy")
  assert.equal((await call("runs.get", { sessionID: parent.id })).goal.id, parentGoalID)
  await page.locator(".bb-panel-tabs").getByRole("button", { name: "Close tab", exact: true }).first().click()
  await page.locator(".bb-embedded-chat").waitFor({ state: "detached" })
  await eventually(
    async () => Boolean((await engine(`/session/${sideID}`)).time.archived),
    "Temporary diagnostic not archived",
  )
  check(
    "/side keeps the parent mounted, inherits no Goal, offers only read-only diagnostic tools, and closes only its owned child",
  )

  const cdp = await page.context().newCDPSession(page)
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage")
    return (await cdp.send("Runtime.getHeapUsage")).usedSize
  }
  const cycles = Number(process.env.BB_QA_SIDE_CYCLES || 100)
  assert.ok(Number.isInteger(cycles) && cycles >= 10 && cycles <= 1000)
  const samples = [],
    started = Date.now()
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.__qaPaintTrace = { frames: 0, blackMainFrames: 0 }
    window.__qaPaintListener = (_, dirty, image) => {
      const size = image.getSize(),
        bitmap = image.getBitmap(),
        scale = size.width / 1280
      const points = [
        [90, 130],
        [90, 300],
        [120, 600],
        [560, 600],
      ]
      if (size.height < 610 * scale) return
      window.__qaPaintTrace.frames++
      if (
        points.every(([x, y]) => {
          const offset = (Math.floor(y * scale) * size.width + Math.floor(x * scale)) * 4
          return bitmap[offset] < 16 && bitmap[offset + 1] < 16 && bitmap[offset + 2] < 16
        })
      )
        window.__qaPaintTrace.blackMainFrames++
    }
    window.webContents.on("paint", window.__qaPaintListener)
  })
  for (let cycle = 0; cycle < cycles; cycle++) {
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:side-chat", { detail })), {
      source: parent.id,
      directory,
      variant: null,
    })
    await page.locator(".bb-embedded-chat [contenteditable=true]").first().waitFor()
    await page.locator(".bb-panel-tabs").getByRole("button", { name: "Close tab", exact: true }).first().click()
    await page.locator(".bb-embedded-chat").waitFor({ state: "detached" })
    if (cycle === 9 || cycle === cycles - 1)
      samples.push({
        cycle: cycle + 1,
        heap: await heap(),
        native: await app.evaluate(({ app, BrowserWindow, webContents }) => ({
          processes: app.getAppMetrics().length,
          windows: BrowserWindow.getAllWindows().length,
          webContents: webContents.getAllWebContents().length,
        })),
      })
    if ((cycle + 1) % 20 === 0) {
      await hidden()
      console.log("SIDE CYCLES", cycle + 1)
    }
  }
  assert.equal(await page.locator("[data-titlebar-tab]").count(), topTabs)
  assert.equal((await engine("/pty")).length, terminalCount)
  assert.deepEqual(await page.evaluate(() => window.__qaMainTrace), [])
  assert.ok(
    await page.evaluate(
      () =>
        window.__qaMainRoot === document.querySelector(".bb-workspace-chat") &&
        window.__qaMainEditor === window.__qaMainRoot.querySelector("[contenteditable=true]"),
    ),
  )
  await page.evaluate(() => window.__qaMainObserver.disconnect())
  assert.ok(samples.at(-1).heap - samples[0].heap < 64 * 1024 * 1024, JSON.stringify(samples))
  assert.deepEqual(samples.at(-1).native, samples[0].native)
  assert.equal((await engine("/session/status"))[parent.id]?.type, "busy")
  const paints = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.removeListener("paint", window.__qaPaintListener)
    return window.__qaPaintTrace
  })
  assert.ok(paints.frames > 0)
  assert.equal(paints.blackMainFrames, 0)
  report.observations.push({
    sideCycles: cycles,
    elapsedMs: Date.now() - started,
    samples,
    fullMainUnmounts: 0,
    duplicateTopTabs: 0,
    extraTerminals: 0,
    softwarePaints: paints,
  })
  await snapshot("side-after-cycles")
  check(
    `${cycles} side open/close cycles retain the parent root, stable native/process/terminal counts and bounded retained heap`,
  )

  const elapsedBefore = await main().locator(".bb-goal-stat").innerText()
  try {
    await page.evaluate(() => {
      window.__qaDateNow = Date.now
      Date.now = () => window.__qaDateNow() + 36000000
    })
    // Force a real event flush while the wall clock is ahead. After restoring
    // it, incoming messages/questions must still arrive, not wait ten hours.
    await engine(`/session/${parent.id}`, "PATCH", { title: "QA parent clock probe" })
    await main().getByText("QA parent clock probe", { exact: true }).first().waitFor()
    await delay(2200)
    const elapsedAfter = await main().locator(".bb-goal-stat").innerText()
    assert.ok(
      Math.abs(Number(elapsedAfter.match(/(\d+) min/)?.[1]) - Number(elapsedBefore.match(/(\d+) min/)?.[1])) <= 1,
      `Goal clock jumped with wall time: ${elapsedBefore} -> ${elapsedAfter}`,
    )
    report.observations.push({ rendererWallClockJumpMs: 36000000, elapsedBefore, elapsedAfter })
  } finally {
    await page.evaluate(() => {
      Date.now = window.__qaDateNow
      delete window.__qaDateNow
    })
  }
  check("The Goal display uses monotonic active time through a ten-hour wall-clock jump")

  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:run-panel", { detail })), {
    sessionID: parent.id,
    kind: "goal",
  })
  const goalPanel = page.locator(".bb-run-panel")
  await goalPanel.locator("textarea").waitFor()
  await goalPanel.locator("textarea").fill("Review the parent fixture without discarding its minimum")
  await goalPanel.getByRole("button", { name: "Save", exact: true }).click()
  await eventually(
    async () => (await call("runs.get", { sessionID: parent.id })).goal.objective.startsWith("Review the parent"),
    "Goal edit not saved",
  )
  assert.equal((await call("runs.get", { sessionID: parent.id })).goal.minActiveDurationMs, 36000000)
  await snapshot("goal-editor-light")
  await page.evaluate(() => {
    localStorage.setItem("opencode-color-scheme", "dark")
    window.dispatchEvent(new StorageEvent("storage", { key: "opencode-color-scheme", newValue: "dark" }))
  })
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "dark")
  await snapshot("goal-editor-dark")
  await hidden()
  check("Goal editor saves objective and minimum, retains its identity, and renders in light and dark themes")

  const preference = await create("QA optional timer preference")
  await open(preference)
  await admit(preference, "wizard-optional")
  await dock.waitFor()
  const pendingPreference = (await engine("/question")).find((request) => request.sessionID === preference.id)
  await call("question.activity", {
    requestID: pendingPreference.id,
    sessionID: preference.id,
    directory,
    kind: "background",
  })
  const configuration = await readFile(join(data, "config/opencode/opencode.json"), "utf8")
  await call("settings.save", { questionAutoResolve: false })
  assert.equal(await readFile(join(data, "config/opencode/opencode.json"), "utf8"), configuration)
  assert.equal(
    (await engine("/question")).find((request) => request.id === pendingPreference.id)?.autoResolution.phase,
    "disabled",
  )
  assert.equal((await engine("/session/status"))[parent.id]?.type, "busy")
  await call("settings.save", { questionAutoResolve: true })
  assert.equal(
    (await engine("/question")).find((request) => request.id === pendingPreference.id)?.autoResolution.phase,
    "countdown",
  )
  await dock.getByRole("button", { name: "Dismiss", exact: true }).click()
  await idle(preference)
  check(
    "Optional timer settings update the same pending request without rewriting engine configuration or interrupting the parent",
  )

  const available = createServer()
  await new Promise((done) => available.listen(0, "127.0.0.1", done))
  const port = available.address().port
  await new Promise((done) => available.close(done))
  await call("mobile.enable", { port })
  const invitation = await call("mobile.pair")
  browser = await chromium.launch({ headless: true, channel: "msedge" })
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
  })
  const phone = await context.newPage()
  phone.on("pageerror", (error) => report.errors.push(error.message))
  await phone.goto(`https://127.0.0.1:${port}/#pair=${invitation.token}`)
  await phone.getByRole("button", { name: "Pair a phone", exact: true }).click()
  await eventually(async () => {
    const state = await call("mobile.state")
    if (!state.requests.length) return false
    await call("mobile.approve", { id: state.requests[0].id })
    return true
  }, "Pairing was not requested")
  await phone.locator("#app").waitFor({ state: "visible" })
  const phoneChat = await create("QA paired question wizard")
  await admit(phoneChat, "wizard-optional")
  await phone.evaluate((id) => localStorage.setItem("bb.session", id), phoneChat.id)
  await phone.reload()
  const phoneDock = phone.locator(".question-wizard")
  await phoneDock.waitFor()
  await phoneDock.getByText("1/3", { exact: true }).waitFor()
  await phone.screenshot({ path: join(results, reportName + "-phone-question-dark.png") })
  await phoneDock.getByRole("radio").filter({ hasText: "Compact" }).click()
  await phoneDock.getByText("2/3", { exact: true }).waitFor()
  await phoneDock.getByRole("checkbox").filter({ hasText: "Reliability" }).click()
  await phone.reload()
  await phoneDock.getByText("2/3", { exact: true }).waitFor()
  assert.equal(
    await phoneDock.getByRole("checkbox").filter({ hasText: "Reliability" }).getAttribute("aria-checked"),
    "true",
  )
  let rejectedReply = false
  await phone.route("**/api", async (route) => {
    if (
      !rejectedReply &&
      route.request().method() === "POST" &&
      route.request().postDataJSON()?.method === "question"
    ) {
      rejectedReply = true
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"Controlled reply failure"}',
      })
      return
    }
    await route.continue()
  })
  await phoneDock.getByRole("button", { name: "Next", exact: true }).last().click()
  await phoneDock.getByText("3/3", { exact: true }).waitFor()
  await phoneDock.getByRole("button", { name: "Skip", exact: true }).click()
  await phone.getByText("Controlled reply failure", { exact: true }).waitFor()
  assert.ok((await engine("/question")).some((request) => request.sessionID === phoneChat.id))
  await phone.reload()
  await phoneDock.getByText("3/3", { exact: true }).waitFor()
  await phoneDock.getByRole("button", { name: "Skip", exact: true }).click()
  await idle(phoneChat)
  assert.deepEqual(
    (await history(phoneChat))
      .flatMap((row) => row.parts)
      .find((part) => part.type === "tool" && part.tool === "question")?.state.metadata.answers,
    [["Compact (Recommended)"], ["Reliability"], []],
  )
  await phone.unroute("**/api")
  check(
    "Paired phone wizard retains multi-choice drafts through reload and a failed reply; explicit retry sends exact answers once",
  )

  const damaged = await create("QA damaged phone question cache")
  await admit(damaged, "wizard-optional")
  await eventually(
    async () => (await engine("/question")).some((request) => request.sessionID === damaged.id),
    "Damaged-cache question was not registered",
  )
  const damagedRequest = (await engine("/question")).find((request) => request.sessionID === damaged.id)
  await phone.evaluate(
    ({ sessionID, requestID }) => {
      localStorage.setItem("bb.session", sessionID)
      localStorage.setItem(
        `bb.question.${sessionID}.${requestID}`,
        '{"tab":999,"answers":"damaged","custom":[1],"customOn":"damaged"}',
      )
    },
    { sessionID: damaged.id, requestID: damagedRequest.id },
  )
  await phone.reload()
  await phoneDock.getByText("3/3", { exact: true }).waitFor()
  await phoneDock.getByRole("button", { name: "Dismiss", exact: true }).click()
  await idle(damaged)
  assert.deepEqual(
    (await history(damaged))
      .flatMap((row) => row.parts)
      .find((part) => part.type === "tool" && part.tool === "question")?.state.metadata.answers,
    [[], [], []],
  )
  check("Damaged optional phone question state is sanitized without losing the pending request or breaking chat")
  await browser.close()
  browser = undefined

  const expiry = await create("QA real optional expiry")
  await open(expiry)
  await admit(expiry, "optional-expiry", { prompt: { goal: true }, minActiveDurationMs: 100000 })
  await dock.waitFor()
  const expiryID = (await engine("/question")).find((request) => request.sessionID === expiry.id).id
  await call("question.activity", { requestID: expiryID, sessionID: expiry.id, directory, kind: "background" })
  const expiryRequest = (await engine("/question")).find((request) => request.id === expiryID)
  assert.equal(expiryRequest.autoResolution.phase, "countdown")
  assert.equal(await dock.getByRole("timer").count(), 0)
  await snapshot("optional-before-counter")
  await eventually(
    async () => (await dock.getByRole("timer").count()) === 1,
    "Countdown did not appear in its final minute",
    40000,
  )
  await snapshot("optional-counter-dark")
  await eventually(
    async () => !(await engine("/question")).some((request) => request.id === expiryRequest.id),
    "Optional timer did not resolve",
    65000,
  )
  await idle(expiry)
  const expiredPart = (await history(expiry))
    .flatMap((row) => row.parts)
    .find((part) => part.type === "tool" && part.tool === "question")
  assert.deepEqual(expiredPart.state.metadata.answers, [[]])
  const durationGoal = (await call("runs.get", { sessionID: expiry.id })).goal
  assert.ok(durationGoal.activeTimeMs < 10000, "Question wait was counted as active work: " + durationGoal.activeTimeMs)
  const completion = await call("runs.goal-progress", {
    sessionID: expiry.id,
    goalID: durationGoal.id,
    status: "complete",
    evidence: "Fixture completed",
  })
  assert.equal(completion.completionDenied, true)
  report.observations.push({
    optionalExpiryElapsedMs: Date.now() - (expiryRequest.autoResolution.expiresAt - 90000),
    activeWorkMs: durationGoal.activeTimeMs,
    minimumMs: durationGoal.minActiveDurationMs,
  })
  check(
    "A real 90-second background timer shows only its last minute, resolves empty answers, and cannot satisfy active Goal time",
  )

  await call("runs.stop", { sessionID: parent.id })
  parentHold.release.resolve()

  await hidden()
  assert.equal(report.errors.length, 0, report.errors.join("\n"))
} catch (error) {
  report.failure = String(error)
  console.error("FAIL", error)
  process.exitCode = 1
  if (page) {
    console.log((await page.locator("body").innerText()).slice(-2400))
    await snapshot?.("failure").catch(() => {})
  }
} finally {
  for (const value of holds.values()) value.release.resolve()
  report.observations.push({ providerRequests: requests.length })
  await writeFile(join(results, reportName + ".json"), JSON.stringify(report, null, 2))
  await browser?.close()
  await app.close()
  fixture.closeAllConnections()
  fixture.close()
}
