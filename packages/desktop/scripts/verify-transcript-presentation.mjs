import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { captureHidden } from "./qa-capture.mjs"

// Only owned windows, data and local provider requests. Never touches live credentials or desktop focus.
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
// Leave room for Git's nested snapshot repository on Windows.
const profile = join(root, ".tools/qa/tp-" + randomUUID())
const data = join(profile, "BitsBytesChat")
const directory = join(data, "workspace")
const results = join(root, ".tools/qa/results")
const reportName = process.env.BB_QA_REPORT || "transcript-presentation"
const capture = process.env.BB_QA_CAPTURE === "1"
const report = { checks: [], errors: [], geometry: [], screenshots: [], profile, syntheticProvider: true }
const executablePath =
  process.env.BB_QA_EXECUTABLE || join(root, ".tools/qa/workspace-refinements-package/win-unpacked/BitsBytesChat.exe")
report.executablePath = executablePath
if (!process.env.BB_QA_MAIN) {
  report.asarSHA256 = createHash("sha256")
    .update(await readFile(join(dirname(executablePath), "resources/app.asar")))
    .digest("hex")
}
const fixtureFile = join(directory, "fixture-changes.txt")
const pngPath = join(directory, "recorded-preview.png")
const png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGNUSFjAgA0wYRUdtBIA5UgBMGHyow0AAAAASUVORK5CYII="
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
    roleOrder: input.messages?.map((row) => row.role),
    tools: input.messages?.flatMap((row) => row.tool_calls?.map((call) => call.function?.name) ?? []) ?? [],
  })
  const matches = (name, tool) => name === tool || name?.endsWith("_" + tool)
  const named = (tool) => input.tools?.find((entry) => matches(entry.function?.name, tool))?.function.name
  const executed = (tool) =>
    input.messages?.slice(lastUser).some((row) => row.tool_calls?.some((call) => matches(call.function?.name, tool)))
  const calls = []
  const shellName = named("bash") || named("shell")
  if (latest.includes("fixture-transcript")) {
    if (!executed("read")) calls.push({ name: named("read"), args: { filePath: fixtureFile } })
    else if (!executed("edit"))
      calls.push({
        name: named("edit"),
        args: {
          filePath: fixtureFile,
          oldString: "Original fixture line",
          newString: "Updated fixture line\nAdded fixture line two\nAdded fixture line three",
        },
      })
    else if (!executed("bash") && !executed("shell"))
      calls.push(
        {
          name: shellName,
          args: { command: "echo Local verification passed", description: "Verify local fixture" },
        },
        { name: shellName, args: { command: "exit 3", description: "Demonstrate a nonzero exit" } },
      )
  }
  if (latest.includes("fixture-image") && !executed("read"))
    calls.push({ name: named("read"), args: { filePath: pngPath } })
  if (latest.includes("fixture-failure") && !executed("read"))
    calls.push({ name: named("read"), args: { filePath: join(directory, "missing-fixture.txt") } })
  if ((latest.includes("fixture-approval") || latest.includes("fixture-auto-write")) && !executed("write"))
    calls.push({
      name: named("write"),
      args: {
        filePath: join(directory, latest.includes("fixture-auto-write") ? "auto.txt" : "approval.txt"),
        content: "Approved fixture",
      },
    })
  requests.at(-1).emitted = calls.map((call) => call.name)
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
  if (latest.includes("fixture-transcript") && calls.length && !executed("read")) {
    emit({
      reasoning_content:
        "I will use the recorded file and verify the resulting change. This is controlled provider text, not generated reasoning.",
    })
    emit({ content: "I'll inspect the file, make a small update and verify it locally." })
  }
  if (latest.includes("fixture-held-turn")) {
    emit({ reasoning_content: "Checking the new request while previous interrupted activity stays static." })
    await new Promise((done) => res.once("close", done))
    return
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
  else
    emit({
      content: latest.includes("fixture-long-plan")
        ? `<proposed_plan>\n${longPlan}\n</proposed_plan>`
        : latest.includes("fixture-transcript")
          ? `Updated the document and verified the result. The diagnostic command returned exit code 3.\n\nReview [fixture-changes.txt](/${fixtureFile.replaceAll("\\", "/")}) and the [local reference](http://127.0.0.1:${fixture.address().port}/source).\n\nSaved at \`${fixtureFile}\`.`
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
await writeFile(pngPath, Buffer.from(png, "base64"))
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
            name: "Transcript QA fixture",
            reasoning: true,
            interleaved: { field: "reasoning_content" },
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
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
    executablePath,
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
  page = await app.firstWindow({ timeout: 120000 })
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
    // Match the desktop composer's per-chat tool policy; the engine's bare API
    // default permits edits before the desktop approval broker sees a request.
    const session = await api("/session", "POST", {
      title,
      permission: [
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "read", pattern: "*", action: "allow" },
      ],
    })
    await api(`/session/${session.id}/prompt_async`, "POST", {
      noReply: true,
      agent: "build",
      model,
      parts: [{ type: "text", text: "Durable fictional input" }],
    })
    return session
  }
  const chat = await create("Transcript comparison")
  const other = await create("Access isolation")
  const member = await create("Project conversation")
  const project = await api("/api/organization/projects", "POST", { name: "Example project" })
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
  const access = () => main().getByRole("button", { name: "Tool access for this chat", exact: true })
  const snapshot = async (label) => {
    if (!capture) return
    const path = join(results, reportName + "-" + label + ".png")
    report.screenshots.push({ label, path, ...(await captureHidden(app, page, path)) })
  }
  const theme = async (scheme) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForFunction((scheme) => document.documentElement.dataset.colorScheme === scheme, scheme)
  }
  const select = async (mode) => {
    await access().click()
    await page
      .getByRole("menuitemradio", {
        name: mode === "ask" ? /^Ask for approval/ : mode === "auto" ? /^Approve for me/ : /^Full access/,
      })
      .click()
    await poll(
      () => call("access.get", { sessionID: chat.id }),
      (value) => value.mode === mode,
      "host access " + mode,
    )
    await poll(
      () => access().getAttribute("data-mode"),
      (value) => value === mode,
      "composer access " + mode,
    )
  }
  const send = async (marker) => {
    const before = (await api(`/session/${chat.id}/message`)).filter((row) => row.info.role === "user").length
    await editor().fill(marker)
    await editor().press("Enter")
    await poll(
      () => api(`/session/${chat.id}/message`),
      (rows) =>
        rows.filter((row) => row.info.role === "user").length > before &&
        rows.at(-1)?.info.role === "assistant" &&
        rows.at(-1)?.info.finish === "stop",
      marker,
    )
    await page.waitForTimeout(500)
    if (marker !== "fixture-transcript") {
      const work = main().locator('[data-component="completed-work"] button').last()
      if ((await work.count()) && (await work.getAttribute("aria-expanded")) === "false") await work.click()
    }
    return api(`/session/${chat.id}/message`)
  }
  for (const mode of ["full", "ask", "auto", "full", "auto", "ask"]) await select(mode)
  check("All six pointer transitions change the real per-chat host mode and composer")
  assert.equal((await call("access.get", { sessionID: other.id })).mode, "ask")
  await access().click()
  const firstChoice = page.getByRole("menuitemradio", { name: /^Ask for approval/ })
  await firstChoice.focus()
  await firstChoice.press("ArrowDown")
  await page.getByRole("menuitemradio", { name: /^Approve for me/ }).press("Enter")
  await poll(
    () => access().getAttribute("data-mode"),
    (value) => value === "auto",
    "keyboard access",
  )
  check("Keyboard selection works without changing another conversation's access")
  for (const zoom of [1, 1.25]) {
    await app.evaluate(
      ({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom),
      zoom,
    )
    await theme(zoom === 1 ? "light" : "dark")
    await access().click()
    const menu = page.locator(".bb-access-menu")
    const hitTargets = await menu.evaluate((node) =>
      [...node.querySelectorAll('[role="menuitemradio"]')].map((item) => {
        const rect = item.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return { height: rect.height, owned: item.contains(hit) }
      }),
    )
    assert.equal(hitTargets.length, 3)
    assert.ok(hitTargets.every((row) => row.owned && row.height >= 42))
    report.geometry.push({ zoom, hitTargets })
    await snapshot(zoom === 1 ? "access-light" : "access-dark-125")
    await page.keyboard.press("Escape")
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await theme("light")
  check("Access rows have independent content-sized pointer targets in light/dark and at 100/125%")
  await page.locator(".bb-org-account").getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("tab", { name: "General", exact: true }).click()
  await page.locator('[data-action="settings-feed-reasoning-summaries"] [data-slot="switch-control"]').click()
  await page.keyboard.press("Escape")
  await select("full")
  const history = await send("fixture-transcript")
  const work = main().locator('[data-component="completed-work"] button').last()
  await work.waitFor()
  assert.equal(await work.getAttribute("aria-expanded"), "false")
  assert.equal(await main().locator(".bb-tool-activity").count(), 0)
  await main()
    .getByText(/Updated the document and verified the result/)
    .waitFor()
  const compactPath = main().locator('code[data-compact-file-reference="true"]').last()
  await compactPath.waitFor()
  assert.equal(await compactPath.innerText(), "fixture-changes.txt")
  assert.equal(await compactPath.getAttribute("title"), fixtureFile)
  assert.ok(history.flatMap((row) => row.parts).some((part) => part.type === "text" && part.text.includes(fixtureFile)))
  check(
    "Absolute file references show a compact filename and icon while the title and original response retain the full path",
  )
  await snapshot("completed-collapsed-light")
  await work.focus()
  await work.press("Enter")
  assert.equal(await work.getAttribute("aria-expanded"), "true")
  await page.waitForTimeout(350)
  const expandedWorkBounds = await work.boundingBox()
  const expandedChatBounds = await main().boundingBox()
  assert.ok(
    expandedWorkBounds &&
      expandedWorkBounds.y >= expandedChatBounds.y &&
      expandedWorkBounds.y + expandedWorkBounds.height < expandedChatBounds.y + expandedChatBounds.height - 140,
  )
  check("Completed work defaults collapsed, retains the actual final answer, expands with the keyboard and keeps its header in view")
  const tools = history.flatMap((row) => row.parts).filter((part) => part.type === "tool")
  report.operations = tools.map((part) => ({ tool: part.tool, state: part.state }))
  report.recordedParts = history.flatMap((row) => row.parts).map((part) => ({ type: part.type, id: part.id }))
  assert.ok(tools.some((part) => part.tool === "read" && part.state.status === "completed"))
  assert.ok(tools.some((part) => part.tool === "edit" && part.state.status === "completed"))
  assert.ok(tools.some((part) => ["bash", "shell"].includes(part.tool) && part.state.metadata?.exit === 0))
  assert.ok(tools.some((part) => ["bash", "shell"].includes(part.tool) && part.state.metadata?.exit === 3))
  assert.equal(
    await readFile(fixtureFile, "utf8"),
    "Updated fixture line\nAdded fixture line two\nAdded fixture line three\n",
  )
  const group = main().locator(".bb-tool-activity").last()
  const trigger = group.locator(':scope > [data-slot="collapsible-trigger"]')
  await trigger.waitFor()
  assert.match(await trigger.innerText(), /Explored and edited files, ran commands/)
  assert.equal(await trigger.getAttribute("aria-expanded"), "false")
  assert.equal(await group.locator('[data-slot="activity-item"]').count(), 0)
  const changes = main().locator(".bb-turn-changes").last()
  assert.equal(await changes.locator(":scope > button").getAttribute("aria-expanded"), "false")
  assert.equal(await main().locator('[data-component="text-shimmer"][data-active="true"]').count(), 0)
  const reasoning = main().locator(".bb-reasoning").last()
  await reasoning.waitFor()
  assert.equal(await reasoning.locator(":scope > button").getAttribute("aria-expanded"), "false")
  await snapshot("collapsed-light")
  check("Actual read/edit/commands group compactly; reasoning and duplicate file summary start collapsed")
  await trigger.click()
  await group.locator('[data-slot="activity-item"]').last().waitFor()
  assert.equal(await group.locator('[data-slot="activity-item"]').count(), 4)
  const read = group.locator('[data-slot="activity-item"]').first()
  await read.getByRole("button").first().click()
  await read.locator('[data-component="tool-raw-details"]').waitFor()
  assert.match(await read.innerText(), /Original fixture line/)
  await read.getByRole("button").first().click()
  const commands = group
    .locator('[data-slot="activity-item"]')
    .filter({ hasText: /echo Local verification passed|exit 3/ })
  assert.equal(await commands.count(), 2)
  await commands.nth(0).getByRole("button").first().click()
  await commands.nth(0).locator('[data-slot="command-status"]').waitFor()
  assert.equal((await commands.nth(0).locator('[data-slot="command-status"]').innerText()).trim(), "Success")
  assert.match(await commands.nth(0).innerText(), /Local\s+verification\s+passed/)
  await commands.nth(1).getByRole("button").first().click()
  await commands.nth(1).locator('[data-slot="command-status"]').waitFor()
  assert.match(await commands.nth(1).innerText(), /Exited with code 3/)
  const bounds = await group.locator('[data-slot="activity-list"]').evaluate((node) => ({
    height: node.clientHeight,
    limit: parseFloat(getComputedStyle(node).maxHeight),
    scroll: node.scrollHeight,
  }))
  assert.ok(bounds.height <= bounds.limit + 1)
  report.geometry.push({ boundedActivity: bounds })
  await snapshot("expanded-commands-light")
  await theme("dark")
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25))
  await snapshot("expanded-commands-dark-125")
  check(
    "Expanded operations render actual read data, Shell output, verified Success and nonzero exit in a bounded list",
  )
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await theme("light")
  await trigger.click()
  await reasoning.locator(":scope > button").click()
  assert.match(await reasoning.innerText(), /controlled provider text/)
  await reasoning.locator(":scope > button").click()
  check("Completed recorded reasoning remains available on demand and has no thinking animation")
  const fileLink = main().locator('a[data-reference-kind="file"]').filter({ hasText: "fixture-changes.txt" }).last()
  await fileLink.waitFor()
  assert.match(await fileLink.getAttribute("href"), /fixture-changes.txt/)
  await fileLink.click()
  await page
    .locator(".bb-panel-tabs")
    .getByRole("tab", { name: /fixture-changes.txt/ })
    .waitFor()
  check("The styled file reference opens its actual document in the existing panel")
  const final = history.findLast((row) => row.info.role === "assistant")
  const text = final.parts.find((part) => part.type === "text")
  await api(`/session/${chat.id}/message/${final.info.id}/part/${text.id}`, "PATCH", {
    ...text,
    metadata: {
      ...text.metadata,
      sources: [
        {
          id: "qa-source",
          sourceType: "url",
          title: "Local verified reference",
          url: `http://127.0.0.1:${fixture.address().port}/source`,
        },
      ],
    },
  })
  const source = main()
    .locator('[data-component="message-sources"]')
    .last()
    .getByRole("button")
    .filter({ hasText: "Local verified reference" })
  await source.waitFor()
  await source.click()
  await poll(
    () => call("browser.list"),
    (rows) => rows.some((row) => row.sessionID === chat.id && row.url.includes("/source") && !row.loading),
    "owned source browser",
  )
  for (const browser of await call("browser.list")) await call("browser.close", { id: browser.id })
  check("Recorded source metadata is preserved and opens in the owning chat's browser")
  await send("fixture-image")
  const card = main().locator('[data-slot="recorded-image-card"]').last()
  await card.waitFor()
  await card.locator('[data-slot="recorded-image-dimensions"]').waitFor()
  assert.match(await card.innerText(), /8 × 8/)
  assert.ok((await card.getByAltText("recorded-preview.png").getAttribute("src")).includes(png))
  await writeFile(pngPath, "Changed original after read")
  await snapshot("image-read")
  await card.getByRole("button", { name: "Open image" }).click()
  await page
    .locator(".bb-panel-tabs")
    .getByRole("tab", { name: /recorded-preview.png/ })
    .waitFor()
  assert.equal(
    await page
      .locator(".bb-panel-tabs")
      .getByRole("tab", { name: /fixture-changes.txt/ })
      .count(),
    1,
  )
  check(
    "Image read stays separate from activity grouping, keeps decoded dimensions and immutable bytes, and preserves the document tab",
  )
  await send("fixture-failure")
  const failed = main()
    .locator('[data-component="collapsible"]')
    .filter({ has: page.locator('[data-component="tool-error-card-icon"]') })
    .last()
  await failed.waitFor()
  await poll(
    () => failed.innerText(),
    (value) => /Read/.test(value),
    "rendered failure label",
  )
  const errorCard = main().locator('[data-kind="tool-error-card"]').last()
  assert.notEqual(await errorCard.getAttribute("data-variant"), "error")
  assert.equal(await errorCard.evaluate((element) => getComputedStyle(element).borderLeftWidth), "0px")
  await failed.locator('[data-slot="collapsible-trigger"]').click()
  await poll(
    () => failed.innerText(),
    (value) => /missing-fixture/.test(value),
    "original missing-file diagnostic",
  )
  const errorDetails = await errorCard.locator('[data-slot="tool-error-card-content"]').evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    overflow: getComputedStyle(element).overflowY,
  }))
  assert.ok(errorDetails.height <= 360)
  assert.equal(errorDetails.overflow, "auto")
  check("A real missing-file failure remains available in work details without a task-level red error")
  // Replay recorded presentation shapes; these are not live web or Windows-control calls.
  const failureRows = await api(`/session/${chat.id}/message`)
  const recordedFailure = failureRows
    .flatMap((row) => row.parts)
    .findLast((part) => part.type === "tool" && part.state.status === "error")
  assert.ok(recordedFailure)
  const replaceRecorded = (part) =>
    api(`/session/${chat.id}/message/${recordedFailure.messageID}/part/${recordedFailure.id}`, "PATCH", part)
  await failed.locator('[data-slot="collapsible-trigger"]').click()
  await replaceRecorded({
    ...recordedFailure,
    tool: "webfetch",
    state: {
      ...recordedFailure.state,
      input: { url: "https://example.invalid/recorded-missing-page" },
      error: "StatusCode: HTTP 404 (recorded presentation fixture)",
    },
  })
  await poll(
    () => errorCard.innerText(),
    (value) => /Page unavailable/.test(value),
    "short recorded 404 status",
  )
  assert.doesNotMatch(await errorCard.innerText(), /StatusCode|recorded-missing-page/)
  await snapshot("recorded-404-collapsed")
  await failed.locator('[data-slot="collapsible-trigger"]').click()
  await poll(
    () => errorCard.innerText(),
    (value) => /HTTP 404/.test(value),
    "original recorded 404 diagnostic",
  )
  await failed.locator('[data-slot="collapsible-trigger"]').click()
  check("A recorded webfetch 404 renders a quiet Page unavailable row and preserves its exact diagnostic on expansion")
  report.recordedPresentationFixtures = [
    "webfetch HTTP 404",
    "windows-control PowerShell",
    "windows-control FileSystem",
  ]
  for (const [tool, title] of [
    ["windows-control_PowerShell", "Ran PowerShell"],
    ["windows-control_FileSystem", "Worked with files"],
  ]) {
    await replaceRecorded({
      ...recordedFailure,
      tool,
      state: {
        status: "completed",
        input: {
          command: "recorded-only-command-body",
          path: "recorded-only-destination-path",
          description: "Inspect a copied project",
        },
        output: "Recorded fixture; no Windows-control call was executed.",
        title: tool,
        metadata: {},
        time: recordedFailure.state.time,
      },
    })
    const recordedGroup = main().locator(`.bb-tool-activity[data-timeline-part-ids*="${recordedFailure.id}"]`)
    await recordedGroup.waitFor()
    const recordedTrigger = recordedGroup.locator(':scope > [data-slot="collapsible-trigger"]')
    if ((await recordedTrigger.getAttribute("aria-expanded")) !== "true") await recordedTrigger.click()
    await poll(
      () => recordedGroup.innerText(),
      (value) => value.includes(title),
      "short recorded Windows tool label",
    )
    assert.doesNotMatch(
      await recordedGroup.innerText(),
      /recorded-only-command-body|recorded-only-destination-path|windows-control_/,
    )
  }
  await snapshot("recorded-windows-tools")
  check(
    "Recorded Windows MCP operations join activity groups and expose short action labels without raw command/path clutter",
  )
  await replaceRecorded(recordedFailure)
  const orphan = tools.find((part) => part.tool === "read")
  await api(`/session/${chat.id}/message/${orphan.messageID}/part/${orphan.id}`, "PATCH", {
    ...orphan,
    state: {
      status: "running",
      input: orphan.state.input,
      time: { start: orphan.state.time.start },
      metadata: orphan.state.metadata,
    },
  })
  await editor().fill("fixture-held-turn")
  await editor().press("Enter")
  await poll(
    () => main().locator('.bb-reasoning [data-component="text-shimmer"][data-active="true"]').count(),
    (value) => value > 0,
    "new owned reasoning",
  )
  const oldGroup = main().locator(`.bb-tool-activity[data-timeline-part-ids*="${orphan.id}"]`)
  await oldGroup.waitFor()
  assert.equal(await oldGroup.locator('[data-component="text-shimmer"][data-active="true"]').count(), 0)
  assert.match(await oldGroup.innerText(), /Interrupted/)
  await main().getByRole("button", { name: "Stop", exact: true }).click()
  await poll(
    () => main().locator('[data-component="text-shimmer"][data-active="true"]').count(),
    (value) => value === 0,
    "all activity static after Stop",
  )
  check(
    "A seeded historical running part stays static during a real newer turn, and Stop ends the owned reasoning animation",
  )
  await select("ask")
  await editor().fill("fixture-approval")
  await editor().press("Enter")
  await main().getByRole("button", { name: "Allow once", exact: true }).waitFor()
  assert.equal(await readFile(join(directory, "approval.txt")).catch(() => null), null)
  await main().getByRole("button", { name: "Allow once", exact: true }).click()
  await poll(
    () => readFile(join(directory, "approval.txt"), "utf8").catch(() => ""),
    (value) => value === "Approved fixture",
    "authorized write",
  )
  await poll(
    () => api(`/session/${chat.id}/message`),
    (rows) => rows.at(-1)?.info.finish === "stop",
    "approval finish",
  )
  check("Ask mode truly gates a write until Allow once; switching is more than a label change")
  await select("auto")
  await editor().fill("fixture-auto-write")
  await editor().press("Enter")
  await poll(
    () => readFile(join(directory, "auto.txt"), "utf8").catch(() => ""),
    (value) => value === "Approved fixture",
    "automatic safe write",
  )
  await poll(
    () => api(`/session/${chat.id}/message`),
    (rows) => rows.at(-1)?.info.finish === "stop",
    "auto finish",
  )
  check("Approve for me allows the existing policy's safe workspace write without a manual prompt")
  await open(other)
  assert.equal(
    await page.locator(`.bb-workspace-chat[data-bb-chat="${other.id}"] .bb-chat-access`).getAttribute("data-mode"),
    "ask",
  )
  await open(chat)
  await poll(
    () => access().getAttribute("data-mode"),
    (value) => value === "auto",
    "restored access",
  )
  await page.locator(".bb-org-sidebar").getByRole("button", { name: "New chat", exact: true }).click()
  // The native New session route is a composer, not a durable ChatWorkspace yet.
  const draftAccess = page.locator(".bb-chat-access:visible").last()
  await poll(
    () => draftAccess.getAttribute("data-mode"),
    (value) => value === "ask",
    "draft default access",
  )
  await draftAccess.click()
  await page.getByRole("menuitemradio", { name: /^Approve for me/ }).click()
  await poll(
    () => draftAccess.getAttribute("data-mode"),
    (value) => value === "auto",
    "draft selected access",
  )
  const draftEditor = page.locator("[contenteditable=true]:visible").last()
  await draftEditor.fill("fixture-draft-promotion")
  await draftEditor.press("Enter")
  const promoted = await poll(
    () => page.locator(".bb-workspace-chat[data-bb-chat]:visible").last().getAttribute("data-bb-chat"),
    (value) => value && value !== chat.id && value !== other.id && !value.startsWith("draft"),
    "draft promotion",
  )
  await poll(
    () => call("access.get", { sessionID: promoted }),
    (value) => value.mode === "auto",
    "promoted access",
  )
  check("New chats start in Ask and retain the selected access mode when their first message promotes the draft")
  await open(chat)
  await page.reload()
  await page.locator(".bb-org-sidebar").waitFor({ timeout: 90000 })
  await open(chat)
  await poll(
    () => access().getAttribute("data-mode"),
    (value) => value === "auto",
    "reload mode",
  )
  assert.equal(await main().locator('[data-component="text-shimmer"][data-active="true"]').count(), 0)
  check("Per-chat access and static completed history survive navigation and renderer reload")
  assert.deepEqual(report.errors, [])
  report.transcript = await main().innerText()
} catch (error) {
  report.failure = error.stack || String(error)
  if (page) {
    report.failureUI = await page
      .evaluate(() => ({ route: location.pathname, text: document.body.innerText.slice(-6500) }))
      .catch(() => undefined)
    await snapshotFailure().catch(() => undefined)
  }
  process.exitCode = 1
} finally {
  await app?.close()
  await new Promise((done) => fixture.close(done))
  report.providerRequests = requests
  await writeFile(join(results, reportName + ".json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
async function snapshotFailure() {
  if (capture) await captureHidden(app, page, join(results, reportName + "-failure.png"))
}
