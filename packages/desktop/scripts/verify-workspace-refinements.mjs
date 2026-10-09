import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { basename, join, resolve } from "node:path"
import { captureHidden } from "./qa-capture.mjs"

// Only owned windows, data and local provider requests. Never touches live credentials or desktop focus.
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/workspace-refinements-" + randomUUID())
const data = join(profile, "BitsBytesChat")
const directory = join(data, "workspace")
const results = join(root, ".tools/qa/results")
const reportName = process.env.BB_QA_REPORT || "workspace-refinements"
const capture = process.env.BB_QA_CAPTURE === "1"
const report = { checks: [], errors: [], geometry: [], screenshots: [], profile, syntheticProvider: true }
const fixtureFile = join(directory, "fixture-changes.txt")
const longPlan =
  "# Bounded fictional plan\n\n" +
  Array.from(
    { length: 80 },
    (_, index) => `${index + 1}. Verify fixture step ${index + 1} with concrete evidence.`,
  ).join("\n")
const requests = []
const fixture = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Local QA</title>")
    return
  }
  let body = ""
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body || "{}")
  const lastUser = input.messages?.findLastIndex((row) => row.role === "user") ?? -1
  const latest = JSON.stringify(input.messages?.[lastUser]?.content ?? "")
  requests.push({
    latest,
    tools: input.messages?.flatMap((row) => row.tool_calls?.map((call) => call.function?.name) ?? []) ?? [],
  })
  const named = (suffix) => input.tools?.find((tool) => tool.function?.name.endsWith(suffix))?.function.name
  const executed = (suffix) =>
    input.messages?.slice(lastUser).some((row) => row.tool_calls?.some((call) => call.function?.name.endsWith(suffix)))
  const calls = []
  if (latest.includes("fixture-changed-lines") && !executed("read"))
    calls.push({ name: named("read"), args: { filePath: fixtureFile } })
  else if (latest.includes("fixture-changed-lines") && !executed("edit"))
    calls.push({
      name: named("edit"),
      args: {
        filePath: fixtureFile,
        oldString: "Original fixture line",
        newString: "Updated fixture line\nAdded fixture line two\nAdded fixture line three",
      },
    })
  if (calls.some((call) => !call.name)) {
    report.errors.push("Fixture tool was not advertised")
    res.writeHead(500).end("Fixture tool unavailable")
    return
  }
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
  else
    emit({
      content: latest.includes("fixture-long-plan")
        ? `<proposed_plan>\n${longPlan}\n</proposed_plan>`
        : "Fictional local operation completed.",
    })
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
await Promise.all([directory, join(data, "config/opencode"), results].map((path) => mkdir(path, { recursive: true })))
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(fixtureFile, "Original fixture line\n")
for (const args of [
  ["init", "-q"],
  ["add", "fixture-changes.txt"],
  ["-c", "user.name=Fictional QA", "-c", "user.email=qa@localhost.invalid", "commit", "-qm", "Fixture baseline"],
])
  execFileSync("git", args, { cwd: directory, windowsHide: true, stdio: "pipe" })
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    provider: {
      "workspace-qa": {
        name: "Local QA",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:" + fixture.address().port + "/v1", apiKey: "fixture-only" },
        models: {
          fixture: {
            name: "Workspace QA fixture",
            limit: { context: 1000000, output: 8192 },
            cost: { input: 1, output: 2 },
          },
        },
      },
    },
    model: "workspace-qa/fixture",
  }),
)
const check = (label) => {
  report.checks.push(label)
  console.log("PASS", label)
}
const poll = async (read, accept, label) => {
  for (let index = 0; index < 250; index++) {
    const value = await read()
    if (accept(value)) return value
    await new Promise((done) => setTimeout(done, 100))
  }
  throw Error("Timed out: " + label)
}
let app, page
try {
  app = await _electron.launch({
    executablePath:
      process.env.BB_QA_EXECUTABLE ||
      join(root, ".tools/qa/workspace-refinements-package/win-unpacked/BitsBytesChat.exe"),
    ...(process.env.BB_QA_MAIN ? { args: [process.env.BB_QA_MAIN] } : {}),
    env: {
      ...process.env,
      BB_QA_ISOLATED: "1",
      BB_QA_HIDDEN: "1",
      BB_QA_CAPTURE: capture ? "1" : "0",
      LOCALAPPDATA: profile,
    },
    timeout: 90000,
  })
  page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  page.on("pageerror", (error) => report.errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setBackgroundThrottling(false)
    window.setContentSize(1380, 900)
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
  const model = { providerID: "workspace-qa", modelID: "fixture" }
  await page.locator(".bb-org-sidebar").waitFor({ timeout: 90000 })
  await poll(
    () => api("/agent"),
    (rows) => rows.some((row) => row.name === "build"),
    "workspace initialized",
  )
  await api("/api/organization/migrate", "POST", { projects: [{ directory }], defaultDirectory: directory })
  const create = async (title) => {
    const session = await api("/session", "POST", { title })
    await api(`/session/${session.id}/prompt_async`, "POST", {
      noReply: true,
      agent: "build",
      model,
      parts: [{ type: "text", text: "Durable fictional input" }],
    })
    return session
  }
  const chat = await create("Fictional refinements conversation")
  const other = await create("Fictional alternate conversation")
  const member = await create("Fictional project member")
  const project = await api("/api/organization/projects", "POST", { name: "Fictional collection" })
  await api(`/api/organization/chats/${member.id}`, "PATCH", { projectID: project.id })
  const open = async (session) => {
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), {
      directory,
      sessionID: session.id,
    })
    await page.locator(`.bb-workspace-chat[data-bb-chat="${session.id}"] [contenteditable=true]`).first().waitFor()
  }
  await open(chat)
  const main = () => page.locator(`.bb-workspace-chat[data-bb-chat="${chat.id}"]`)
  const editor = () => main().locator("[contenteditable=true]").first()
  const row = (id) => page.locator(`.bb-org-sidebar .bb-org-row[data-session-id="${id}"]`)
  await poll(
    () => row(member.id).count(),
    (count) => count === 1,
    "one project member row",
  )
  assert.equal(await page.locator(`.bb-org-recents [data-session-id="${member.id}"]`).count(), 0)
  assert.equal(
    (await api("/api/organization/chats/query", "POST", { projectID: null, pinned: false })).data.some(
      (item) => item.id === member.id,
    ),
    false,
  )
  await page.getByRole("button", { name: "Search chats and projects", exact: true }).click()
  const chatSearch = page.locator(".bb-org-search")
  await chatSearch.fill(member.title)
  await poll(
    () => page.locator(`.bb-org-recents [data-session-id="${member.id}"]`).count(),
    (count) => count === 1,
    "global project search",
  )
  assert.equal(await page.locator(".bb-org-project-group").count(), 0)
  await chatSearch.press("Escape")
  await poll(
    () => row(member.id).count(),
    (count) => count === 1,
    "project row after clearing search",
  )
  assert.equal(await page.locator(`.bb-org-recents [data-session-id="${member.id}"]`).count(), 0)
  await api(`/api/organization/chats/${member.id}`, "PATCH", { projectID: null })
  await poll(
    () => page.locator(`.bb-org-recents [data-session-id="${member.id}"]`).count(),
    (count) => count === 1,
    "unassigned chat reappears",
  )
  await api(`/api/organization/chats/${member.id}`, "PATCH", { projectID: project.id })
  await poll(
    () => page.locator(`section[data-project-id="${project.id}"] [data-session-id="${member.id}"]`).count(),
    (count) => count === 1,
    "reassigned chat appears only in project",
  )
  assert.equal(await page.locator(`.bb-org-recents [data-session-id="${member.id}"]`).count(), 0)
  assert.equal((await api("/session/" + member.id)).directory.toLowerCase(), directory.toLowerCase())
  check(
    "Indexed Recents excludes project members; global search finds them once; assignment events preserve the execution folder and remove duplicates",
  )

  await page.locator('.bb-org-titlebar-controls button[aria-label$=" menu"]').click()
  await page.getByRole("menuitem", { name: "File", exact: true }).hover()
  await page.getByRole("menuitem", { name: "Settings", exact: false }).waitFor()
  assert.equal(await page.getByRole("menuitem", { name: /Open project/i }).count(), 0)
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  check("The top-left File menu contains no obsolete disabled Open project action")

  await editor().fill("A preserved fictional draft")
  await page.locator(".bb-org-account").getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-dialog")
  const search = settings.getByRole("searchbox", { name: "Search settings", exact: true })
  await search.fill("microphne")
  await settings.locator(".settings-v2-search-result").filter({ hasText: "Microphone" }).first().waitFor()
  await search.press("ArrowDown")
  assert.equal(
    await settings
      .locator(".settings-v2-search-result")
      .first()
      .evaluate((node) => node === document.activeElement),
    true,
  )
  await page.keyboard.press("Enter")
  await settings.locator('[data-setting-key="audio-microphone"].settings-v2-search-highlight').waitFor()
  assert.equal(
    await settings
      .locator('[data-setting-key="audio-microphone"] select')
      .evaluate((node) => node === document.activeElement),
    true,
  )
  await search.fill("themed")
  await settings.locator(".settings-v2-search-result").first().waitFor()
  await settings.locator(".settings-v2-search-result").filter({ hasText: "Theme" }).first().click()
  await settings.locator('[data-component="settings-v2-row"].settings-v2-search-highlight').waitFor()
  await search.fill("does not exist zzzzzzzzz")
  await settings.getByRole("status").filter({ hasText: "No settings found" }).waitFor()
  await search.press("Escape")
  assert.equal(await search.inputValue(), "")
  assert.equal(await settings.isVisible(), true)
  await search.fill("OpenAI image API key")
  await settings.locator(".settings-v2-search-result").filter({ hasText: "OpenAI image API key" }).waitFor()
  await page.emulateMedia({ colorScheme: "dark" })
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "dark")
  if (capture) {
    const path = join(results, reportName + "-settings-dark.png")
    report.screenshots.push({ path, ...(await captureHidden(app, page, path)) })
  }
  await settings.locator(".settings-v2-search-result").filter({ hasText: "OpenAI image API key" }).click()
  await settings.locator('[data-setting-key="tools-image-key"].settings-v2-search-highlight').waitFor()
  await search.fill("microphone")
  await settings.getByRole("button", { name: "Clear search", exact: true }).click()
  assert.equal(await search.inputValue(), "")
  await search.press("Escape")
  await settings.waitFor({ state: "hidden" })
  assert.equal(await editor().textContent(), "A preserved fictional draft")
  check(
    "Settings search finds translated titles/descriptions and typing mistakes across lazy categories; keyboard selection highlights/focuses the real control, empty/clear/Escape states work and drafts survive",
  )

  const access = () => main().getByRole("button", { name: "Tool access for this chat", exact: true })
  await access().click()
  await page.getByRole("menuitemradio", { name: /^Approve for me/ }).click()
  await poll(
    () => call("access.get", { sessionID: chat.id }),
    (value) => value.mode === "auto",
    "automatic access",
  )
  await poll(
    async () => {
      try {
        return JSON.parse(await readFile(join(data, "access-modes.json"), "utf8"))[chat.id]
      } catch (error) {
        if (error.code === "ENOENT") return undefined
        throw error
      }
    },
    (value) => value === "auto",
    "automatic access persists atomically",
  )
  await open(other)
  await open(chat)
  assert.equal(await access().getAttribute("data-mode"), "auto")
  check("Approve for me is the third explicit access choice, persists on disk and survives conversation remounting")

  const command = async (name, label, verify, activation = "Enter") => {
    const original = "Keep this existing fictional request. "
    await editor().fill(original)
    await editor().press("End")
    await page.keyboard.type("/" + name)
    await main().locator(`[data-suggestion-id="bitsbytes.${name}"]`).waitFor()
    await editor().press(activation)
    await poll(() => call("runs.get", { sessionID: chat.id }), verify, name + " command applied")
    assert.equal(await editor().textContent(), original)
    const chip = main().getByRole("button", { name: label, exact: true })
    await chip.waitFor()
    const geometry = await chip.evaluate((node) => {
      const access = node.closest('[data-slot="prompt-controls"]').querySelector(".bb-chat-access")
      const a = access.getBoundingClientRect(),
        b = node.getBoundingClientRect()
      return {
        afterAccess: b.left >= a.right,
        aligned: Math.abs((a.top + a.bottom - b.top - b.bottom) / 2) <= 1,
        insideControls: !!node.closest('[data-slot="prompt-controls"]'),
      }
    })
    assert.ok(geometry.afterAccess && geometry.aligned && geometry.insideControls)
    report.geometry.push({ command: name, activation, ...geometry })
    await chip.click()
    await chip.waitFor({ state: "hidden" })
  }
  await command("plan", "Remove Plan mode", (value) => value.mode === "plan")
  await command("goal", "Remove Goal", (value) => value.goalDraft === true)
  await command("plan", "Remove Plan mode", (value) => value.mode === "plan", "Space")
  assert.equal(requests.length, 0)
  assert.equal(await main().locator(".bb-send-primary").textContent(), "")
  check(
    "Inline /plan and /goal execute after populated text using Enter, and exact /plan using Space, without submitting or erasing the prompt; removable chips sit right of access and Send uses a compact icon",
  )

  const id = () =>
    "msg_" +
    ((BigInt(Date.now()) * 4096n) & 0xffffffffffffn).toString(16).padStart(12, "0") +
    randomUUID().replaceAll("-", "").slice(0, 14)
  const admit = (text, extra = {}) =>
    call("runs.admit", {
      delivery: "queue",
      prompt: {
        sessionID: chat.id,
        directory,
        id: id(),
        protocol: "v1",
        text,
        agent: "build",
        model,
        legacyParts: [{ type: "text", text }],
        ...extra,
      },
    })
  const idle = async (expected) =>
    poll(
      async () => ({
        run: await call("runs.get", { sessionID: chat.id }),
        status: (await api("/session/status"))[chat.id],
        history: await api(`/session/${chat.id}/message`),
      }),
      ({ run, status, history }) =>
        run.last &&
        (!expected || run.last.text.includes(expected)) &&
        !run.queue.length &&
        !run.awaiting &&
        status?.type !== "busy" &&
        history.some(
          (row) =>
            row.info.role === "assistant" &&
            row.info.parentID === run.last.id &&
            typeof row.info.time.completed === "number",
        ),
      "fixture settles",
    )
  const contextButton = () => main().locator('[data-action="prompt-model"]').first()
  const contexts = () => page.locator('[data-component="context-window-options"]')
  await contextButton().click()
  await page.getByPlaceholder("Search models", { exact: true }).fill("Workspace QA fixture")
  await page.locator('[data-option-key="workspace-qa:fixture"]').hover()
  const recommendedLabel = page.getByText("Recommended context", { exact: true })
  const maximumLabel = page.getByText("Maximum context", { exact: true })
  await recommendedLabel.waitFor()
  await maximumLabel.waitFor()
  assert.ok((await recommendedLabel.evaluate((node) => node.parentElement.textContent)).includes("250,000"))
  assert.ok((await maximumLabel.evaluate((node) => node.parentElement.textContent)).includes("1,000,000"))
  await page.keyboard.press("Escape")
  await contextButton().click({ button: "right" })
  await contexts().waitFor()
  await contexts().getByRole("button", { name: "Recommended · 250,000 tokens", exact: true }).waitFor()
  await contexts().getByRole("button", { name: "1,000,000 tokens", exact: true }).click()
  const sendBudget = async (text) => {
    await editor().fill(text)
    const submit = main().locator('[data-action="prompt-submit"]').first()
    await poll(() => submit.isEnabled(), Boolean, "budget composer ready")
    await submit.click()
    await idle(text)
    const rows = await api(`/session/${chat.id}/message`)
    const user = rows.find(
      (row) => row.info.role === "user" && row.parts.some((part) => part.type === "text" && part.text === text),
    )
    assert.ok(user, "The budget prompt must become a durable input")
    const assistant = rows.findLast((row) => row.info.role === "assistant" && row.info.parentID === user.info.id)
    assert.ok(assistant, "The budget prompt must receive a completed assistant")
    return { user: user.info, assistant: assistant.info }
  }
  const expanded = await sendBudget("fixture-expanded-context")
  assert.equal(expanded.user.model.contextWindow, 1000000)
  assert.equal(expanded.assistant.contextWindow, 1000000)
  await contextButton().press("Shift+F10")
  await contexts().waitFor()
  await contexts().getByRole("button", { name: "Recommended · 250,000 tokens", exact: true }).click()
  const recommended = await sendBudget("fixture-economical-context")
  assert.equal(recommended.user.model.contextWindow, undefined)
  assert.equal(recommended.user.model.recommendedContextWindow, 250000)
  assert.equal(recommended.assistant.contextWindow, 250000)
  check(
    "A paid 1M model tooltip distinguishes 250k Recommended from 1M maximum; right-click and keyboard menus expand or restore Recommended, reaching durable snapshots and actual assistant budgets",
  )
  await editor().fill("")
  await admit("fixture-long-plan", { mode: "plan", agent: "plan" })
  await idle("fixture-long-plan")
  const plan = main().locator('[data-component="proposed-plan"]').last()
  const excerpt = plan.locator(".bb-proposed-plan-body")
  await excerpt.waitFor()
  assert.equal(await plan.locator("details,summary").count(), 0)
  assert.equal(await plan.getByRole("button", { name: /^(Expand|Collapse) plan$/ }).count(), 0)
  assert.equal(await excerpt.getAttribute("data-truncated"), "true")
  assert.ok((await excerpt.textContent()).includes("Verify fixture step 1"))
  assert.equal((await excerpt.textContent()).includes("Verify fixture step 80"), false)
  assert.equal(await plan.getByRole("button", { name: "Implement this plan", exact: true }).isEnabled(), true)
  await plan.getByRole("button", { name: "Open plan", exact: true }).click()
  const panel = () => page.locator(".bb-workspace-panel:visible")
  await panel().locator(".bb-run-panel").waitFor()
  await poll(
    () => call("runs.get", { sessionID: chat.id }),
    (run) => run.plan?.text.trim() === longPlan,
    "complete plan saved",
  )
  await panel().getByText("Verify fixture step 80", { exact: false }).waitFor()
  await page.locator(".bb-panel-collapse:visible").getByRole("button", { name: "Collapse panel", exact: true }).click()
  const removePlan = main().getByRole("button", { name: "Remove Plan mode", exact: true })
  if (await removePlan.count()) await removePlan.click()
  check(
    "Completed proposed plans always show a compact excerpt; no inline expand/collapse exists; Open plan saves and renders the complete source in the panel",
  )

  await admit("fixture-changed-lines", { mode: "normal", agent: "build" })
  await idle("fixture-changed-lines")
  const diffs = await poll(
    async () =>
      (await api(`/session/${chat.id}/message`)).filter((row) => row.info.role === "user").at(-1)?.info.summary
        ?.diffs ?? [],
    (rows) =>
      rows.some(
        (row) => basename(row.file ?? "") === "fixture-changes.txt" && row.additions === 3 && row.deletions === 1,
      ),
    "durable changed-lines summary",
  )
  assert.equal(
    await readFile(fixtureFile, "utf8"),
    "Updated fixture line\nAdded fixture line two\nAdded fixture line three\n",
  )
  const changes = main().locator('[data-component="composer-changes"]')
  await changes.waitFor()
  assert.equal(await changes.locator(".bb-lines-added").textContent(), "+3")
  assert.equal(await changes.locator(".bb-lines-removed").textContent(), "−1")
  const placement = await changes.evaluate((node) => ({
    changesBottom: node.getBoundingClientRect().bottom,
    composerTop: node.parentElement.querySelector('[data-component="prompt-input-v2"]').getBoundingClientRect().top,
  }))
  assert.ok(placement.changesBottom <= placement.composerTop)
  report.geometry.push({ changedLines: placement, diffCount: diffs.length })
  await changes.click()
  await panel().getByRole("tab", { name: "Code review", exact: true }).waitFor()
  await page.locator(".bb-panel-collapse:visible").getByRole("button", { name: "Collapse panel", exact: true }).click()
  await page.emulateMedia({ colorScheme: "light" })
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "light")
  if (capture) {
    if (await plan.count()) await plan.scrollIntoViewIfNeeded()
    const path = join(results, reportName + "-composer-light.png")
    report.screenshots.push({ path, ...(await captureHidden(app, page, path)) })
  }
  check(
    "An actual owned file edit produces durable +3/−1 counts directly above the composer; selecting the summary opens its review tab",
  )

  assert.deepEqual(report.errors, [])
  assert.ok(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
    ),
  )
  report.localRequests = requests.length
  check(
    "Zero renderer errors; every QA window remained hidden/unfocused; all model requests stayed on the fictional local provider",
  )
} catch (error) {
  report.failure = error.stack || String(error)
  if (page)
    report.failureUI = await page
      .evaluate(() => ({ route: location.pathname, text: document.body.innerText.slice(0, 2800) }))
      .catch(() => undefined)
  process.exitCode = 1
} finally {
  await app?.close()
  await new Promise((done) => fixture.close(done))
  await writeFile(join(results, reportName + ".json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
