import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/todo-polish-" + randomUUID())
const data = join(profile, "BitsBytesChat")
const directory = join(data, "workspace")
const report = { checks: [], errors: [], observations: [] }
const requests = []
const holds = new Map()
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const longPlan =
  "# Bounded plan\n\n" +
  Array.from({ length: 100 }, (_, i) => `${i + 1}. Verify step ${i + 1} with concrete evidence.`).join("\n")
const pngPath = join(directory, "recorded-image.png")
const mcpPath = join(data, "custom-mcp-fixture.cjs")
const fixture = createServer(async (req, res) => {
  let body = ""
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body || "{}")
  const users = (input.messages ?? []).filter((row) => row.role === "user")
  const latest = JSON.stringify(users.at(-1)?.content ?? "")
  requests.push({ input, latest, at: Date.now() })
  const hasTool = input.messages?.at(-1)?.role === "tool"
  const held = [...holds].find(
    ([marker, hold]) => latest.includes(marker) && !hold.entered && (!hold.afterTool || hasTool),
  )
  if (held) {
    held[1].entered = true
    await held[1].release.promise
  }
  if (res.destroyed) return
  const named = (suffix) => input.tools?.find((tool) => tool.function?.name.endsWith(suffix))?.function.name
  const calls = []
  let text = "Fixture completed: " + latest.slice(0, 120)
  if (latest.includes("long-plan")) text = `<proposed_plan>\n${longPlan}\n</proposed_plan>`
  if (latest.includes("view-png") && !hasTool && named("read"))
    calls.push({ name: named("read"), args: { filePath: pngPath } })
  if (latest.includes("custom-mcp-ping") && !hasTool && named("qa_ping"))
    calls.push({ name: named("qa_ping"), args: {} })
  if (latest.includes("stress-initial") && !hasTool && named("todowrite"))
    calls.push({
      name: named("todowrite"),
      args: {
        todos: [
          { content: "Inspect the controlled combined state", status: "in_progress", priority: "high" },
          { content: "Verify queue and Plan identity", status: "pending", priority: "medium" },
        ],
      },
    })
  if (latest.includes("finish-goal") && !hasTool && named("goal_progress"))
    calls.push({
      name: named("goal_progress"),
      args: {
        status: "complete",
        reason: "Fixture complete",
        evidence: "The controlled local response completed this test objective.",
      },
    })
  res.writeHead(200, { "content-type": "text/event-stream" })
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
  else emit({ content: text })
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
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(
  pngPath,
  // Validated 8×8 RGB PNG; malformed image data is intentionally omitted by the engine.
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGNUSFjAgA0wYRUdtBIA5UgBMGHyow0AAAAASUVORK5CYII=",
    "base64",
  ),
)
await writeFile(
  mcpPath,
  `const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const input = JSON.parse(line); if (input.id === undefined) return;
  const result = input.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "todo-qa-custom", version: "1" } }
    : input.method === "tools/list" ? { tools: [{ name: "qa_ping", description: "Controlled local QA ping", inputSchema: { type: "object", properties: {} } }] }
    : input.method === "tools/call" ? { content: [{ type: "text", text: "QA pong" }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }) + "\\n");
});`,
)
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    model: "todo-qa/fixture",
    provider: {
      "todo-qa": {
        name: "Local todo QA",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:" + fixture.address().port + "/v1", apiKey: "fixture-only" },
        models: {
          fixture: {
            name: "Todo fixture",
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
  env: { ...process.env, BB_QA_ISOLATED: "1", LOCALAPPDATA: profile },
  timeout: 90000,
})
let page
const check = (label) => {
  report.checks.push(label)
  console.log("PASS", label)
}
try {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.setBackgroundThrottling(false)
      window.hide()
    }),
  )
  page = await app.firstWindow()
  page.setDefaultTimeout(30000)
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
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    })
    assert.ok(response.ok, path + " " + response.status)
    return response.status === 204 ? undefined : response.json()
  }
  const create = (title) => engine("/session", "POST", { title })
  const open = async (session) => {
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), {
      directory,
      sessionID: session.id,
    })
    await page.locator(`.bb-workspace-chat[data-bb-chat="${session.id}"] [contenteditable=true]`).first().waitFor()
  }
  const main = () => page.locator(".bb-workspace-chat")
  const editor = () => main().locator("[contenteditable=true]").first()
  const id = () =>
    "msg_" +
    ((BigInt(Date.now()) * 4096n) & 0xffffffffffffn).toString(16).padStart(12, "0") +
    randomUUID().replaceAll("-", "").slice(0, 14)
  const admit = (session, text, extra = {}) =>
    call("runs.admit", {
      delivery: "queue",
      ...extra,
      prompt: {
        sessionID: session.id,
        directory,
        id: id(),
        protocol: "v1",
        text,
        agent: "build",
        model: { providerID: "todo-qa", modelID: "fixture" },
        legacyParts: [{ type: "text", text }],
        ...extra.prompt,
      },
    })
  const eventually = async (predicate, label) => {
    for (let i = 0; i < 200; i++) {
      if (await predicate()) return
      await delay(100)
    }
    throw Error(label)
  }
  const idle = (session) =>
    eventually(async () => {
      const run = await call("runs.get", { sessionID: session.id })
      const status = await engine("/session/status")
      return run.last && !run.queue.length && !run.awaiting && status[session.id]?.type !== "busy"
    }, "Session did not settle: " + session.id)
  const hold = (marker, afterTool = false) => {
    const value = { entered: false, afterTool, release: Promise.withResolvers() }
    holds.set(marker, value)
    return value
  }
  const alive = async (label) => {
    await page.keyboard.press("Control+w")
    await delay(150)
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length,
      ),
      1,
    )
    check(label)
  }

  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()), null)
  await alive("Ctrl+W leaves the native window alive with no document tab")
  const chat = await create("QA todo controls")
  await open(chat)
  await alive("Ctrl+W leaves the native window alive in a chat composer")
  await page.locator(".bb-nav [aria-label=Settings]").click()
  await alive("Ctrl+W leaves the native window alive while Settings suspends chat commands")
  await page.getByRole("tab", { name: "Tools & permissions", exact: true }).click()
  const mcp = page.locator(".bb-mcp-settings")
  await mcp.waitFor()
  await mcp.getByLabel("Name", { exact: true }).fill("qa_custom")
  await mcp.getByLabel("Server configuration (JSON)", { exact: true }).fill(
    JSON.stringify({
      type: "local",
      command: [process.execPath, mcpPath],
      enabled: true,
      environment: { QA_SECRET: "synthetic-secret-only" },
    }),
  )
  await mcp.getByRole("button", { name: "Save", exact: true }).click()
  await mcp.getByText("Connected", { exact: true }).waitFor()
  const custom = (await call("mcp.settings.list")).servers.find((row) => row.name === "qa_custom")
  assert.ok(custom.config.environment.QA_SECRET.startsWith("<stored:"))
  const savedConfig = JSON.parse(await readFile(join(data, "config/opencode/opencode.json"), "utf8"))
  assert.equal(savedConfig.mcp.qa_custom.environment.QA_SECRET, "synthetic-secret-only")
  assert.ok(savedConfig.mcp["bitsbytes-local"] && savedConfig.provider["todo-qa"])
  const customToolChat = await create("QA custom MCP tool invocation")
  await call("access.set", { sessionID: customToolChat.id, mode: "full" })
  await admit(customToolChat, "custom-mcp-ping")
  await idle(customToolChat)
  assert.ok(
    (await engine("/session/" + customToolChat.id + "/message"))
      .flatMap((message) => message.parts)
      .some(
        (part) =>
          part.type === "tool" &&
          part.tool.endsWith("qa_ping") &&
          part.state.status === "completed" &&
          part.state.output.includes("QA pong"),
      ),
    "A saved custom MCP must be callable through the actual engine tool pipeline",
  )
  await mcp
    .getByLabel("Server configuration (JSON)", { exact: true })
    .fill(JSON.stringify({ ...custom.config, enabled: false }))
  await mcp.getByRole("button", { name: "Save", exact: true }).click()
  await mcp.getByText("Disabled", { exact: true }).waitFor()
  await mcp.getByRole("button", { name: "Remove MCP server", exact: true }).click()
  await eventually(
    async () => !(await call("mcp.settings.list")).servers.some((row) => row.name === "qa_custom"),
    "Custom MCP removal did not persist",
  )
  assert.ok(
    !Object.hasOwn(JSON.parse(await readFile(join(data, "config/opencode/opencode.json"), "utf8")).mcp, "qa_custom"),
  )
  check(
    "Custom MCP Settings connects and invokes a real local stdio fixture, hides/preserves secrets, disables and removes durably",
  )
  await page.keyboard.press("Escape")
  // Ctrl+W may correctly close a chat tab; the native window must remain.
  await open(chat)

  const slow = hold("queue-hold")
  await editor().fill("queue-hold")
  await editor().press("Enter")
  await eventually(() => slow.entered, "Held provider was not entered")
  await editor().fill("queued editable source")
  await editor().press("Enter")
  const row = page.locator(".bb-queue-row").filter({ hasText: "queued editable source" })
  await row.waitFor()
  const bounds = await page.locator(".bb-run-queue").boundingBox()
  assert.ok(bounds.width <= 521 && bounds.height < 150, JSON.stringify(bounds))
  await page.screenshot({ path: join(root, ".tools/qa/results/todo-queue.png") })
  await editor().fill("Unsent draft before editing")
  await row.getByRole("button", { name: "Queued message actions" }).click()
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
  await eventually(
    async () => (await editor().innerText()) === "queued editable source",
    "Edit did not restore the composer",
  )
  assert.equal(await row.count(), 0)
  assert.ok((await call("runs.get", { sessionID: chat.id })).queue.some((item) => item.editing))
  await page.getByRole("button", { name: "Cancel edit", exact: true }).click()
  await row.waitFor()
  assert.equal(await editor().innerText(), "Unsent draft before editing")
  await editor().fill("")
  await row.getByRole("button", { name: "Queued message actions" }).click()
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
  await eventually(
    async () => (await editor().innerText()) === "queued editable source",
    "Second edit did not reach the composer",
  )
  await page.reload()
  await page.locator("[contenteditable=true]").first().waitFor({ timeout: 90000 })
  await open(chat)
  await page.getByRole("button", { name: "Cancel edit", exact: true }).waitFor()
  await page.getByRole("button", { name: "Cancel edit", exact: true }).click()
  await row.waitFor()
  assert.notEqual(
    await editor().innerText(),
    "queued editable source",
    "Recovered Cancel must not duplicate its queue row in the composer",
  )
  await row.getByRole("button", { name: "Queued message actions" }).click()
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
  await eventually(
    async () => (await editor().innerText()) === "queued editable source",
    "Recovered row could not be edited again",
  )
  await page.reload()
  await page.locator("[contenteditable=true]").first().waitFor({ timeout: 90000 })
  await open(chat)
  await page.getByRole("button", { name: "Cancel edit", exact: true }).waitFor()
  await editor().fill("Independent recovered draft")
  await page.getByRole("button", { name: "Cancel edit", exact: true }).click()
  await row.waitFor()
  assert.equal(await editor().innerText(), "Independent recovered draft")
  await editor().fill("")
  await row.getByRole("button", { name: "Queued message actions" }).click()
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
  await eventually(
    async () => (await editor().innerText()) === "queued editable source",
    "Queue row could not be edited after preserving an independent draft",
  )
  await editor().fill("edited source sent once")
  await editor().press("Enter")
  slow.release.resolve()
  await idle(chat)
  const history = await engine("/session/" + chat.id + "/message")
  assert.equal(
    history.filter(
      (row) =>
        row.info.role === "user" &&
        row.parts.some((part) => part.type === "text" && part.text === "edited source sent once"),
    ).length,
    1,
  )
  check(
    "Queue is bounded; Edit hides its row, Cancel preserves prior drafts, recovered Cancel avoids duplicates, and Send promotes once",
  )

  const topTabs = await page.locator("[data-titlebar-tab]").count()
  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:side-chat", { detail })), {
    source: chat.id,
    directory,
    variant: null,
  })
  await page.locator(".bb-embedded-chat").waitFor()
  assert.equal(await page.locator("[data-titlebar-tab]").count(), topTabs)
  await page.locator(".bb-embedded-chat [contenteditable=true]").first().focus()
  await alive("Opening a side chat adds no duplicate top tab and Ctrl+W keeps the window alive")
  await page.locator(".bb-panel-tabs").getByRole("button", { name: "Close tab", exact: true }).first().click()

  await main().getByRole("button", { name: "More options", exact: true }).last().click()
  await page.getByRole("menuitem", { name: "Fork from message", exact: true }).click()
  await page.getByRole("dialog").waitFor()
  assert.ok((await page.getByRole("dialog").innerText()).includes("Fork"))
  await alive("Persistent Fork is offered in More options; Ctrl+W leaves its modal alive")
  await page.getByRole("dialog").locator('[data-slot="list-item"][data-key]').first().click()
  await eventually(async () => {
    const current = await main().getAttribute("data-bb-chat")
    return current && current !== chat.id
  }, "Selecting a fork boundary did not open a new chat")
  const forkedID = await main().getAttribute("data-bb-chat")
  assert.ok((await engine("/session/" + forkedID)).id === forkedID)
  assert.equal(await page.locator(".bb-embedded-chat").count(), 0)
  check("Selecting Fork from message opens a durable independent main chat")
  await open(chat)

  await admit(chat, "long-plan", { prompt: { mode: "plan", agent: "plan" } })
  await idle(chat)
  const plan = main().locator("[data-component=proposed-plan]").last()
  await plan.waitFor()
  await plan.locator("summary").click()
  const body = plan.locator(".bb-proposed-plan-body")
  const bounded = await body.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    full: node.scrollHeight,
    max: Math.min(280, innerHeight * 0.35),
  }))
  assert.ok(bounded.height <= bounded.max + 1 && bounded.full > bounded.height, JSON.stringify(bounded))
  await page.screenshot({ path: join(root, ".tools/qa/results/todo-plan.png") })
  await plan.getByRole("button", { name: "Expand plan", exact: true }).click()
  assert.equal(await body.getAttribute("data-expanded"), "true")
  assert.ok((await body.boundingBox()).height > bounded.height)
  await plan.getByRole("button", { name: "Collapse plan", exact: true }).click()
  await plan.getByRole("button", { name: "Open plan", exact: true }).click()
  await eventually(
    async () => (await call("runs.get", { sessionID: chat.id })).plan?.text === longPlan,
    "Full plan not published",
  )
  assert.equal(await main().locator(".bb-mode-row").getByRole("button", { name: "Open plan", exact: true }).count(), 0)
  check("Long proposed plans have a bounded preview, explicit expansion and complete side-panel source")

  const goal = await create("QA completed Goal")
  await open(goal)
  await call("access.set", { sessionID: goal.id, mode: "full" })
  await admit(goal, "finish-goal", { prompt: { goal: true } })
  await idle(goal)
  assert.equal((await call("runs.get", { sessionID: goal.id })).goal.status, "complete")
  await main().locator(".bb-goal-row").waitFor()
  await admit(goal, "ordinary request after achievement")
  await idle(goal)
  await eventually(
    async () => (await main().locator(".bb-goal-row").count()) === 0,
    "Completed summary did not dismiss",
  )
  const retained = (await call("runs.get", { sessionID: goal.id })).goal
  assert.equal(retained.summaryDismissed, true)
  assert.ok(retained.evidence)
  check("A completed Goal dismisses after the next accepted message while retaining evidence")

  const resumeGoal = await create("QA immediate Goal Resume")
  await open(resumeGoal)
  const resumeHold = hold("resume-initial")
  await admit(resumeGoal, "resume-initial", { prompt: { goal: true } })
  await eventually(() => resumeHold.entered, "Goal Resume fixture did not enter its provider turn")
  const stoppedAssistant = (await engine("/session/" + resumeGoal.id + "/message")).findLast(
    (row) => row.info.role === "assistant",
  )
  assert.ok(stoppedAssistant?.info.parentID && stoppedAssistant.info.time.created)
  await main().getByRole("button", { name: "Stop", exact: true }).click()
  await eventually(async () => {
    const run = await call("runs.get", { sessionID: resumeGoal.id })
    const status = await engine("/session/status")
    return run.paused && run.goal.status === "paused" && status[resumeGoal.id]?.type !== "busy"
  }, "Goal Stop did not settle its owned provider turn")
  // V1 publishes idle before persisting cancellation metadata. Resume at that
  // boundary, then verify the real stopped assistant after its finalization.
  await call("runs.goal-resume", { sessionID: resumeGoal.id })
  resumeHold.release.resolve()
  await eventually(async () => {
    const run = await call("runs.get", { sessionID: resumeGoal.id })
    return run.goal.continuations > 0 && run.goal.status !== "active"
  }, "Goal Resume did not continue past its previously stopped turn")
  await idle(resumeGoal)
  assert.ok(
    (await engine("/session/" + resumeGoal.id + "/message")).some(
      (row) => row.info.id === stoppedAssistant.info.id && row.info.error?.name === "MessageAbortedError",
    ),
    "Native Goal Resume regression must retain the real typed cancellation",
  )
  const resumedGoal = (await call("runs.get", { sessionID: resumeGoal.id })).goal
  assert.equal(resumedGoal.reason, "no-progress", "Only the later fixture's lack of progress should stop continuation")
  check("Immediate Goal Resume accounts a real stopped V1 turn without reusing its cancellation as a fresh blocker")

  const stress = await create("QA combined Plan Goal queue Todo")
  await open(stress)
  await call("access.set", { sessionID: stress.id, mode: "full" })
  const heldStress = hold("stress-initial", true)
  await admit(stress, "stress-initial", { prompt: { goal: true } })
  await eventually(() => heldStress.entered, "Combined fixture did not reach its tool/provider boundary")
  const todos = await engine("/session/" + stress.id + "/todo")
  assert.equal(todos.length, 2)
  const todoDock = main().locator("[data-component=session-todo-dock]")
  await todoDock.waitFor()
  const toggle = todoDock.locator("[data-action=session-todo-toggle-button]")
  if ((await toggle.getAttribute("data-collapsed")) === "true") await toggle.click()
  await call("runs.plan", { sessionID: stress.id, text: "# stress-plan-revision-one\nImplement exactly revision one." })
  await call("runs.plan", {
    sessionID: stress.id,
    text: "# stress-plan-revision-two\nThis revision must remain in history.",
  })
  await call("runs.implement", { sessionID: stress.id, revision: 1 })
  const queuedA = await admit(stress, "stress-queued-A")
  const queuedB = await admit(stress, "stress-steered-B")
  await call("runs.steer", { sessionID: stress.id, id: queuedB.id })
  await eventually(
    async () => (await engine("/session/" + stress.id + "/message")).some((row) => row.info.id === queuedB.id),
    "Steered B was not durably admitted",
  )
  await main().getByRole("button", { name: "Stop", exact: true }).click()
  const paused = await call("runs.get", { sessionID: stress.id })
  assert.equal(paused.paused, true)
  assert.equal(paused.goal.status, "paused")
  assert.deepEqual(await engine("/session/" + stress.id + "/todo"), todos)
  assert.ok((await todoDock.innerText()).includes("Verify queue and Plan identity"))
  heldStress.release.resolve()
  await call("runs.resume", { sessionID: stress.id })
  await call("runs.goal-resume", { sessionID: stress.id })
  await idle(stress)
  const combined = await call("runs.get", { sessionID: stress.id })
  assert.equal(combined.plan.versions.length, 2)
  assert.ok(combined.goal.id && combined.goal.tokens >= 0)
  assert.ok(
    !combined.goal.reason.includes("MessageAbortedError"),
    "Goal Resume reused the previously stopped turn as a fresh blocker",
  )
  const combinedHistory = await engine("/session/" + stress.id + "/message")
  const identities = combinedHistory.map((row) => row.info.id)
  assert.equal(new Set(identities).size, identities.length)
  assert.equal(identities.filter((value) => value === queuedA.id).length, 1)
  assert.equal(identities.filter((value) => value === queuedB.id).length, 1)
  assert.ok(identities.indexOf(queuedB.id) < identities.indexOf(queuedA.id))
  const implementation = combinedHistory.find(
    (row) =>
      row.info.role === "user" &&
      row.parts.some((part) => part.type === "text" && part.text === "Implement approved plan · revision 1"),
  )
  assert.ok(implementation)
  assert.ok(
    implementation.parts.some(
      (part) =>
        part.type === "text" &&
        part.synthetic &&
        part.text.includes("stress-plan-revision-one") &&
        !part.text.includes("stress-plan-revision-two"),
    ),
  )
  assert.deepEqual(await engine("/session/" + stress.id + "/todo"), todos)
  report.observations.push({
    combinedGoalStatus: combined.goal.status,
    combinedGoalReason: combined.goal.reason,
    steeringBoundary: "V1 original provider turn was interrupted only by explicit Stop",
  })
  check(
    "Combined Plan revision, active Goal, A/B queue, Steer, expanded Todo and Stop/Resume preserve state and input identity",
  )

  const image = await create("QA recorded image")
  await open(image)
  await call("access.set", { sessionID: image.id, mode: "full" })
  await admit(image, "view-png")
  await idle(image)
  const imageHistory = await engine("/session/" + image.id + "/message")
  const read = imageHistory
    .flatMap((row) => row.parts)
    .find((part) => part.type === "tool" && part.tool === "read" && part.state.status === "completed")
  assert.ok(read, "The controlled provider must complete the PNG read tool")
  assert.ok(read.state.attachments?.length, "The completed PNG read must retain its image attachment")
  const recorded = read.state.attachments[0].url
  await main().getByText("Viewed image", { exact: true }).first().waitFor()
  const thumbnail = main().locator("[data-slot=read-image-thumbnail]").first()
  await thumbnail.waitFor()
  await eventually(
    () => thumbnail.locator("img").evaluate((node) => node.complete && node.naturalWidth > 0),
    "Recorded image did not decode",
  )
  assert.equal(await thumbnail.locator("img").getAttribute("src"), recorded)
  await writeFile(pngPath, "Source changed after the completed image read")
  await thumbnail.click()
  await page.locator("[data-component=image-preview] [data-slot=image-preview-image]").waitFor()
  assert.equal(
    await page.locator("[data-component=image-preview] [data-slot=image-preview-image]").getAttribute("src"),
    recorded,
  )
  await page.keyboard.press("Escape")
  check("PNG read uses its recorded image attachment and opens an enlarged preview")

  const attachmentOnly = await create("QA attachment-only fork")
  await open(attachmentOnly)
  await admit(attachmentOnly, "", {
    prompt: { legacyParts: [{ type: "file", mime: "image/png", filename: "QA-only-attachment.png", url: recorded }] },
  })
  await idle(attachmentOnly)
  await main().getByRole("button", { name: "More options", exact: true }).last().click()
  await page.getByRole("menuitem", { name: "Fork from message", exact: true }).click()
  await page.getByRole("dialog").getByText("QA-only-attachment.png", { exact: true }).waitFor()
  await page.getByRole("dialog").locator('[data-slot="list-item"][data-key]').first().click()
  await eventually(async () => {
    const current = await main().getAttribute("data-bb-chat")
    return current && current !== attachmentOnly.id
  }, "Attachment-only boundary did not open an independent fork")
  assert.ok((await engine("/session/" + (await main().getAttribute("data-bb-chat")))).id)
  await main().locator('[data-slot="prompt-attachments"] img[alt="QA-only-attachment.png"]').waitFor()
  check("Attachment-only user messages remain available as persistent Fork boundaries")

  assert.equal(report.errors.length, 0, report.errors.join("\n"))
  await page.screenshot({ path: join(root, ".tools/qa/results/todo-polish.png") })
} catch (error) {
  report.failure = String(error)
  console.error("FAIL", String(error))
  if (page) {
    console.log((await page.locator("body").innerText()).slice(0, 1800))
    await page.screenshot({ path: join(root, ".tools/qa/results/todo-polish-failure.png") }).catch(() => {})
  }
  process.exitCode = 1
} finally {
  for (const value of holds.values()) value.release.resolve()
  report.observations.push({ providerRequests: requests.length, syntheticProvider: true, profile })
  await writeFile(join(root, ".tools/qa/results/todo-polish.json"), JSON.stringify(report, null, 2))
  await app.close()
  fixture.closeAllConnections()
  fixture.close()
}
