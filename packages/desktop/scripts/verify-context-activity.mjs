import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { join, resolve } from "node:path"
import { captureHidden } from "./qa-capture.mjs"

// Every account, process, request and file below belongs to this hidden local QA.
// Killing the engine is limited to an exact Utility metric owned by this app.
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const basename = process.env.BB_QA_REPORT || "context-activity"
const profile = join(root, ".tools/qa/context-activity-" + randomUUID())
const data = join(profile, "BitsBytesChat"),
  directory = join(data, "workspace")
const results = join(root, ".tools/qa/results")
const executablePath =
  process.env.BB_QA_EXECUTABLE || join(root, ".tools/qa/interface-patch-package/win-unpacked/BitsBytesChat.exe")
const report = { profile, executablePath, checks: [], errors: [], captures: [], requests: [], observations: [] }
const holds = new Map()
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (label) => {
  report.checks.push(label)
  console.log("PASS", label)
}
const id = () =>
  "msg_" +
  ((BigInt(Date.now()) * 4096n) & 0xffffffffffffn).toString(16).padStart(12, "0") +
  randomUUID().replaceAll("-", "").slice(0, 14)
const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
const fixture = createServer(async (request, response) => {
  try {
    if (request.method !== "POST") {
      response.writeHead(404).end()
      return
    }
    let body = ""
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body || "{}")
    const latest = textOf(input.messages?.findLast((row) => row.role === "user")?.content)
    const toolRows = input.messages?.filter((row) => row.role === "tool") ?? []
    report.requests.push({
      latest,
      model: input.model,
      maxTokens: input.max_tokens ?? input.max_completion_tokens,
      at: Date.now(),
    })
    const named = (suffix) =>
      input.tools?.find((tool) => tool.function?.name === suffix || tool.function?.name.endsWith("_" + suffix))
        ?.function.name
    const calls = []
    if (latest.includes("retry-document-script") && toolRows.length === 0) {
      calls.push({
        name: named("run_artifact_script"),
        args: {
          job_id: "failed-script",
          files: ["Recovery.md"],
          code: "raise ValueError('QA exact recoverable script diagnostic')",
        },
      })
    }
    if (latest.includes("retry-document-script") && toolRows.length === 1) {
      const failed = JSON.parse(textOf(toolRows[0].content))
      assert.ok(
        failed._meta?.["bitsbytes.operation"]?.attemptID,
        "Actual MCP error must retain the failed attempt metadata",
      )
      calls.push({
        name: named("run_artifact_script"),
        args: {
          job_id: "retry-script",
          retry_of: failed._meta["bitsbytes.operation"].attemptID,
          files: ["Recovery.md"],
          code: "from pathlib import Path\nPath('Recovery.md').write_text('# Recovered document\\n\\nThe exact requested output was verified.\\n', encoding='utf-8')",
        },
      })
    }
    if (latest.includes("crash-tool") && toolRows.length === 0)
      calls.push({
        name: named("run_artifact_script"),
        args: {
          job_id: "crash-script",
          files: ["Never published.md"],
          code: "import time\ntime.sleep(120)",
        },
      })
    assert.ok(
      calls.every((call) => call.name),
      "Actual local tool must be advertised",
    )
    response.writeHead(200, { "content-type": "text/event-stream" })
    const emit = (delta) =>
      response.write(
        "data: " +
          JSON.stringify({
            id: "qa-" + randomUUID(),
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta, finish_reason: null }],
          }) +
          "\n\n",
      )
    emit({ role: "assistant" })
    const held = [...holds].find(([marker, hold]) => latest.includes(marker) && !hold.entered)
    if (held) {
      held[1].entered = true
      emit({ reasoning_content: "Thinking only for the exact current QA turn." })
      emit({ content: "Controlled QA provider is waiting at its safe boundary." })
      const keepalive = setInterval(() => {
        if (!response.destroyed) response.write(": keepalive\n\n")
      }, 5000)
      try {
        await held[1].release.promise
      } finally {
        clearInterval(keepalive)
      }
      if (response.destroyed) return
    }
    if (calls.length)
      emit({
        tool_calls: calls.map((call, index) => ({
          index,
          id: "call_" + randomUUID(),
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      })
    else emit({ content: "Fixture complete: " + latest })
    response.end(
      "data: " +
        JSON.stringify({
          id: "end",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 },
        }) +
        "\n\ndata: [DONE]\n\n",
    )
  } catch (error) {
    report.errors.push(String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end("Local fixture assertion failed")
  }
})
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve))
await mkdir(join(data, "config/opencode"), { recursive: true })
await mkdir(directory, { recursive: true })
await mkdir(results, { recursive: true })
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    model: "context-qa/fixture",
    provider: {
      "context-qa": {
        name: "Context fixture",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `http://127.0.0.1:${fixture.address().port}/v1`, apiKey: "fixture-only" },
        models: {
          fixture: { name: "Context fixture", reasoning: true, limit: { context: 128000, output: 8192 } },
        },
      },
    },
  }),
)
let app,
  page,
  server,
  agentsReady = false
const eventually = async (predicate, label, timeout = 30000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await wait(100)
  }
  throw Error(label)
}
const hidden = () =>
  app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows())
      if (window.isVisible() || window.isFocused()) throw Error("QA became visible or focused")
  })
const call = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
const engine = async (path, method = "GET", body) => {
  const headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) }
  if (server.password)
    headers.authorization =
      "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")
  const response = await fetch(server.url + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  })
  assert.ok(response.ok, `${method} ${path}: ${response.status}`)
  return response.status === 204 ? undefined : response.json()
}
const launch = async () => {
  app = await _electron.launch({
    executablePath,
    env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", BB_QA_CAPTURE: "1", LOCALAPPDATA: profile },
    timeout: 90000,
  })
  page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  agentsReady = false
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) agentsReady = false
  })
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname !== "/agent" || !response.ok()) return
    const agents = await response.json().catch(() => [])
    if (!agents.some((agent) => agent.name === "build")) return
    agentsReady = true
    report.observations.push({ agentBootstrap: agents.map((agent) => agent.name), at: Date.now() })
  })
  page.on("pageerror", (error) => report.errors.push(error.message))
  page.on("request", (request) => {
    if (request.method() === "POST") report.observations.push({ browserPost: new URL(request.url()).pathname })
  })
  const diagnose = () => {
    window.Notification = class extends EventTarget {
      static permission = "denied"
      static async requestPermission(callback) {
        callback?.("denied")
        return "denied"
      }
      close() {}
    }
    window.__qaActivity = []
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target.closest?.('[data-action="prompt-submit"]')
        if (target)
          window.__qaActivity.push({
            type: "submit-click",
            at: Date.now(),
            disabled: target.disabled,
            handler: typeof target.$$click,
          })
      },
      true,
    )
    const observer = new MutationObserver(() => {
      for (const toast of document.querySelectorAll('[data-component="toast"]')) {
        const text = toast.textContent
        if (!window.__qaActivity.some((item) => item.type === "toast" && item.text === text))
          window.__qaActivity.push({ type: "toast", at: Date.now(), text })
      }
    })
    observer.observe(document, { childList: true, subtree: true, characterData: true })
  }
  await page.addInitScript(diagnose)
  await page.evaluate(diagnose)
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isVisible() || window.isFocused()) throw Error("QA became visible")
      window.setSize(1440, 960)
    }
  })
  await page.locator("[contenteditable=true]").first().waitFor({ timeout: 90000 })
  server = await page.evaluate(() => window.api.awaitInitialization())
  await hidden()
}
const main = (chat) => page.locator(`.bb-workspace-chat[data-bb-chat="${chat.id}"]`)
const editor = (chat) => main(chat).locator("[contenteditable=true]").first()
const open = async (chat) => {
  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), {
    sessionID: chat.id,
    directory,
  })
  await editor(chat).waitFor()
  await call("access.set", { sessionID: chat.id, mode: "full" })
}
const history = (chat) => engine(`/session/${chat.id}/message`)
const idle = (chat, expected) =>
  eventually(
    async () => {
      const run = await call("runs.get", { sessionID: chat.id })
      if (
        !run.last ||
        (expected && run.last.text !== expected) ||
        run.awaiting ||
        run.queue.length ||
        (await engine("/session/status"))[chat.id]?.type === "busy"
      )
        return false
      return (await history(chat)).some(
        (row) =>
          row.info.role === "assistant" &&
          row.info.parentID === run.last.id &&
          typeof row.info.time.completed === "number",
      )
    },
    "Chat did not become idle",
    60000,
  )
const send = async (chat, text) => {
  await editor(chat).fill(text)
  await eventually(async () => {
    const button = main(chat).locator('[data-action="prompt-submit"]').first()
    return (
      (await button.count()) > 0 &&
      (await button.isEnabled()) &&
      (await contextButton(chat).innerText()) === "Context fixture" &&
      agentsReady
    )
  }, "Composer did not become ready to send")
  await main(chat).locator('[data-action="prompt-submit"]').first().click()
  await wait(250)
  report.observations.push({
    sent: text,
    ui: await page.evaluate(
      (chatID) => ({
        events: window.__qaActivity,
        routes: Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.endsWith("last-active-url"))),
        editors: [...document.querySelectorAll(`[data-bb-chat="${chatID}"] [contenteditable=true]`)].map((editor) => ({
          text: editor.textContent,
          props: Object.keys(editor).filter((key) => key.startsWith("$$")),
        })),
        model: document.querySelector(`[data-bb-chat="${chatID}"] [data-action="prompt-model"]`)?.textContent,
      }),
      chat.id,
    ),
  })
}
const admit = (chat, text) =>
  call("runs.admit", {
    immediate: true,
    prompt: {
      id: id(),
      sessionID: chat.id,
      directory,
      protocol: "v1",
      text,
      agent: "build",
      model: { providerID: "context-qa", modelID: "fixture" },
      legacyParts: [{ type: "text", text }],
    },
  })
const hold = (marker) => {
  const value = { entered: false, release: Promise.withResolvers() }
  holds.set(marker, value)
  return value
}
const capture = async (name, scheme) => {
  await page.emulateMedia({ colorScheme: scheme })
  await page.waitForFunction((value) => document.documentElement.dataset.colorScheme === value, scheme)
  const path = join(results, `${basename}-${name}-${scheme}.png`)
  report.captures.push({ name, scheme, path, viewport: await captureHidden(app, page, path) })
  await hidden()
}
const contexts = () => page.locator('[data-component="context-window-options"]')
const contextButton = (chat) => main(chat).locator('[data-action="prompt-model"]').first()
const choose = (value) =>
  contexts()
    .getByRole("button", {
      name: value === undefined ? "Recommended" : `${value.toLocaleString("en-US")} tokens`,
      exact: true,
    })
    .click()
const assistantFor = async (chat, text) => {
  const rows = await history(chat)
  const user = rows.find(
    (row) => row.info.role === "user" && row.parts.some((part) => part.type === "text" && part.text === text),
  )
  assert.ok(user, "Input must be recorded exactly once")
  return rows.findLast((row) => row.info.role === "assistant" && row.info.parentID === user.info.id)
}
try {
  await launch()
  if (process.env.BB_QA_ACTIVITY_ONLY !== "1") {
    const context = await engine("/session", "POST", { title: "Context controls and frozen queue" })
    await open(context)
    await contextButton(context).click({ button: "right" })
    await contexts().waitFor()
    for (const scheme of ["dark", "light"]) await capture("context-choices", scheme)
    await choose(64000)
    await send(context, "context-selected-64k")
    await idle(context, "context-selected-64k")
    assert.equal((await assistantFor(context, "context-selected-64k")).info.contextWindow, 64000)
    const initialRequest = report.requests.find((request) => request.latest.includes("context-selected-64k"))
    assert.ok(initialRequest)
    check("Right-click selects a real custom context budget which reaches the actual V1 provider turn")

    await page.reload({ waitUntil: "domcontentloaded" })
    await page.locator("[contenteditable=true]").first().waitFor()
    await open(context)
    await send(context, "context-retained-after-reload")
    await idle(context, "context-retained-after-reload")
    assert.equal((await assistantFor(context, "context-retained-after-reload")).info.contextWindow, 64000)
    await contextButton(context).press("Shift+F10")
    await contexts().waitFor()
    await choose()
    await send(context, "context-recommended")
    await idle(context, "context-recommended")
    assert.equal((await assistantFor(context, "context-recommended")).info.contextWindow, undefined)
    assert.equal(
      report.requests.find((request) => request.latest.includes("context-recommended")).maxTokens,
      initialRequest.maxTokens,
    )
    check(
      "Keyboard Context Menu opens the control; Recommended removes the override without changing provider output allowance",
    )

    const activationFailures = []
    for (const activation of ["click", "Enter", "Space"]) {
      await contextButton(context).click()
      const search = page.getByPlaceholder("Search models", { exact: true })
      await search.fill("Context fixture")
      const ellipsis = page
        .locator('[data-option-key="context-qa:fixture"]')
        .getByRole("button", { name: "Context window", exact: true })
      if (activation === "click") await ellipsis.click()
      else await ellipsis.press(activation)
      if (process.env.BB_QA_COLLECT === "1") {
        await wait(1000)
        if (!(await contexts().isVisible())) {
          activationFailures.push(activation)
          report.observations.push({
            knownCandidateBlocker: "Model-row Context window activation closes menu",
            activation,
          })
          await page.keyboard.press("Escape")
          await contextButton(context).press("Shift+F10")
        }
      }
      await contexts().waitFor()
      await choose(128000)
    }
    if (!activationFailures.length)
      check("Visible model ellipsis opens Context window by mouse, Enter and Space without selecting the row")
    const boundary = hold("queue-boundary-held")
    await send(context, "queue-boundary-held")
    await eventually(() => boundary.entered, "Controlled provider hold was not entered")
    await contextButton(context).press("Shift+F10")
    await contexts().waitFor()
    await choose(64000)
    await send(context, "queue-frozen-64k")
    await eventually(
      async () => (await call("runs.get", { sessionID: context.id })).queue.length === 1,
      "Queued input not durably captured",
    )
    const queued = (await call("runs.get", { sessionID: context.id })).queue[0]
    assert.equal(queued.prompt.model.contextWindow, 64000)
    for (const scheme of ["dark", "light"]) await capture("frozen-queue", scheme)
    await contextButton(context).press("Shift+F10")
    await contexts().waitFor()
    await choose()
    boundary.release.resolve()
    await idle(context, "queue-frozen-64k")
    assert.equal((await assistantFor(context, "queue-frozen-64k")).info.contextWindow, 64000)
    check("Queued admission retains its chosen budget despite a later Recommended selection")

    if (process.env.BB_QA_CONTEXT_GUARD === "1") {
      const pending = hold("unsupported-boundary-held")
      await send(context, "unsupported-boundary-held")
      await eventually(() => pending.entered, "Unsupported-limit provider boundary not reached")
      await contextButton(context).press("Shift+F10")
      await contexts().waitFor()
      await choose(64000)
      await send(context, "must-remain-unsent-after-capacity-change")
      await eventually(
        async () => (await call("runs.get", { sessionID: context.id })).queue.length === 1,
        "Unsupported-limit input was not queued",
      )
      await call("runs.stop", { sessionID: context.id })
      pending.release.resolve()
      await eventually(
        async () =>
          (await call("runs.get", { sessionID: context.id })).paused &&
          (await engine("/session/status"))[context.id]?.type !== "busy",
        "Held chat did not pause before catalog fixture change",
      )
      await writeFile(
        join(directory, "opencode.json"),
        JSON.stringify({
          provider: { "context-qa": { models: { fixture: { limit: { context: 32000, output: 8192 } } } } },
        }),
      )
      await engine("/config", "PATCH", {})
      await eventually(
        async () =>
          (await engine("/provider")).all.find((provider) => provider.id === "context-qa")?.models.fixture.limit
            .context === 32000,
        "Provider fixture did not apply reduced context capacity",
      )
      report.observations.push({ verifiedProviderCapacityBeforeQueueResume: 32000 })
      await call("runs.resume", { sessionID: context.id })
      await eventually(
        async () => (await call("runs.get", { sessionID: context.id })).queue.some((row) => row.error),
        "Changed capacity did not visibly fail the unsent queued input",
      )
      assert.ok(!report.requests.some((request) => request.latest.includes("must-remain-unsent-after-capacity-change")))
      assert.ok(
        (await call("runs.get", { sessionID: context.id })).queue.some(
          (row) => row.prompt.text === "must-remain-unsent-after-capacity-change" && row.error,
        ),
      )
      await main(context).locator(".bb-queue-error").first().waitFor()
      for (const scheme of ["dark", "light"]) await capture("unsupported-queued-budget", scheme)
      check(
        "Dispatch revalidates a saved custom capacity and retains unsupported queued source with an actionable error before any provider request",
      )
      await call("runs.delete", {
        sessionID: context.id,
        id: (await call("runs.get", { sessionID: context.id })).queue[0].id,
      })
      await writeFile(
        join(directory, "opencode.json"),
        JSON.stringify({
          provider: { "context-qa": { models: { fixture: { limit: { context: 128000, output: 8192 } } } } },
        }),
      )
      await engine("/config", "PATCH", {})
    } else
      report.observations.push(
        "Unsupported-limit dispatch guard check disabled for a candidate built before the guard; rerun final candidate with BB_QA_CONTEXT_GUARD=1.",
      )
  }
  const recovery = await engine("/session", "POST", { title: "Actual tool failure and explicit recovery" })
  await open(recovery)
  await admit(recovery, "retry-document-script")
  await idle(recovery)
  const recovered = main(recovery).locator('[data-component="tool-recovered-attempts"]')
  if (process.env.BB_QA_COLLECT === "1") {
    await wait(500)
    if (!(await recovered.count()))
      report.observations.push({
        knownCandidateBlocker: "Part does not forward recoveredTools to the visible recovery details",
      })
  } else await recovered.getByText("Recovered after retry", { exact: true }).waitFor()
  assert.equal(await main(recovery).locator('[data-kind="tool-error-card"]').count(), 0)
  await main(recovery).getByText("Run document script", { exact: true }).first().waitFor()
  const toolRows = (await history(recovery))
    .flatMap((row) => row.parts)
    .filter((part) => part.type === "tool" && part.tool.endsWith("run_artifact_script"))
  assert.equal(toolRows.length, 2)
  assert.equal(toolRows[0].state.status, "error")
  assert.equal(toolRows[1].state.status, "completed")
  assert.equal(
    toolRows[1].state.metadata["bitsbytes.operation"].retryOf,
    toolRows[0].state.metadata["bitsbytes.operation"].attemptID,
  )
  assert.ok(toolRows[1].state.metadata["bitsbytes.operation"].artifacts.length)
  for (const scheme of ["dark", "light"]) await capture("compact-tool-recovery", scheme)
  const success = main(recovery).locator(`[data-timeline-part-id="${toolRows[1].id}"]`)
  await success.locator('[data-component="tool-trigger"]').first().click()
  const details = success.locator('[data-component="tool-raw-details"]').first()
  await details.getByText("Arguments", { exact: true }).waitFor()
  assert.ok((await details.innerText()).includes("retry-script"))
  assert.ok((await details.innerText()).includes("Recovery.md"))
  if (await recovered.count()) {
    await recovered.locator("summary").click()
    await recovered.getByText("Tool name", { exact: true }).waitFor()
    assert.ok((await recovered.innerText()).includes("QA exact recoverable script diagnostic"))
    assert.ok((await recovered.innerText()).includes("failed-script"))
  }
  for (const scheme of ["dark", "light"]) await capture("readable-tool-recovery", scheme)
  check(
    process.env.BB_QA_COLLECT === "1"
      ? "Actual Python tool explicit retry preserves exact operation metadata and verified artifact output"
      : "Actual failed Python tool and explicit verified retry share a neutral recovery group retaining raw tool name, arguments and original diagnostic",
  )

  const interrupted = await engine("/session", "POST", { title: "Crash recovery and exact live ownership" })
  await open(interrupted)
  await admit(interrupted, "crash-tool")
  let orphan
  await eventually(async () => {
    orphan = (await history(interrupted))
      .flatMap((row) => row.parts)
      .find(
        (part) => part.type === "tool" && part.tool.endsWith("run_artifact_script") && part.state.status === "running",
      )
    return !!orphan
  }, "Real running script did not start")
  const old = main(interrupted).locator(`[data-timeline-part-id="${orphan.id}"]`)
  await old.locator('[data-component="text-shimmer"][data-active="true"]').first().waitFor()
  const crashed = await app.evaluate(({ app }) => {
    const owned = app
      .getAppMetrics()
      .filter(
        (metric) =>
          metric.type === "Utility" &&
          (metric.name === "Bits & Bytes Chat" || metric.serviceName === "Bits & Bytes Chat"),
      )
    if (owned.length !== 1 || owned[0].pid === process.pid)
      throw Error("Exact QA engine process ownership not established")
    process.kill(owned[0].pid, "SIGKILL")
    return { pid: owned[0].pid, creationTime: owned[0].creationTime }
  })
  report.observations.push({ deliberatelyCrashedOwnedEngine: crashed })
  await app.close()
  app = undefined
  await launch()
  await open(interrupted)
  const restored = main(interrupted).locator(`[data-timeline-part-id="${orphan.id}"]`)
  await restored.waitFor()
  assert.equal(await restored.locator('[data-component="text-shimmer"][data-active="true"]').count(), 0)
  assert.ok((await restored.innerText()).includes("Interrupted"))
  const later = hold("later-owned-turn")
  await admit(interrupted, "later-owned-turn")
  await eventually(() => later.entered, "New actual provider turn not entered")
  await eventually(
    async () => (await engine("/session/status"))[interrupted.id]?.owner?.assistantID,
    "Current execution lacks exact ownership",
  )
  assert.equal(await restored.locator('[data-component="text-shimmer"][data-active="true"]').count(), 0)
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.locator("[contenteditable=true]").first().waitFor()
  await open(interrupted)
  assert.equal(
    await main(interrupted)
      .locator(`[data-timeline-part-id="${orphan.id}"] [data-component="text-shimmer"][data-active="true"]`)
      .count(),
    0,
  )
  await main(interrupted).getByRole("button", { name: "Stop", exact: true }).click()
  await eventually(
    async () => (await engine("/session/status"))[interrupted.id]?.type !== "busy",
    "Stop did not settle current execution",
  )
  later.release.resolve()
  await wait(300)
  assert.equal(await main(interrupted).locator('[data-component="text-shimmer"][data-active="true"]').count(), 0)
  for (const scheme of ["dark", "light"]) await capture("interrupted-history", scheme)
  check(
    "A deliberately crashed owned engine retains history statically; newer work, renderer reconnect and Stop do not reactivate its old tool animation",
  )
  await hidden()
  assert.equal(report.errors.length, 0, report.errors.join("\n"))
} catch (error) {
  report.failure = error.stack || String(error)
  console.error("FAIL", report.failure)
  if (page && app) await captureHidden(app, page, join(results, `${basename}-failure.png`)).catch(() => undefined)
  process.exitCode = 1
} finally {
  for (const hold of holds.values()) hold.release.resolve()
  await writeFile(join(results, basename + ".json"), JSON.stringify(report, null, 2))
  await app?.close().catch(() => undefined)
  fixture.closeAllConnections()
  await new Promise((resolve) => fixture.close(resolve))
}
