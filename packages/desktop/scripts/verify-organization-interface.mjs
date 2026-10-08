import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { join, resolve } from "node:path"
import { captureHidden } from "./qa-capture.mjs"

// Run from packages/desktop. Every window, conversation and file belongs to a
// fresh hidden QA profile; this does not connect to an account or the user's app.
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/organization-interface-" + randomUUID())
const data = join(profile, "BitsBytesChat")
const directory = join(data, "workspace")
const research = join(data, "Research folder")
const secondFolder = join(data, "Design folder")
const basename = process.env.BB_QA_REPORT || "organization-interface"
const output = join(root, ".tools/qa/results")
const report = { profile, checks: [], errors: [], screenshots: [], geometry: [], queryTimings: [], requests: 0 }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (text) => {
  report.checks.push(text)
  console.log("PASS", text)
}
const poll = async (read, accept, label) => {
  for (let index = 0; index < 200; index++) {
    const value = await read()
    if (accept(value)) return value
    await wait(100)
  }
  throw Error("Timed out: " + label)
}
const fixture = createServer(async (req, res) => {
  if (req.url?.startsWith("/browser")) {
    res.setHeader("content-type", "text/html")
    res.end(
      `<!doctype html><title>Organization browser</title><h1>${req.url.endsWith("two") ? "Second page" : "First page"}</h1><a href="/browser/two">Next page</a>`,
    )
    return
  }
  for await (const chunk of req) void chunk
  report.requests++
  res.writeHead(200, { "content-type": "text/event-stream" })
  res.write(
    "data: " +
      JSON.stringify({
        id: "qa-" + randomUUID(),
        object: "chat.completion.chunk",
        model: "fixture",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Completed the fictional sidebar QA request." },
            finish_reason: null,
          },
        ],
      }) +
      "\n\n",
  )
  res.end(
    "data: " +
      JSON.stringify({
        id: "qa-end",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      }) +
      "\n\ndata: [DONE]\n\n",
  )
})
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve))
const fixtureURL = "http://127.0.0.1:" + fixture.address().port
await Promise.all(
  [directory, research, secondFolder, join(data, "config/opencode"), output].map((path) =>
    mkdir(path, { recursive: true }),
  ),
)
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    provider: {
      "organization-qa": {
        name: "Local QA",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: fixtureURL + "/v1", apiKey: "fixture-only" },
        models: { fixture: { name: "Sidebar QA fixture", limit: { context: 128000, output: 8192 } } },
      },
    },
    model: "organization-qa/fixture",
  }),
)
let app, page, api, call
const migrationReady = Promise.withResolvers()
const migrationSeen = Promise.withResolvers()
try {
  app = await _electron.launch({
    executablePath:
      process.env.BB_QA_EXECUTABLE || join(root, ".tools/qa/interface-patch-package/win-unpacked/BitsBytesChat.exe"),
    ...(process.env.BB_QA_MAIN ? { args: [process.env.BB_QA_MAIN] } : {}),
    env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", BB_QA_CAPTURE: "1", LOCALAPPDATA: profile },
    timeout: 90000,
  })
  await app.context().route("**/api/organization/migrate", async (route) => {
    migrationSeen.resolve()
    await migrationReady.promise
    await route.continue()
  })
  page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  await page.evaluate(() => {
    // Keep completion notifications inside this isolated, hidden test process.
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: class extends EventTarget {
        static permission = "denied"
        static async requestPermission() {
          return "denied"
        }
        constructor() {
          super()
        }
        close() {}
      },
    })
  })
  page.on("pageerror", (error) => report.errors.push(error.message))
  report.sessionCreates = []
  report.agentBootstraps = []
  page.on("response", async (response) => {
    if (!new URL(response.url()).pathname.match(/\/(?:api\/)?agent$|\/app\/agents$/)) return
    try {
      const value = await response.json()
      const rows = Array.isArray(value) ? value : (value.data ?? [])
      const request = response.request()
      report.agentBootstraps.push({
        resource: (
          new URL(response.url()).pathname +
          " " +
          [...new URL(response.url()).searchParams.values()].join(" ") +
          " " +
          decodeURIComponent(request.headers()["x-opencode-directory"] ?? "")
        )
          .replace(/\\+/g, "/")
          .toLowerCase(),
        status: response.status(),
        ready: rows.some((row) => row.name === "build"),
      })
    } catch {}
  })
  page.on("request", (request) => {
    if (request.method() !== "POST" || !new URL(request.url()).pathname.match(/\/(?:api\/)?session$/)) return
    report.sessionCreates.push({
      path: new URL(request.url()).pathname,
      directory: request.headers()["x-opencode-directory"],
      body: request.postDataJSON(),
    })
  })
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    assertHidden()
    function assertHidden() {
      if (BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()))
        throw Error("QA window became visible")
    }
    win.webContents.setBackgroundThrottling(false)
    win.setMinimumSize(0, 0)
    win.setContentSize(1380, 900)
    win.webContents.setZoomFactor(1)
  })
  const server = await page.evaluate(() => window.api.awaitInitialization())
  const headers = { "content-type": "application/json" }
  if (server.password)
    headers.authorization =
      "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")
  api = async (path, method = "GET", body, cwd = directory) => {
    const started = performance.now()
    const response = await fetch(server.url + path, {
      method,
      headers: { ...headers, "x-opencode-directory": encodeURIComponent(cwd) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(45000),
    })
    if (!response.ok) throw Error(`${path}: ${response.status} ${(await response.text()).slice(0, 400)}`)
    const result = response.status === 204 ? undefined : await response.json()
    if (path === "/api/organization/chats/query")
      report.queryTimings.push({
        kind: body?.search
          ? "search"
          : body?.projectID
            ? "project"
            : body?.pinned
              ? "pinned"
              : body?.archived
                ? "archived"
                : "recent",
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        summaries: result.data.length,
        limit: body?.limit ?? 50,
        next: Boolean(result.next),
      })
    return result
  }
  const org = (path, method = "GET", body) => api("/api/organization" + path, method, body)
  call = (method, args = {}) =>
    page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
  const currentRoute = () =>
    page.evaluate(
      () =>
        Object.entries(localStorage).find(
          ([key]) => key.startsWith("opencode.desktop.window.") && key.endsWith(".last-active-url"),
        )?.[1] ?? "/",
    )
  const create = (title, cwd = directory) => api("/session", "POST", { title }, cwd)
  const open = async (chat) => {
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), {
      sessionID: chat.id,
      directory: chat.directory ?? directory,
    })
    await page.locator(`.bb-workspace-chat[data-bb-chat="${chat.id}"] [contenteditable=true]`).first().waitFor()
  }
  const row = (chat) => page.locator(`.bb-org-sidebar .bb-org-row[data-session-id="${chat.id}"]`).first()
  const action = async (chat, name) => {
    // Collection runs use the prior package while row-identity repairs are pending.
    if (process.env.BB_QA_COLLECT) await wait(1500)
    await row(chat).getByRole("button", { name: "Chat actions", exact: true }).click()
    await page.getByRole("menuitem", { name, exact: true }).click()
  }
  const captures = async (suffix) => {
    const path = join(output, basename + "-" + suffix + ".png")
    const viewport = await captureHidden(app, page, path)
    report.screenshots.push({ path, ...viewport })
  }
  const theme = async (scheme) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForFunction((scheme) => document.documentElement.dataset.colorScheme === scheme, scheme)
  }

  const imported = await create("Research notes", research)
  const design = await create("Design questions", secondFolder)
  const home = await create("General conversation")
  await Promise.race([
    migrationSeen.promise,
    wait(15000).then(() => {
      throw Error("The migration fixture did not intercept the first renderer request")
    }),
  ])
  const migration = {
    projects: [
      { directory: research, name: "Research project" },
      { directory: secondFolder, name: "Design project" },
      { directory },
    ],
    defaultDirectory: directory,
  }
  await org("/migrate", "POST", migration)
  const migrated = await org("/projects")
  assert.equal(migrated.length, 2)
  assert.ok(migrated.every((project) => project.count === 1))
  await org("/migrate", "POST", migration)
  assert.equal((await org("/projects")).length, 2)
  migrationReady.resolve()
  await page.locator(".bb-org-sidebar").waitFor({ timeout: 90000 })
  await row(imported).waitFor()
  await row(design).waitFor()
  await row(home).waitFor()
  assert.equal(await page.locator("[data-titlebar-tab-slot]").count(), 0)
  assert.equal(await page.locator(".bb-nav").count(), 0)
  check(
    "Real API migration imports two existing folders once, leaves the default workspace unassigned, and replaces both old navigation strips",
  )

  await page.locator(".bb-org-utilities").getByRole("button", { name: "Projects", exact: true }).click()
  for (const scheme of ["dark", "light"]) {
    await theme(scheme)
    await captures(`${scheme}-projects-manager`)
    await page.locator(".bb-org-page").getByRole("button", { name: "New project", exact: true }).click()
    await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("Creative projects")
    assert.equal(await page.getByRole("dialog").getByLabel("Default folder", { exact: true }).inputValue(), "")
    await captures(`${scheme}-project-create`)
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click()
  }
  await page.locator(".bb-org-page").getByRole("button", { name: "New project", exact: true }).click()
  await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("Creative projects")
  await page.getByRole("dialog").getByLabel("Default folder", { exact: true }).fill(research)
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click()
  const creative = await poll(
    () => org("/projects"),
    (rows) => rows.some((row) => row.name === "Creative projects"),
    "project creation",
  ).then((rows) => rows.find((row) => row.name === "Creative projects"))
  await page.locator(".bb-org-project-card").filter({ hasText: "Creative projects" }).click()
  const previousDraftURL = await currentRoute()
  await page.locator(".bb-org-page").getByRole("button", { name: "New chat", exact: true }).click()
  await poll(
    currentRoute,
    (route) => route !== previousDraftURL && route.startsWith("/new-session?"),
    "project draft route",
  )
  await page.locator(".bb-org-chat-content").getByText("Research folder", { exact: true }).waitFor()
  const draft = page.locator(".bb-org-chat-content [contenteditable=true]:visible").first()
  await draft.fill("Unsaved project draft")
  const draftURL = await currentRoute()
  await draft.evaluate((node) => {
    node.dataset.qaRetained = "yes"
  })
  await page.locator(".bb-org-utilities").getByRole("button", { name: "Recordings", exact: true }).click()
  await page.locator("#bitsbytes-utility-content").getByRole("heading", { name: "Recordings", exact: true }).waitFor()
  assert.equal(await page.locator('[data-qa-retained="yes"]').count(), 1)
  await page.locator(".bb-org-utilities").getByRole("button", { name: "Skills", exact: true }).click()
  await page.locator("#bitsbytes-utility-content").getByRole("heading", { name: "Skills", exact: true }).waitFor()
  assert.equal(await page.locator('[data-qa-retained="yes"]').textContent(), "Unsaved project draft")
  await page.locator(".bb-org-sidebar .bb-org-chat-link").filter({ hasText: "New chat" }).last().click()
  await poll(currentRoute, (route) => route === draftURL, "return to retained draft")
  assert.equal(await draft.textContent(), "Unsaved project draft")
  check("Project creation selects its default folder; Skills and Recordings preserve the mounted draft and typed text")

  await draft.fill("")
  await draft.pressSequentially("Project first response", { delay: 10 })
  await page.locator(".bb-org-chat-content").getByText("Sidebar QA fixture", { exact: true }).waitFor()
  await poll(
    () => report.agentBootstraps,
    (rows) => rows.some((row) => row.ready && row.resource.includes(research.replace(/\\+/g, "/").toLowerCase())),
    "project agent bootstrap",
  )
  if (!process.env.BB_QA_SKIP_SEND) {
    report.submitBefore = { route: await currentRoute(), body: await page.locator("body").innerText() }
    await page.locator(".bb-org-chat-content .bb-send-primary:visible").click()
    await wait(300)
    report.submitAfter = {
      route: await currentRoute(),
      body: await page.locator("body").innerText(),
      agents: (await api("/agent", "GET", undefined, research)).map((row) => row.name),
    }
  }
  const projectChats = await (
    process.env.BB_QA_SKIP_SEND
      ? Promise.reject(new Error("First Send under separate investigation"))
      : poll(
          () => org("/chats/query", "POST", { projectID: creative.id }),
          (page) => page.data.length === 1,
          "first-message membership",
        )
  ).catch(async (error) => {
    if (!process.env.BB_QA_COLLECT) throw error
    report.blockers ??= []
    report.blockers.push({ check: "Project first Send", reason: String(error), route: await currentRoute() })
    const seeded = await create("Project first response", research)
    await org("/chats/" + seeded.id, "PATCH", { projectID: creative.id })
    await open(seeded)
    return org("/chats/query", "POST", { projectID: creative.id })
  })
  const child = projectChats.data[0]
  assert.equal(child.directory.toLowerCase(), research.toLowerCase())
  if (!report.blockers?.length)
    await page
      .locator(`.bb-workspace-chat[data-bb-chat="${child.id}"]`)
      .getByText("Completed the fictional sidebar QA request.", { exact: false })
      .waitFor({ timeout: 90000 })
  await org("/projects/" + creative.id, "PATCH", { name: "Creative work", directory: secondFolder })
  assert.equal((await api("/session/" + child.id)).directory.toLowerCase(), research.toLowerCase())
  await action(child, "Move to project")
  await page.getByRole("dialog").getByRole("combobox").selectOption(migrated[0].id)
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click()
  await poll(
    () => org("/chats/query", "POST", { projectID: migrated[0].id }),
    (page) => page.data.some((chat) => chat.id === child.id),
    "chat move",
  )
  assert.equal((await api("/session/" + child.id)).directory.toLowerCase(), research.toLowerCase())
  check(
    report.blockers?.length
      ? "An explicitly created project chat preserves its execution folder through moves and changes to project defaults"
      : "First Send durably assigns the new chat to its project; moving it and changing project defaults preserve its execution folder",
  )
  await page.locator(".bb-org-utilities").getByRole("button", { name: "Projects", exact: true }).click()
  await page.locator(".bb-org-project-card").filter({ hasText: "Design project" }).click()
  await page
    .locator(".bb-org-sidebar .bb-org-row")
    .filter({ has: page.getByRole("button", { name: "Design project", exact: true }) })
    .getByRole("button", { name: "Project actions", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "Remove project, keep chats", exact: true }).click()
  await page.locator(".bb-org-project-grid").waitFor()
  await poll(
    () => org("/chats/query", "POST", { projectID: null }),
    (result) => result.data.some((chat) => chat.id === design.id),
    "removed project retains chats",
  )
  assert.equal((await api("/session/" + design.id)).directory.toLowerCase(), secondFolder.toLowerCase())
  check("Removing the selected project returns to the collection and keeps every conversation in its original folder")

  if (!process.env.BB_QA_COLLECT) {
    await row(home).getByRole("button", { name: "Chat actions", exact: true }).click()
    const menu = await page.getByRole("menu").elementHandle()
    await org("/chats/" + home.id, "PATCH", { title: "Updated with actions open" })
    await row(home).getByText("Updated with actions open", { exact: true }).waitFor()
    assert.equal(await menu.evaluate((element) => element.isConnected), true)
    await page.keyboard.press("Escape")
    check("A live server refresh preserves the same open row menu and keyboard owner")
  }
  await action(home, "Rename chat")
  await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("An older active conversation")
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click()
  await row(home).getByText("An older active conversation", { exact: true }).waitFor()
  await action(home, "Pin")
  await poll(
    () => org("/chats/query", "POST", { pinned: true }),
    (page) => page.data.some((chat) => chat.id === home.id),
    "pin",
  )
  await action(home, "Unpin")
  await action(home, "Archive chat")
  await poll(
    () => org("/chats/query", "POST", { archived: true }),
    (page) => page.data.some((chat) => chat.id === home.id),
    "archive",
  )
  await page.locator(".bb-org-sidebar").getByRole("button", { name: "Sort and filter chats", exact: true }).click()
  await page.getByRole("menuitem", { name: "Show archived chats", exact: true }).click()
  await row(home).waitFor()
  await action(home, "Restore chat")
  await poll(
    () => org("/chats/query", "POST", { archived: true }),
    (page) => !page.data.some((chat) => chat.id === home.id),
    "restore",
  )
  await page.locator(".bb-org-sidebar").getByRole("button", { name: "Sort and filter chats", exact: true }).click()
  await page.getByRole("menuitem", { name: "Show active chats", exact: true }).click()
  check("Rename, pin, unpin, archive and restore work through actual row menus and durable metadata")

  const recent = []
  for (let offset = 0; offset < 60; offset += 4)
    recent.push(
      ...(await Promise.all(
        Array.from({ length: 4 }, (_, index) => create("Recent conversation " + (offset + index + 1))),
      )),
    )
  await org("/chats/" + home.id, "PATCH", { title: "An older active conversation" })
  const first = await org("/chats/query", "POST", { limit: 50 })
  const next = await org("/chats/query", "POST", { limit: 50, cursor: first.next })
  assert.equal(first.data[0].id, home.id)
  assert.ok(next.data.length > 0)
  assert.equal(
    next.data.some((chat) => first.data.some((first) => first.id === chat.id)),
    false,
  )
  const searched = await org("/chats/query", "POST", { search: "older active", limit: 50 })
  assert.deepEqual(
    searched.data.map((chat) => chat.id),
    [home.id],
  )
  await page.locator(".bb-org-sidebar").getByRole("button", { name: "Search chats and projects", exact: true }).click()
  await page.getByRole("textbox", { name: "Search chats and projects", exact: true }).fill("older active")
  await poll(
    () => page.locator(".bb-org-sidebar .bb-org-row[data-session-id]").allTextContents(),
    (rows) =>
      rows.some((text) => text.includes("older active")) && !rows.some((text) => text.includes("Recent conversation")),
    "search",
  )
  await page.getByRole("textbox", { name: "Search chats and projects", exact: true }).press("Escape")
  await page.locator(".bb-org-sidebar").getByRole("button", { name: "View all", exact: true }).click()
  await poll(
    () => page.locator(".bb-org-page .bb-org-row").count(),
    (count) => count === 50,
    "first page",
  )
  await page.locator(".bb-org-page").getByRole("button", { name: "Show more", exact: true }).click()
  await poll(
    () => page.locator(".bb-org-page .bb-org-row").count(),
    (count) => count > 50,
    "next page",
  )
  check("Recent activity ordering, filtered search and cursor paging retain old active chats without duplicates")

  await open(home)
  const mainEditor = page.locator(`.bb-workspace-chat[data-bb-chat="${home.id}"] [contenteditable=true]`).first()
  await mainEditor.fill("Retained keyboard draft")
  await page.keyboard.press("Control+n")
  await poll(currentRoute, (route) => route.startsWith("/new-session?") && route !== draftURL, "keyboard new draft")
  await page.locator(`.bb-workspace-chat[data-bb-chat="${home.id}"]`).waitFor({ state: "hidden" })
  await page.locator(".bb-org-chat-content [contenteditable=true]:visible").first().fill("Separate new draft")
  await page.keyboard.press("Control+w")
  await row(home).getByRole("button").first().click()
  assert.equal(await mainEditor.textContent(), "Retained keyboard draft")
  const previousURL = await currentRoute()
  await page.keyboard.press("Control+Tab")
  await poll(currentRoute, (route) => route !== previousURL, "next chat shortcut")
  await page.keyboard.press("Control+Shift+Tab")
  await poll(currentRoute, (route) => route === previousURL, "previous chat shortcut")
  await open(imported)
  await page.keyboard.press("Control+[")
  await poll(currentRoute, (route) => route === previousURL, "chat history shortcut")
  check(
    "New/close/cycle/history shortcuts remain active after removing the strip, and each chat retains its composer draft",
  )

  await open(home)
  await mainEditor.fill("")
  for (const zoom of [1, 1.25]) {
    await app.evaluate(
      ({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom),
      zoom,
    )
    for (const scheme of ["dark", "light"]) {
      await theme(scheme)
      const target = row(home)
      await target.hover()
      await target.getByRole("button", { name: "Chat actions", exact: true }).focus()
      const geometry = await page.locator(".bb-org-sidebar").evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        row: element.querySelector(".bb-org-row").getBoundingClientRect().height,
        icon: element.querySelector(".bb-org-utility svg")?.getBoundingClientRect().width,
        moreOpacity: getComputedStyle(element.querySelector(".bb-org-row:focus-within .bb-org-more")).opacity,
      }))
      assert.ok(Math.abs(geometry.width - 332) <= 1)
      assert.ok(Math.abs(geometry.row - 28) <= 1)
      assert.equal(geometry.moreOpacity, "1")
      report.geometry.push({ zoom, scheme, ...geometry })
      await captures(`${scheme}-${Math.round(zoom * 100)}-sidebar`)
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  check(
    "Actual dark/light sidebar captures at 100% and 125% retain 332px layout, 28px rows, and visible hover/keyboard actions",
  )

  const browser = await call("browser.open", { sessionID: home.id, url: fixtureURL + "/browser/one" })
  await page.locator(".bb-browser-toolbar").waitFor()
  const preferredPanelWidth = () =>
    page.evaluate((sessionID) => {
      const saved = Object.entries(localStorage).find(
        ([key]) => key.startsWith("bitsbytes.panels.v2:") && key.endsWith(":" + sessionID),
      )
      return saved && JSON.parse(saved[1]).width
    }, home.id)
  const preferredWidth = await preferredPanelWidth()
  assert.equal(typeof preferredWidth, "number")
  const browserFrame = () =>
    page.locator(".bb-browser-host").evaluate((element) => {
      const box = (target) => {
        const rect = target.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
      const panel = element.closest(".bb-workspace-panel")
      const chat = panel.closest(".bb-workspace").querySelector(":scope > .bb-workspace-chat")
      const header = [...panel.querySelectorAll(".bb-panel-header button")].filter((button) => button.offsetWidth)
      const actions = panel.querySelector('.bb-browser-toolbar button[aria-label="Browser actions"]')
      const submit = chat.querySelector(".bb-send-primary")
      return {
        host: box(element),
        panel: box(panel),
        chat: box(chat),
        header: header.map(box),
        actions: actions && box(actions),
        submit: !chat.inert && submit ? box(submit) : undefined,
        inert: chat.inert,
        overlay: panel.classList.contains("bb-workspace-panel-overlay"),
        viewport: { width: innerWidth, height: innerHeight },
      }
    })
  const contained = (rect, area) =>
    rect && rect.width > 0 && rect.height > 0 && rect.x >= area.x - 1 && rect.y >= area.y - 1 &&
    rect.x + rect.width <= area.x + area.width + 1 && rect.y + rect.height <= area.y + area.height + 1
  const frameFits = (frame) => {
    const viewport = { x: 0, y: 0, ...frame.viewport }
    return contained(frame.panel, viewport) && contained(frame.host, frame.panel) &&
      contained(frame.actions, frame.panel) && frame.header.every((item) => contained(item, frame.panel)) &&
      (frame.inert ? frame.overlay : contained(frame.submit, frame.chat))
  }
  const address = page.locator(".bb-browser-toolbar input")
  await address.fill(fixtureURL + "/browser/draft")
  await call("browser.navigate", { id: browser.id, url: fixtureURL + "/browser/two" })
  await poll(
    () => call("browser.list"),
    (rows) => rows.some((row) => row.id === browser.id && row.url.endsWith("/two") && !row.loading),
    "browser navigation",
  )
  assert.equal(await address.inputValue(), fixtureURL + "/browser/draft")
  await address.press("Escape")
  assert.equal(await address.inputValue(), fixtureURL + "/browser/two")
  await page.locator(".bb-browser-toolbar").getByRole("button", { name: "Back", exact: true }).click()
  await poll(
    () => call("browser.list"),
    (rows) => rows.some((row) => row.id === browser.id && row.url.endsWith("/one")),
    "browser back",
  )
  for (const zoom of [1, 1.25]) {
    await app.evaluate(
      ({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom),
      zoom,
    )
    for (const [width, height] of [
      [1200, 820],
      [1380, 900],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows()[0].setContentSize(width, height),
        { width, height },
      )
      await page.waitForFunction(
        ({ width, height, zoom }) => Math.abs(innerWidth - width / zoom) <= 1 && Math.abs(innerHeight - height / zoom) <= 1,
        { width, height, zoom },
      )
      const aligned = await poll(
        async () => {
          const frame = await browserFrame()
          const native = await app.evaluate(({ BrowserWindow }, url) => {
            const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
              (view) => "webContents" in view && view.webContents.getURL().startsWith(url),
            )
            return view?.getBounds()
          }, fixtureURL)
          return { css: frame.host, native, frame }
        },
        ({ css, native, frame }) =>
          native &&
          frameFits(frame) &&
          native.x >= 0 && native.y >= 0 && native.x + native.width <= width + 1 && native.y + native.height <= height + 1 &&
          Math.abs(native.x - Math.round(css.x * zoom)) <= 1 &&
          Math.abs(native.y - Math.round(css.y * zoom)) <= 1 &&
          Math.abs(native.x + native.width - Math.round((css.x + css.width) * zoom)) <= 1 &&
          Math.abs(native.y + native.height - Math.round((css.y + css.height) * zoom)) <= 1,
        `native browser bounds at ${zoom * 100}%`,
      )
      report.browserBounds ??= []
      report.browserBounds.push({ zoom, width, height, ...aligned })
      assert.equal(await preferredPanelWidth(), preferredWidth)
    }
    const nativePage = await app.evaluate(async ({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (window.isVisible() || window.isFocused()) throw Error("QA window became visible")
      const view = window.contentView.children.find(
        (view) => "webContents" in view && view.webContents.getURL().startsWith(url),
      )
      if (!view) throw Error("Native browser child was not found")
      const web = view.webContents
      const dom = await web.executeJavaScript(`({ title: document.title, text: document.body.innerText, width: innerWidth, height: innerHeight, ready: document.readyState })`)
      web.setBackgroundThrottling(false)
      const picture = await web.capturePage(undefined, { stayHidden: true, stayAwake: true })
      if (window.isVisible() || window.isFocused()) throw Error("QA window became visible during native capture")
      return { url: web.getURL(), title: web.getTitle(), bounds: view.getBounds(), visible: view.getVisible(), dom, empty: picture.isEmpty(), size: picture.getSize(), png: picture.toPNG().toString("base64") }
    }, fixtureURL)
    assert.equal(nativePage.url, fixtureURL + "/browser/one")
    assert.equal(nativePage.title, "Organization browser")
    assert.equal(nativePage.dom.title, "Organization browser")
    assert.match(nativePage.dom.text, /First page/)
    assert.match(nativePage.dom.text, /Next page/)
    assert.equal(nativePage.dom.ready, "complete")
    assert.equal(nativePage.visible, true)
    assert.equal(nativePage.empty, false)
    const nativePath = join(output, basename + `-browser-native-${Math.round(zoom * 100)}.png`)
    await writeFile(nativePath, Buffer.from(nativePage.png, "base64"))
    const { png, ...nativeMetadata } = nativePage
    report.browserNative ??= []
    report.browserNative.push({ zoom, path: nativePath, ...nativeMetadata })
    report.screenshots.push({ path: nativePath, ...nativePage.size, scale: zoom, surface: "native-browser-child" })
    await captures(`browser-${Math.round(zoom * 100)}`)
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await page.waitForFunction(() => innerWidth === 1380 && innerHeight === 900)
  await poll(
    () => page.locator(".bb-workspace-panel:visible").evaluate((panel) => panel.getBoundingClientRect().width),
    (width) => Math.abs(width - preferredWidth) <= 1,
    "preferred panel width restored after zoom",
  )
  check("Native browser, toolbar, tab header and visible composer fit at 100%/125% resizes without changing the preferred panel width")
  await page.locator(".bb-browser-toolbar").getByRole("button", { name: "Browser actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Copy address", exact: true }).waitFor()
  await page.getByRole("menuitem", { name: "Open in default browser", exact: true }).waitFor()
  await captures("browser-menu")
  await page.keyboard.press("Escape")
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(600, 780))
  await page.waitForFunction(() => innerWidth === 600 && innerHeight === 780)
  await poll(browserFrame, (frame) => frameFits(frame) && frame.overlay && frame.inert, "narrow contained panel")
  await captures("narrow-panel")
  await page.locator(".bb-panel-collapse").getByRole("button", { name: "Collapse panel", exact: true }).click()
  await page.locator(".bb-workspace-panel:visible").waitFor({ state: "hidden" })
  assert.equal(await page.locator(`.bb-workspace-chat[data-bb-chat="${home.id}"]`).evaluate((chat) => chat.inert), false)
  await page.getByRole("button", { name: "Expand panel", exact: true }).click()
  await poll(browserFrame, (frame) => frameFits(frame) && frame.overlay && frame.inert, "narrow panel reopened")
  assert.equal(await preferredPanelWidth(), preferredWidth)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 780))
  await page.waitForFunction(() => innerWidth === 740 && innerHeight === 780)
  await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
  await page.locator(".bb-org-sidebar.drawer").waitFor()
  const browserVisibility = () =>
    app.evaluate(
      ({ BrowserWindow }, url) =>
        BrowserWindow.getAllWindows()[0]
          .contentView.children.filter((view) => "webContents" in view && view.webContents.getURL().startsWith(url))
          .map((view) => view.getVisible()),
      fixtureURL,
    )
  await poll(browserVisibility, (values) => values.length === 1 && values[0] === false, "drawer hides native browser")
  await page.locator(".bb-org-utilities").getByRole("button", { name: "Home", exact: true }).focus()
  await page.keyboard.press("Escape")
  await poll(browserVisibility, (values) => values.length === 1 && values[0] === true, "drawer restores native browser")
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1380, 900))
  await page
    .locator(".bb-panel-tabs > div")
    .filter({ has: page.getByRole("tab", { name: "Organization browser", exact: true }) })
    .getByRole("button", { name: "Close tab", exact: true })
    .click()
  await page.locator(".bb-workspace-panel:visible").waitFor({ state: "hidden" })
  await poll(
    () => call("browser.list"),
    (rows) => rows.every((row) => row.id !== browser.id),
    "browser close",
  )
  check(
    "Minimal browser controls preserve an in-progress address, navigate history, expose overflow actions, and close the entire panel with the final tab",
  )

  const markdown = join(directory, "Sidebar QA plan.md")
  await writeFile(markdown, "# Sidebar QA plan\n\nA saved document opened from the artifact library.\n")
  const artifact = await call("artifact.publish", { path: markdown, sessionID: imported.id })
  await page.locator(".bb-org-utilities").getByRole("button", { name: "Artifacts", exact: true }).click()
  await page.locator(".bb-org-artifact").filter({ hasText: "Sidebar QA plan.md" }).click()
  await page.locator(`.bb-workspace-chat[data-bb-chat="${imported.id}"]`).waitFor()
  await page.getByRole("tab", { name: "Sidebar QA plan.md", exact: true }).waitFor()
  await page
    .locator(".bb-panel-tabs > div")
    .filter({ has: page.getByRole("tab", { name: "Sidebar QA plan.md", exact: true }) })
    .getByRole("button", { name: "Close tab", exact: true })
    .click()
  await page.locator(".bb-workspace-panel:visible").waitFor({ state: "hidden" })
  await open(home)
  await open(imported)
  await page.locator(".bb-workspace-panel:visible").waitFor({ state: "hidden" })
  assert.equal(
    (await call("artifacts.list")).some((item) => item.id === artifact.id),
    true,
  )
  check(
    "The artifact library waits for the target chat/catalog, opens its saved document, and preserves collapsed final-tab state when returning",
  )

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 780))
  assert.equal(await page.locator(".bb-org-sidebar").isVisible(), false)
  await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
  await page.locator(".bb-org-sidebar.drawer").waitFor()
  await captures("narrow-drawer")
  await page.locator(".bb-org-utilities").getByRole("button", { name: "Home", exact: true }).click()
  await page.locator(".bb-org-sidebar").waitFor({ state: "hidden" })
  assert.equal(await page.locator(".bb-org-backdrop").count(), 0)
  check("Narrow windows use a closable navigation drawer and leave the chat full width after navigation")
  assert.deepEqual(report.errors, [])
  await app.evaluate(({ BrowserWindow }) => {
    if (BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()))
      throw Error("QA window became visible")
  })
  check("Zero renderer errors; every QA window stayed hidden and unfocused")
} catch (error) {
  report.failure = error.stack || String(error)
  console.error("FAIL", report.failure)
  if (page) {
    report.body = await page
      .locator("body")
      .innerText()
      .then((text) => text.slice(0, 6000))
      .catch(String)
    await captureHidden(app, page, join(output, basename + "-failure.png")).catch((error) => {
      report.captureFailure = String(error)
    })
  }
  process.exitCode = 1
} finally {
  migrationReady.resolve()
  await writeFile(join(output, basename + ".json"), JSON.stringify(report, null, 2))
  await app?.close()
  fixture.closeAllConnections()
  await new Promise((resolve) => fixture.close(resolve))
}
