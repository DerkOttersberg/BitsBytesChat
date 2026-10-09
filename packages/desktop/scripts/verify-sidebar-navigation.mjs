import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { join, resolve } from "node:path"
import { captureHidden } from "./qa-capture.mjs"

// Run from packages/desktop. All windows, clipboard writes, conversations and
// files belong to an isolated fictional QA fixture. Never focus/show a window.
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/sidebar-navigation-" + randomUUID())
const data = join(profile, "BitsBytesChat")
const directory = join(data, "workspace")
const research = join(data, "Research folder")
const design = join(data, "Design folder")
const basename = process.env.BB_QA_REPORT || "sidebar-refinement"
const output = join(root, ".tools/qa/results")
const report = { profile, checks: [], errors: [], screenshots: [], geometry: [], queryTimings: [], requests: 0 }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const check = text => { report.checks.push(text); console.log("PASS", text) }
const poll = async (read, accept, label) => {
  for (let index = 0; index < 300; index++) {
    const value = await read()
    if (accept(value)) return value
    await wait(100)
  }
  throw Error("Timed out: " + label)
}
const fixture = createServer(async (req, res) => {
  for await (const chunk of req) void chunk
  report.requests++
  res.writeHead(200, { "content-type": "text/event-stream" })
  res.write("data: " + JSON.stringify({
    id: "qa-" + randomUUID(), object: "chat.completion.chunk", model: "fixture",
    choices: [{ index: 0, delta: { role: "assistant", content: "Completed the fictional sidebar QA request." }, finish_reason: null }],
  }) + "\n\n")
  res.end("data: " + JSON.stringify({
    id: "qa-end", object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
  }) + "\n\ndata: [DONE]\n\n")
})
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve))
await Promise.all([directory, research, design, join(data, "config/opencode"), output].map(path => mkdir(path, { recursive: true })))
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(join(data, "config/opencode/opencode.json"), JSON.stringify({
  provider: { "sidebar-qa": {
    name: "Local QA", npm: "@ai-sdk/openai-compatible",
    options: { baseURL: "http://127.0.0.1:" + fixture.address().port + "/v1", apiKey: "fixture-only" },
    models: { fixture: { name: "Sidebar QA fixture", limit: { context: 128000, output: 8192 } } },
  } }, model: "sidebar-qa/fixture",
}))
const migrationReady = Promise.withResolvers()
const migrationSeen = Promise.withResolvers()
const heldRoutes = []
let app, page, api, call
try {
  app = await _electron.launch({
    executablePath: process.env.BB_QA_EXECUTABLE || join(root, ".tools/qa/sidebar-refinement-package/win-unpacked/BitsBytesChat.exe"),
    ...(process.env.BB_QA_MAIN ? { args: [process.env.BB_QA_MAIN] } : {}),
    env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", BB_QA_CAPTURE: "1", LOCALAPPDATA: profile },
    timeout: 90000,
  })
  await app.context().route("**/api/organization/migrate", async route => {
    migrationSeen.resolve()
    await migrationReady.promise
    await route.continue()
  })
  const isolatedSurfaces = () => {
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: class extends EventTarget {
        static permission = "denied"
        static async requestPermission() { return "denied" }
        close() {}
      },
    })
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async text => { window.__qaClipboard = text }, readText: async () => window.__qaClipboard || "" },
    })
  }
  await app.context().addInitScript(isolatedSurfaces)
  page = await app.firstWindow()
  // Native UI is intentionally suppressed in QA. Capture the production
  // renderer's clipboard IPC arguments in this process instead of Windows.
  await app.evaluate(({ clipboard, ipcMain }) => {
    let value = ""
    clipboard.writeText = text => { value = text }
    clipboard.readText = () => value
    ipcMain.removeHandler("write-clipboard-text")
    ipcMain.handle("write-clipboard-text", (_, text) => { clipboard.writeText(text) })
  })
  await page.evaluate(isolatedSurfaces)
  page.setDefaultTimeout(30000)
  app.context().on("page", opened => opened.on("pageerror", error => report.errors.push(error.message)))
  page.on("pageerror", error => report.errors.push(error.message))
  report.sessionCreates = []
  report.sidebarQueries = []
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname.match(/\/(?:api\/)?session$/))
      report.sessionCreates.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() })
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/organization/chats/query")
      report.sidebarQueries.push(request.postDataJSON())
  })
  const hidden = async () => assert.ok(await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocused())), "QA window became visible or focused")
  await hidden()
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setBackgroundThrottling(false)
    window.setMinimumSize(0, 0)
    window.setContentSize(1380, 900)
    window.webContents.setZoomFactor(1)
  })
  const server = await page.evaluate(() => window.api.awaitInitialization())
  const headers = { "content-type": "application/json" }
  if (server.password) headers.authorization = "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")
  api = async (path, method = "GET", body, cwd = directory) => {
    const started = performance.now()
    const response = await fetch(server.url + path, {
      method, headers: { ...headers, "x-opencode-directory": encodeURIComponent(cwd) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000),
    })
    if (!response.ok) throw Error(`${path}: ${response.status} ${(await response.text()).slice(0, 400)}`)
    const value = response.status === 204 ? undefined : await response.json()
    if (path === "/api/organization/chats/query") report.queryTimings.push({
      kind: body?.search ? "search" : body?.projectID ? "project" : body?.pinned ? "pinned" : body?.archived ? "archived" : "recent",
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      summaries: value.data.length, limit: body?.limit ?? 50, next: Boolean(value.next),
    })
    return value
  }
  const org = (path, method = "GET", body) => api("/api/organization" + path, method, body)
  call = (method, args = {}) => page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
  const id = () => "msg_" + ((BigInt(Date.now()) * 4096n) & 0xffffffffffffn).toString(16).padStart(12, "0") + randomUUID().replaceAll("-", "").slice(0, 14)
  const create = async (title, cwd = directory, durable = true) => {
    const chat = await api("/session", "POST", { title }, cwd)
    if (durable) await api(`/session/${chat.id}/prompt_async`, "POST", {
      messageID: id(), revision: 1, noReply: true, agent: "build",
      model: { providerID: "sidebar-qa", modelID: "fixture" }, parts: [{ type: "text", text: title + " — fictional saved message." }],
    }, cwd)
    return chat
  }
  const currentRoute = () => page.evaluate(async () => {
    const windowID = await window.api.getWindowID()
    return localStorage.getItem(`opencode.desktop.window.${windowID}.last-active-url`) ?? "/"
  })
  const draftTabs = () => page.evaluate(async () => {
    const id = (await window.api.getWindowID()).replace(/[^a-zA-Z0-9._-]/g, "-")
    return JSON.parse(await window.api.storeGet("opencode.window." + id + ".dat", "tabs") || "[]").filter(tab => tab.type === "draft")
  })
  const row = chat => page.locator(`.bb-org-sidebar .bb-org-row[data-session-id="${chat.id}"]`).first()
  const projectButton = project => page.locator(".bb-org-sidebar .bb-org-project-link").filter({ hasText: project.name }).first()
  const editor = () => page.locator(".bb-org-chat-content [contenteditable=true]:visible").first()
  const open = async chat => {
    await page.evaluate(detail => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), { sessionID: chat.id, directory: chat.directory ?? directory })
    await page.locator(`.bb-workspace-chat[data-bb-chat="${chat.id}"] [contenteditable=true]`).first().waitFor()
  }
  const menu = async (chat, name, rightClick = false) => {
    await row(chat).scrollIntoViewIfNeeded()
    if (rightClick) await row(chat).click({ button: "right" })
    if (!rightClick) await row(chat).getByRole("button", { name: "Chat actions", exact: true }).click()
    if (name) await page.getByRole("menuitem", { name, exact: true }).click()
  }
  const projectMenu = async (project, name) => {
    await projectButton(project).scrollIntoViewIfNeeded()
    const containing = projectButton(project).locator("..").filter({ has: page.getByRole("button", { name: "Project actions", exact: true }) })
    await containing.getByRole("button", { name: "Project actions", exact: true }).click()
    await page.getByRole("menuitem", { name, exact: true }).click()
  }
  const captures = async suffix => {
    const path = join(output, basename + "-" + suffix + ".png")
    report.screenshots.push({ path, ...await captureHidden(app, page, path) })
  }
  const theme = async scheme => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForFunction(scheme => document.documentElement.dataset.colorScheme === scheme, scheme)
  }
  const send = async text => {
    await editor().fill(text)
    await page.locator(".bb-org-chat-content").getByText("Sidebar QA fixture", { exact: true }).waitFor()
    await poll(() => api("/agent"), agents => agents.some(agent => agent.name === "build"), "scoped build agent")
    await page.locator(".bb-org-chat-content .bb-send-primary:visible").click()
  }
  const membership = async (chat, projectID) => {
    const query = await org("/chats/query", "POST", { projectID })
    return query.data.some(item => item.id === chat.id)
  }

  const imported = await create("Research notes", research)
  const designed = await create("Design questions", design)
  const home = await create("General conversation")
  const empty = await create("An unsent empty conversation", directory, false)
  await Promise.race([migrationSeen.promise, wait(15000).then(() => { throw Error("Migration was not intercepted") })])
  const migration = { projects: [{ directory: research, name: "Research project" }, { directory: design, name: "Design project" }, { directory }], defaultDirectory: directory }
  await org("/migrate", "POST", migration)
  const migrated = await org("/projects")
  assert.equal(migrated.length, 2)
  assert.ok(migrated.every(project => project.count === 1))
  await org("/migrate", "POST", migration)
  assert.equal((await org("/projects")).length, 2)
  migrationReady.resolve()
  await page.locator(".bb-org-sidebar").waitFor({ timeout: 90000 })
  await row(home).waitFor()
  assert.equal(await row(empty).count(), 0)
  assert.equal((await org("/chats/query", "POST", {})).data.some(chat => chat.id === empty.id), false)
  assert.equal(await page.locator("[data-titlebar-tab-slot], .bb-nav").count(), 0)
  check("Repeatable migration preserves saved conversations; empty sessions have no sidebar row or project count")

  const utilities = page.locator(".bb-org-utilities")
  assert.deepEqual((await utilities.getByRole("button").allTextContents()).map(text => text.trim()), ["New chat", "Recordings", "Skills", "Artifacts"])
  assert.equal(await utilities.getByRole("button", { name: "Home", exact: true }).count(), 0)
  assert.equal(await utilities.getByRole("button", { name: "Projects", exact: true }).count(), 0)
  assert.equal(await page.locator(".bb-org-sidebar").getByRole("button", { name: "View all", exact: true }).count(), 0)
  const newButton = page.locator(".bb-org-sidebar").getByRole("button", { name: "New chat", exact: true }).first()
  const utilityBox = await utilities.boundingBox()
  const newBox = await newButton.boundingBox()
  assert.ok(Math.abs(newBox.y - utilityBox.y) <= 1)
  assert.equal(await page.locator(".bb-org-new-chat").count(), 1)
  await open(home)
  assert.match(await currentRoute(), new RegExp("/session/" + home.id + "$"))
  assert.equal(await page.locator(".bb-org-page").count(), 0)
  check("New chat replaces Home at the top; no duplicate New chat, Projects or View all navigation remains")

  await newButton.click()
  const draftURL = await poll(currentRoute, route => route.startsWith("/new-session?"), "ordinary draft route")
  assert.match(draftURL, /^\/new-session\?/)
  await page.locator(".bb-org-chat-content").getByText("No project", { exact: true }).waitFor()
  assert.equal(await page.locator(".bb-org-sidebar .bb-org-row[data-session-id]").evaluateAll(rows => new Set(rows.map(row => row.dataset.sessionId)).size), 3)
  for (const scheme of ["dark", "light"]) {
    await theme(scheme)
    await captures(`${scheme}-ordinary-new-chat`)
  }
  await editor().fill("Unsent ordinary conversation")
  await editor().evaluate(node => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(["Fictional retained draft attachment."], "sidebar-draft.txt", { type: "text/plain" }))
    for (const type of ["dragenter", "dragover", "drop"])
      node.closest("form").dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }))
  })
  await page.locator(".bb-org-chat-content").getByText("sidebar-draft.txt", { exact: true }).waitFor()
  await newButton.click()
  assert.equal(await currentRoute(), draftURL)
  assert.equal(await editor().textContent(), "Unsent ordinary conversation")
  await editor().evaluate(node => { node.dataset.qaRetained = "ordinary" })
  for (const name of ["Recordings", "Skills", "Artifacts"]) {
    await utilities.getByRole("button", { name, exact: true }).click()
    assert.equal(await page.locator(".bb-org-sidebar .bb-org-row[data-session-id]:visible").count(), 5)
    assert.equal(await page.locator(".bb-org-project-link:visible").count(), 2)
    assert.equal(await newButton.isVisible(), true)
    assert.equal(await page.locator('[data-qa-retained="ordinary"]').count(), 1)
    assert.equal(await page.locator(".bb-org-account").isVisible(), true)
    const utilityFooter = await page.locator(".bb-org-sidebar").evaluate(element => {
      const sidebar = element.getBoundingClientRect()
      const footer = element.querySelector(".bb-org-account").getBoundingClientRect()
      return { sidebarBottom: sidebar.bottom, footerBottom: footer.bottom }
    })
    assert.ok(Math.abs(utilityFooter.sidebarBottom - utilityFooter.footerBottom) <= 1)
    if (name === "Recordings") {
      for (const scheme of ["dark", "light"]) {
        await theme(scheme)
        await captures(`${scheme}-utility-navigation`)
      }
    }
    await newButton.click()
    assert.equal(await currentRoute(), draftURL)
    assert.equal(await editor().textContent(), "Unsent ordinary conversation")
    assert.equal(await page.locator(".bb-org-chat-content").getByText("sidebar-draft.txt", { exact: true }).isVisible(), true)
  }
  await utilities.getByRole("button", { name: "Recordings", exact: true }).click()
  await row(home).getByRole("button").first().click()
  await editor().waitFor()
  assert.match(await currentRoute(), new RegExp("/session/" + home.id + "$"))
  await newButton.click()
  assert.equal(await currentRoute(), draftURL)
  assert.equal(await editor().textContent(), "Unsent ordinary conversation")
  check("All utilities retain visible projects/chats; New chat reuses the draft and clicking a conversation restores its workspace")
  await page.reload()
  await page.locator(".bb-org-sidebar").waitFor({ timeout: 90000 })
  await poll(currentRoute, route => route === draftURL, "restored draft route")
  await poll(() => editor().textContent(), text => text === "Unsent ordinary conversation", "restored draft source")
  await page.locator(".bb-org-chat-content").getByText("sidebar-draft.txt", { exact: true }).waitFor()
  await newButton.click()
  assert.equal(await currentRoute(), draftURL)
  assert.equal(await page.locator(".bb-org-sidebar .bb-org-row .bb-org-chat-link").filter({ hasText: "New chat" }).count(), 0)
  check("Renderer reload restores the exact unsent draft, attachment and route without adding a sidebar draft row")

  // A failed creation is a real HTTP failure before admission, not a provider failure.
  let rejected = false
  const rejectCreate = async route => {
    if (route.request().method() !== "POST" || rejected) return route.continue()
    rejected = true
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ name: "QA creation failure", data: { message: "Controlled first-send failure" } }) })
  }
  await page.route(/\/(?:api\/)?session(?:\?.*)?$/, rejectCreate)
  await send("Retain this first request after an admission failure")
  await poll(() => rejected, value => value, "first-send creation failure")
  assert.equal(await currentRoute(), draftURL)
  await poll(() => editor().textContent(), text => text.includes("Retain this first request"), "retained failed prompt")
  assert.equal(await page.locator(".bb-org-chat-content").getByText("sidebar-draft.txt", { exact: true }).isVisible(), true)
  assert.equal((await org("/chats/query", "POST", {})).data.length, 3)
  await page.unroute(/\/(?:api\/)?session(?:\?.*)?$/, rejectCreate)
  await send("An ordinary first response")
  const ordinary = await poll(() => org("/chats/query", "POST", { projectID: null }), result => result.data.length === 2, "ordinary first message").then(result => result.data.find(chat => chat.id !== home.id))
  await row(ordinary).waitFor()
  assert.equal(await page.locator(`.bb-org-row[data-session-id="${ordinary.id}"]`).count(), 1)
  await page.locator(`.bb-workspace-chat[data-bb-chat="${ordinary.id}"] p`).filter({ hasText: "Completed the fictional sidebar QA request." }).first().waitFor({ timeout: 90000 })
  await poll(async () => ({ run: await call("runs.get", { sessionID: ordinary.id }), status: (await api("/session/status"))[ordinary.id] }), value => !value.run.queue.length && !value.run.awaiting && (!value.status || value.status.type === "idle"), "completed ordinary fixture turn")
  check("Failed first Send retains its source; retry creates one durable unassigned conversation without an empty row")
  assert.equal((await draftTabs()).filter(tab => !tab.projectID).length, 0)
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("bitsbytes:new-chat"))
    window.dispatchEvent(new CustomEvent("bitsbytes:new-chat"))
  })
  await poll(currentRoute, route => route.startsWith("/new-session?"), "concurrent New chat route")
  await poll(draftTabs, tabs => tabs.filter(tab => !tab.projectID).length > 0, "reserved draft persisted")
  assert.equal((await draftTabs()).filter(tab => !tab.projectID).length, 1)
  await open(ordinary)
  check("Two same-turn New chat events reserve one draft after the previous draft was promoted")
  for (let index = 0; index < 10; index++) {
    const dismiss = page.locator('[data-slot="toast-close-button"]:visible, [data-slot="toast-v2-close-button"]:visible').first()
    if (!(await dismiss.count())) break
    await dismiss.click()
  }

  const projectAdd = page.locator(".bb-org-project-add")
  await page.mouse.move(800, 400)
  assert.equal(await projectAdd.evaluate(node => getComputedStyle(node).opacity), "0")
  await page.locator(".bb-org-projects-heading").hover()
  assert.equal(await projectAdd.evaluate(node => getComputedStyle(node).opacity), "1")
  for (const scheme of ["dark", "light"]) {
    await theme(scheme)
    await captures(`${scheme}-project-add-hover`)
  }
  await page.mouse.move(800, 400)
  await projectAdd.focus()
  assert.equal(await projectAdd.evaluate(node => getComputedStyle(node).opacity), "1")
  check("The project plus appears on heading hover and keyboard focus, while remaining hidden at rest")
  await projectAdd.click()
  await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("Creative work")
  assert.equal(await page.getByRole("dialog").getByLabel("Default folder", { exact: true }).inputValue(), "")
  for (const scheme of ["dark", "light"]) {
    await theme(scheme)
    await captures(`${scheme}-name-only-project`)
  }
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click()
  const creative = await poll(() => org("/projects"), rows => rows.some(project => project.name === "Creative work"), "name-only project").then(rows => rows.find(project => project.name === "Creative work"))
  assert.equal(creative.directory, undefined)
  await projectButton(creative).waitFor()
  await org("/projects/" + creative.id, "PATCH", { pinned: false })
  await projectButton(creative).waitFor()
  assert.equal(await page.locator(".bb-org-sidebar .bb-org-project-link").count(), 3)
  await projectMenu(creative, "New chat")
  const projectDraft = await poll(currentRoute, route => route.startsWith("/new-session?"), "project draft route")
  await page.locator(".bb-org-chat-content").getByText("Creative work", { exact: true }).waitFor()
  await editor().fill("Retained project draft")
  await projectMenu(creative, "New chat")
  assert.equal(await currentRoute(), projectDraft)
  assert.equal(await editor().textContent(), "Retained project draft")
  await page.locator(".bb-org-chat-content").getByRole("button", { name: "Select project", exact: true }).click()
  await captures("light-optional-project-picker")
  await page.getByRole("menuitem", { name: "No project", exact: true }).click()
  await page.locator(".bb-org-chat-content").getByText("No project", { exact: true }).waitFor()
  await page.locator(".bb-org-chat-content").getByRole("button", { name: "Select project", exact: true }).click()
  await page.getByRole("menuitem", { name: "Creative work", exact: true }).click()
  assert.equal(await editor().textContent(), "Retained project draft")
  await send("Project first response")
  const child = await poll(() => org("/chats/query", "POST", { projectID: creative.id }), result => result.data.length === 1, "project first message").then(result => result.data[0])
  assert.equal(child.directory.toLowerCase(), directory.toLowerCase())
  await row(child).waitFor()
  await page.locator(`.bb-workspace-chat[data-bb-chat="${child.id}"] p`).filter({ hasText: "Completed the fictional sidebar QA request." }).first().waitFor({ timeout: 90000 })
  check("Name-only projects and unpinned projects are visible; project New chat reuses its draft and first Send assigns membership")

  await menu(child, undefined, true)
  const availableActions = await page.getByRole("menuitem").allTextContents()
  report.menu = availableActions
  for (const name of ["Rename", "Pin", "Mark as unread", "Project", "Fork into new chat", "Copy", "Open in new window", "Archive", "Permanently delete"])
    assert.ok(availableActions.some(text => text.trim() === name || text.trim().startsWith(name)), "Missing action: " + name)
  assert.equal(availableActions.some(text => /^(Section|Share)$/.test(text.trim())), false)
  await captures("light-chat-menu")
  await page.keyboard.press("Escape")
  await row(child).getByRole("button").first().focus()
  await page.keyboard.press("Shift+F10")
  await page.getByRole("menuitem", { name: "Rename chat", exact: true }).click()
  await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("Project conversation renamed")
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click()
  await row(child).getByText("Project conversation renamed", { exact: true }).waitFor()
  await menu(child, "Pin")
  await poll(() => org("/chats/query", "POST", { pinned: true }), result => result.data.some(chat => chat.id === child.id), "pin")
  await menu(child, "Unpin")
  await menu(child, "Mark as unread")
  await poll(() => org("/chats/query", "POST", { projectID: creative.id }), result => result.data.some(chat => chat.id === child.id && chat.unread), "manual unread")
  await wait(800)
  assert.equal((await org("/chats/query", "POST", { projectID: creative.id })).data.find(chat => chat.id === child.id).unread, true)
  await open(home)
  await page.reload()
  await page.locator(".bb-org-sidebar").waitFor({ timeout: 90000 })
  await poll(currentRoute, route => route.endsWith("/session/" + home.id), "restored active conversation")
  await row(child).waitFor()
  assert.equal((await org("/chats/query", "POST", { projectID: creative.id })).data.find(chat => chat.id === child.id).unread, true)
  assert.equal(await row(child).evaluate(element => element.classList.contains("unread")), true)
  await row(child).getByRole("button").first().click()
  await poll(() => org("/chats/query", "POST", { projectID: creative.id }), result => result.data.some(chat => chat.id === child.id && !chat.unread), "unread cleared on revisit")
  check("Right-click, ellipsis and Shift+F10 share actions; rename/pin/manual unread work and active-chat unread persists until revisit")

  await open(home)
  const visitRead = Promise.withResolvers()
  heldRoutes.push(visitRead)
  let visitReadSeen = false
  let visitReadReleased = false
  let unreadBeforeVisitRead = false
  const holdVisitRead = async route => {
    if (route.request().method() !== "PATCH") return route.continue()
    const payload = route.request().postDataJSON()
    if (payload.unread === false && !visitReadSeen) {
      visitReadSeen = true
      await visitRead.promise
    }
    if (payload.unread === true && !visitReadReleased) unreadBeforeVisitRead = true
    await route.continue()
  }
  await page.route("**/api/organization/chats/" + child.id, holdVisitRead)
  await open(child)
  await poll(() => visitReadSeen, value => value, "held active visit read write")
  await menu(child, "Mark as unread")
  await wait(300)
  assert.equal(unreadBeforeVisitRead, false)
  visitReadReleased = true
  visitRead.resolve()
  await poll(() => org("/chats/query", "POST", { projectID: creative.id }), result => result.data.some(chat => chat.id === child.id && chat.unread), "serialized manual unread")
  await wait(300)
  assert.equal((await org("/chats/query", "POST", { projectID: creative.id })).data.find(chat => chat.id === child.id).unread, true)
  await page.unroute("**/api/organization/chats/" + child.id, holdVisitRead)
  check("Manual unread waits behind a held visit/read write and remains durable after that older write completes")

  await menu(child)
  await page.getByRole("menuitem", { name: "Project", exact: true }).hover()
  await page.getByRole("menuitem", { name: "Research project", exact: true }).click()
  await poll(() => membership(child, migrated[0].id), value => value, "project submenu move")
  assert.equal((await api("/session/" + child.id)).directory.toLowerCase(), directory.toLowerCase())
  await menu(child)
  await page.getByRole("menuitem", { name: "Project", exact: true }).hover()
  await page.getByRole("menuitem", { name: "No project", exact: true }).click()
  await poll(() => membership(child, null), value => value, "project submenu remove")
  check("Project submenu assigns and removes membership without changing the conversation's execution folder")

  const drag = async (chat, target, release = true) => {
    await row(chat).scrollIntoViewIfNeeded()
    const source = await row(chat).getByRole("button").first().boundingBox()
    const destination = await target.boundingBox()
    await page.mouse.move(source.x + 80, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(source.x + 90, source.y + source.height / 2 + 8, { steps: 4 })
    await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 14 })
    if (release) await page.mouse.up()
  }
  await page.evaluate(() => {
    window.__qaNativeDrags = 0
    window.addEventListener("dragstart", () => window.__qaNativeDrags++)
  })
  if ((await projectButton(creative).getAttribute("aria-expanded")) === "true") await projectButton(creative).click()
  await drag(child, projectButton(creative), false)
  await poll(() => projectButton(creative).getAttribute("aria-expanded"), value => value === "true", "drag hover expands project")
  assert.equal(await page.locator(".bb-org-unassign").count(), 0)
  const creativeGroup = page.locator(`section[data-project-id="${creative.id}"]`)
  assert.equal(await creativeGroup.evaluate(node => getComputedStyle(node).outlineWidth), "1px")
  assert.ok((await creativeGroup.boundingBox()).height > (await projectButton(creative).boundingBox()).height)
  const dragState = await page.locator(".bb-org-sidebar").evaluate(element => ({ text: element.innerText, cursor: getComputedStyle(document.body).cursor }))
  report.drag = dragState
  assert.notEqual(dragState.cursor, "not-allowed")
  assert.equal(await page.evaluate(() => window.__qaNativeDrags), 0)
  assert.equal(await page.getByText("Drop files here", { exact: false }).isVisible().catch(() => false), false)
  await captures("project-drag-preview")
  await page.keyboard.press("Escape")
  await page.mouse.up()
  assert.equal(await membership(child, null), true)
  const composerBeforeInvalidDrop = await editor().textContent()
  await drag(child, editor())
  assert.equal(await membership(child, null), true)
  assert.equal(await editor().textContent(), composerBeforeInvalidDrop)
  assert.equal(await page.evaluate(() => window.__qaNativeDrags), 0)
  assert.equal(await page.getByText("Drop files here", { exact: false }).isVisible().catch(() => false), false)
  await drag(child, creativeGroup.locator(".bb-org-children"))
  await poll(() => membership(child, creative.id), value => value, "pointer project assignment")
  await drag(child, page.locator(`section[data-project-id="${migrated[0].id}"] .bb-org-children`), false)
  assert.equal(await page.locator(`section[data-project-id="${migrated[0].id}"]`).evaluate(node => getComputedStyle(node).outlineWidth), "1px")
  assert.equal(await page.locator(".bb-org-unassign").isVisible(), true)
  await page.keyboard.press("Escape")
  await page.mouse.up()
  assert.equal(await membership(child, creative.id), true)
  // The removal target exists only while a project member is being dragged.
  await row(child).scrollIntoViewIfNeeded()
  const source = await row(child).getByRole("button").first().boundingBox()
  await page.mouse.move(source.x + 75, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(source.x + 90, source.y + source.height / 2 + 8, { steps: 4 })
  const removal = page.locator(".bb-org-sidebar").getByText("Remove from project", { exact: true })
  await removal.waitFor()
  const removalBox = await removal.boundingBox()
  await page.mouse.move(removalBox.x + removalBox.width / 2, removalBox.y + removalBox.height / 2, { steps: 12 })
  await page.mouse.up()
  await poll(() => membership(child, null), value => value, "pointer removal")
  assert.equal((await api("/session/" + child.id)).directory.toLowerCase(), directory.toLowerCase())
  check("Entire expanded folders accept and outline drops, including child rows; unassigned chats have no removal target; Escape and member removal work")

  const rejectMove = async route => {
    if (route.request().method() !== "PATCH" || route.request().postDataJSON()?.projectID !== creative.id) return route.continue()
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Controlled assignment failure" }) })
  }
  const rejectMoveRefresh = route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Controlled refresh outage" }) })
  await page.route("**/api/organization/chats/" + child.id, rejectMove)
  await page.route("**/api/organization/chats/query", rejectMoveRefresh)
  const failedAssignment = page.waitForResponse(response => new URL(response.url()).pathname === "/api/organization/chats/" + child.id && response.request().method() === "PATCH" && response.request().postDataJSON()?.projectID === creative.id)
  await drag(child, projectButton(creative))
  const failedAssignmentResponse = await failedAssignment
  assert.equal(failedAssignmentResponse.status(), 503)
  report.moveRollback = { status: failedAssignmentResponse.status(), payload: failedAssignmentResponse.request().postDataJSON() }
  await page.locator(".bb-org-error").waitFor()
  assert.equal(await membership(child, null), true)
  await poll(() => page.locator(`section[data-project-id="${creative.id}"] .bb-org-children .bb-org-row[data-session-id="${child.id}"]`).count(), count => count === 0, "visual rollback after actual failed assignment")
  assert.equal(await row(child).isVisible(), true)
  await page.unroute("**/api/organization/chats/" + child.id, rejectMove)
  await page.unroute("**/api/organization/chats/query", rejectMoveRefresh)
  await menu(child)
  await page.getByRole("menuitem", { name: "Project", exact: true }).hover()
  await page.getByRole("menuitem", { name: "Creative work", exact: true }).click()
  await poll(() => membership(child, creative.id), value => value, "assignment after rollback")
  await org("/projects/" + creative.id, "PATCH", { directory: design })
  assert.equal((await api("/session/" + child.id)).directory.toLowerCase(), directory.toLowerCase())
  check("A failed move rolls back membership and permits retry; changing project defaults never relocates existing chats")

  await open(child)
  const selectedBeforeBackgroundMenu = await currentRoute()
  await menu(home, undefined, true)
  await page.getByRole("menuitem", { name: "Copy", exact: true }).hover()
  await page.getByRole("menuitem", { name: "Copy title", exact: true }).click()
  await poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), text => text === "General conversation", "background chat title copied")
  assert.equal(await currentRoute(), selectedBeforeBackgroundMenu)
  await menu(child)
  await page.getByRole("menuitem", { name: "Copy", exact: true }).hover()
  await page.getByRole("menuitem", { name: "Copy title", exact: true }).click()
  await poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), text => text === "Project conversation renamed", "chat title copied")
  await menu(child)
  await page.getByRole("menuitem", { name: "Copy", exact: true }).hover()
  await page.getByRole("menuitem", { name: "Copy conversation as Markdown", exact: true }).click()
  await poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), text => text.includes("Project first response") && text.includes("Completed the fictional sidebar QA request."), "Markdown copy")
  const beforeFork = new Set((await org("/chats/query", "POST", {})).data.map(chat => chat.id))
  await menu(child, "Fork into new chat")
  const fork = await poll(() => org("/chats/query", "POST", {}), result => result.data.some(chat => !beforeFork.has(chat.id) && chat.projectID === creative.id), "sidebar fork").then(result => result.data.find(chat => !beforeFork.has(chat.id)))
  await row(fork).waitFor()
  assert.equal(fork.projectID, creative.id)
  assert.equal(fork.directory.toLowerCase(), child.directory.toLowerCase())
  const forkMessages = await api("/session/" + fork.id + "/message")
  assert.ok(forkMessages.some(message => message.parts.some(part => part.text === "Completed the fictional sidebar QA request.")))
  assert.equal((await call("runs.get", { sessionID: fork.id })).queue.length, 0)
  check("Copy uses the isolated clipboard; Fork preserves completed history, project and folder without pending requests")

  await open(child)
  const originalURL = await currentRoute()
  const windowsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  await menu(child, "Open in new window")
  await poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), count => count === windowsBefore + 1, "targeted window")
  await hidden()
  const secondPage = await poll(() => app.windows(), pages => pages.length > 1, "second renderer").then(pages => pages.find(item => item !== page))
  await secondPage.locator(`.bb-workspace-chat[data-bb-chat="${child.id}"] [contenteditable=true]`).first().waitFor({ timeout: 90000 })
  assert.equal(await currentRoute(), originalURL)
  await secondPage.close()
  check("Open in new window initializes the selected conversation while keeping every window hidden and original selection unchanged")

  await menu(home, "Archive chat")
  await poll(() => org("/chats/query", "POST", { archived: true }), result => result.data.some(chat => chat.id === home.id), "archive")
  await page.locator(".bb-org-sidebar").getByRole("button", { name: "Sort and filter chats", exact: true }).click()
  await page.getByRole("menuitem", { name: "Show archived chats", exact: true }).click()
  await row(home).waitFor()
  await menu(home, "Restore chat")
  await poll(() => org("/chats/query", "POST", { archived: true }), result => !result.data.some(chat => chat.id === home.id), "restore")
  await page.locator(".bb-org-sidebar").getByRole("button", { name: "Sort and filter chats", exact: true }).click()
  await page.getByRole("menuitem", { name: "Show active chats", exact: true }).click()
  await row(home).waitFor()
  await menu(fork, "Permanently delete")
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click()
  assert.ok((await api("/session/" + fork.id)).id === fork.id)
  await menu(fork, "Permanently delete")
  await page.getByRole("dialog").getByRole("button", { name: "Delete chat", exact: true }).click()
  await poll(() => org("/chats/query", "POST", {}), result => !result.data.some(chat => chat.id === fork.id), "permanent delete")
  assert.ok((await api("/session/" + child.id)).id === child.id)
  await projectMenu(creative, "Remove project, keep chats")
  await poll(() => membership(child, null), value => value, "removed collection retains conversation")
  assert.equal((await api("/session/" + child.id)).directory.toLowerCase(), directory.toLowerCase())
  check("Archive/restore and confirmed deletion are real saved actions; project removal retains independent conversations")

  // V2 admit-only rows are visible before the runner promotes them; no provider call.
  const v2 = (await api("/api/session", "POST", { location: { directory }, agent: "build", model: { providerID: "sidebar-qa", id: "fixture" } })).data
  assert.equal((await org("/chats/query", "POST", {})).data.some(chat => chat.id === v2.id), false)
  await api(`/api/session/${v2.id}/prompt`, "POST", { id: id(), prompt: { text: "Durable V2 admit-only sidebar fixture" }, resume: false })
  await poll(() => org("/chats/query", "POST", {}), result => result.data.some(chat => chat.id === v2.id), "V2 durable input visibility")
  check("V2 admit-only input becomes eligible before execution; merely creating a V2 session stays invisible")

  const recent = []
  for (let offset = 0; offset < 62; offset += 4)
    recent.push(...await Promise.all(Array.from({ length: Math.min(4, 62 - offset) }, (_, index) => create("Recent conversation " + (offset + index + 1)))))
  await org("/chats/" + home.id, "PATCH", { title: "An older active conversation" })
  const first = await org("/chats/query", "POST", { limit: 50 })
  const next = await org("/chats/query", "POST", { limit: 50, cursor: first.next })
  assert.equal(first.data.length, 50)
  assert.ok(next.data.length > 0)
  assert.equal(next.data.some(chat => first.data.some(item => item.id === chat.id)), false)
  const searched = await org("/chats/query", "POST", { search: "older active", limit: 50 })
  assert.deepEqual(searched.data.map(chat => chat.id), [home.id])
  await page.locator(".bb-org-sidebar").getByRole("button", { name: "Search chats and projects", exact: true }).click()
  const search = page.getByRole("textbox", { name: "Search chats and projects", exact: true })
  await search.fill("older active")
  await poll(() => page.locator(".bb-org-sidebar .bb-org-row[data-session-id]").allTextContents(), rows => rows.some(text => text.includes("older active")) && !rows.some(text => text.includes("Recent conversation")), "server-side sidebar search")
  await search.press("Escape")
  const recentPager = page.locator(".bb-org-scroll > .bb-org-pager")
  await recentPager.waitFor()
  await recentPager.scrollIntoViewIfNeeded()
  await poll(() => report.sidebarQueries, queries => queries.some(query => query.cursor && !query.projectID && !query.pinned), "recent cursor request")
  await poll(() => page.locator(".bb-org-sidebar .bb-org-row[data-session-id]").evaluateAll(rows => new Set(rows.map(row => row.dataset.sessionId)).size), count => count > 50, "automatic recent pagination")
  assert.ok(report.sidebarQueries.some(query => query.cursor && !query.projectID && !query.pinned))
  check("Server-side search finds older conversations; sidebar scrolling loads stable cursor pages without View all")

  const delayedSearch = Promise.withResolvers()
  heldRoutes.push(delayedSearch)
  let delayedSearchSeen = false
  const delayOldSearch = async route => {
    if (route.request().postDataJSON()?.search !== "Recent conversation 1") return route.continue()
    delayedSearchSeen = true
    await delayedSearch.promise
    await route.continue()
  }
  await page.route("**/api/organization/chats/query", delayOldSearch)
  await page.locator(".bb-org-sidebar").getByRole("button", { name: "Search chats and projects", exact: true }).click()
  await search.fill("Recent conversation 1")
  await poll(() => delayedSearchSeen, value => value, "held old search request")
  await search.fill("older active")
  await poll(() => page.locator(".bb-org-sidebar .bb-org-row[data-session-id]").allTextContents(), rows => rows.some(text => text.includes("older active")) && !rows.some(text => text.includes("Recent conversation")), "newer search result")
  const delayedResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/organization/chats/query" && response.request().postDataJSON()?.search === "Recent conversation 1")
  delayedSearch.resolve()
  await delayedResponse
  await wait(300)
  assert.equal((await page.locator(".bb-org-sidebar .bb-org-row[data-session-id]").allTextContents()).some(text => text.includes("Recent conversation")), false)
  await page.unroute("**/api/organization/chats/query", delayOldSearch)
  await search.press("Escape")
  await recentPager.waitFor()
  await recentPager.scrollIntoViewIfNeeded()
  await poll(() => page.locator(".bb-org-sidebar .bb-org-row[data-session-id]").evaluateAll(rows => new Set(rows.map(row => row.dataset.sessionId)).size), count => count > 50, "restored deep history")
  check("A held older search response cannot overwrite newer results or the restored recent history")

  const deep = next.data.find(chat => recent.some(item => item.id === chat.id))
  assert.ok(deep && !first.data.some(chat => chat.id === deep.id))
  await row(deep).waitFor()
  await api("/session/" + deep.id, "DELETE")
  await row(deep).waitFor({ state: "detached" })
  recent.splice(recent.findIndex(chat => chat.id === deep.id), 1)
  const deeper = next.data.find(chat => chat.id !== deep.id && recent.some(item => item.id === chat.id))
  assert.ok(deeper)
  await row(deeper).waitFor()
  await menu(deeper, undefined, true)
  const openDeepMenu = await page.getByRole("menu").first().elementHandle()
  await org("/chats/" + deeper.id, "PATCH", { title: "Deep history updated while actions are open" })
  await row(deeper).getByText("Deep history updated while actions are open", { exact: true }).waitFor()
  assert.equal(await openDeepMenu.evaluate(element => element.isConnected), true)
  await page.keyboard.press("Escape")
  check("Authoritative updates and deletion reconcile rows loaded beyond the first page and retain an open menu's owner")

  const searchFirst = await org("/chats/query", "POST", { search: "Recent conversation", limit: 50 })
  const searchNext = await org("/chats/query", "POST", { search: "Recent conversation", limit: 50, cursor: searchFirst.next })
  const searchDeep = searchNext.data.find(chat => recent.some(item => item.id === chat.id))
  assert.ok(searchDeep && !searchFirst.data.some(chat => chat.id === searchDeep.id))
  await page.locator(".bb-org-sidebar").getByRole("button", { name: "Search chats and projects", exact: true }).click()
  await search.fill("Recent conversation")
  await recentPager.waitFor()
  await recentPager.scrollIntoViewIfNeeded()
  await row(searchDeep).waitFor()
  await org("/chats/" + searchDeep.id, "PATCH", { title: "A renamed conversation outside the active search" })
  await row(searchDeep).waitFor({ state: "detached" })
  assert.equal((await org("/chats/query", "POST", { search: "Recent conversation", limit: 50 })).data.some(chat => chat.id === searchDeep.id), false)
  await search.press("Escape")
  await recentPager.waitFor()
  await recentPager.scrollIntoViewIfNeeded()
  await row(searchDeep).getByText("A renamed conversation outside the active search", { exact: true }).waitFor()
  check("A title change removes a loaded deep row that no longer matches search and restores it in Recents")

  const pagedProject = await org("/projects", "POST", { name: "Paged project fixture" })
  await org("/projects/" + pagedProject.id, "PATCH", { pinned: false })
  for (let offset = 0; offset < recent.length; offset += 4)
    await Promise.all(recent.slice(offset, offset + 4).map(chat => org("/chats/" + chat.id, "PATCH", { projectID: pagedProject.id })))
  await projectButton(pagedProject).waitFor()
  if ((await projectButton(pagedProject).getAttribute("aria-expanded")) !== "true") await projectButton(pagedProject).click()
  const projectPager = page.locator(`section[data-project-id="${pagedProject.id}"] .bb-org-pager`)
  await projectPager.waitFor()
  await projectPager.scrollIntoViewIfNeeded()
  await poll(async () => {
    return report.sidebarQueries
  }, queries => queries.some(query => query.projectID === pagedProject.id && query.cursor), "expanded project automatic pagination")
  assert.equal((await org("/chats/query", "POST", { projectID: pagedProject.id })).data.length, 50)
  await projectButton(pagedProject).click()
  check("Expanded project scrolling loads its own cursor pages and collapsing keeps the collection intact")

  const scrollDrag = recent.at(-1)
  await page.locator(".bb-org-scroll").evaluate(element => { element.scrollTop = 0 })
  await row(scrollDrag).scrollIntoViewIfNeeded()
  const scrollSource = await row(scrollDrag).getByRole("button").first().boundingBox()
  const scrollBounds = await page.locator(".bb-org-scroll").boundingBox()
  await page.mouse.move(scrollSource.x + 80, scrollSource.y + scrollSource.height / 2)
  await page.mouse.down()
  await page.mouse.move(scrollSource.x + 95, scrollSource.y + scrollSource.height / 2 + 8, { steps: 4 })
  const scrollBefore = await page.locator(".bb-org-scroll").evaluate(element => element.scrollTop)
  await page.mouse.move(scrollBounds.x + 100, scrollBounds.y + scrollBounds.height - 5, { steps: 10 })
  await poll(() => page.locator(".bb-org-scroll").evaluate(element => element.scrollTop), value => value > scrollBefore + 100, "sidebar pointer edge scrolling")
  await page.keyboard.press("Escape")
  await page.mouse.up()
  assert.equal(await membership(scrollDrag, pagedProject.id), true)
  check("Long sidebar histories scroll at the pointer edge; Escape cancels without changing project membership")

  await open(home)
  await editor().fill("Retained existing-chat draft")
  await page.keyboard.press("Control+n")
  await poll(currentRoute, route => route.startsWith("/new-session?"), "keyboard New chat")
  assert.equal(await page.locator(".bb-org-sidebar").getByText("New chat", { exact: true }).count(), 1)
  await page.keyboard.press("Control+w")
  await open(home)
  assert.equal(await editor().textContent(), "Retained existing-chat draft")
  await editor().fill("")
  await open(imported)
  const importedURL = await currentRoute()
  await page.keyboard.press("Control+[")
  await poll(currentRoute, route => route !== importedURL, "history keyboard navigation")
  check("New/close/history shortcuts remain active without draft rows and preserve existing-chat composer text")

  await open(child)
  await org("/chats/" + child.id, "PATCH", { projectID: migrated[0].id })
  for (const project of migrated) {
    const button = projectButton(project)
    if ((await button.getAttribute("aria-expanded")) !== "true") await button.click()
  }
  await page.locator(".bb-org-scroll").evaluate(element => { element.scrollTop = 0 })
  for (const zoom of [1, 1.25]) {
    await app.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), zoom)
    await page.waitForFunction(zoom => Math.abs(innerWidth - 1380 / zoom) <= 1, zoom)
    for (const scheme of ["dark", "light"]) {
      await theme(scheme)
      const geometry = await page.locator(".bb-org-sidebar").evaluate(element => ({
        width: element.getBoundingClientRect().width,
        row: element.querySelector(".bb-org-row").getBoundingClientRect().height,
        sidebar: getComputedStyle(element).backgroundColor,
        titlebar: getComputedStyle(document.querySelector(".bb-org-titlebar")).backgroundColor,
        border: getComputedStyle(element).borderRightWidth,
        footerBorder: getComputedStyle(element.querySelector(".bb-org-account")).borderTopWidth,
      }))
      assert.ok(Math.abs(geometry.width - 332) <= 1)
      assert.ok(Math.abs(geometry.row - 28) <= 1)
      assert.equal(geometry.sidebar, geometry.titlebar)
      assert.equal(geometry.border, "0px")
      assert.equal(geometry.footerBorder, "0px")
      report.geometry.push({ zoom, scheme, ...geometry })
      await captures(`${scheme}-${Math.round(zoom * 100)}-sidebar`)
      await menu(child, undefined, true)
      const menuBox = await poll(() => page.getByRole("menu").first().boundingBox(), box => box && Math.abs(box.width - 236) <= 2, "settled conversation menu width")
      report.geometry.push({ zoom, scheme, menuWidth: menuBox.width })
      await captures(`${scheme}-${Math.round(zoom * 100)}-menu`)
      await page.keyboard.press("Escape")
      await drag(child, projectButton(migrated[1]), false)
      assert.equal(await page.getByText("Drop files here", { exact: false }).isVisible().catch(() => false), false)
      assert.equal(await page.evaluate(() => window.__qaNativeDrags), 0)
      await captures(`${scheme}-${Math.round(zoom * 100)}-drag`)
      await page.keyboard.press("Escape")
      await page.mouse.up()
      assert.equal(await membership(child, migrated[0].id), true)
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  check("Dark/light at 100%/125% retains expanded project geometry, 28px rows, flat sidebar/footer and titlebar tint")

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 780))
  await page.waitForFunction(() => innerWidth === 740 && innerHeight === 780)
  assert.equal(await page.locator(".bb-org-sidebar").isVisible(), false)
  await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
  await page.locator(".bb-org-sidebar.drawer").waitFor()
  await captures("narrow-drawer")
  await utilities.getByRole("button", { name: "Recordings", exact: true }).click()
  await page.locator(".bb-org-sidebar.drawer").waitFor()
  assert.ok(await page.locator(".bb-org-row[data-session-id]:visible").count() > 0)
  const drawerFooter = await page.locator(".bb-org-sidebar").evaluate(element =>
    element.getBoundingClientRect().bottom - element.querySelector(".bb-org-account").getBoundingClientRect().bottom)
  assert.ok(Math.abs(drawerFooter) <= 1)
  await newButton.click()
  assert.equal(await page.locator(".bb-org-sidebar").isVisible(), false)
  assert.equal(await page.locator(".bb-org-backdrop").count(), 0)
  check("Narrow utility navigation keeps the drawer and chats open; New chat closes the drawer cleanly")
  assert.deepEqual(report.errors, [])
  await hidden()
  check("Zero renderer errors; all QA windows stayed hidden/unfocused and account/clipboard surfaces remained isolated")
} catch (error) {
  report.failure = error.stack || String(error)
  console.error("FAIL", report.failure)
  if (page) {
    report.body = await page.locator("body").innerText().then(text => text.slice(0, 12000)).catch(String)
    await captureHidden(app, page, join(output, basename + "-failure.png")).catch(error => { report.captureFailure = String(error) })
  }
  process.exitCode = 1
} finally {
  migrationReady.resolve()
  heldRoutes.forEach(held => held.resolve())
  await writeFile(join(output, basename + ".json"), JSON.stringify(report, null, 2))
  await app?.close()
  fixture.closeAllConnections()
  await new Promise(resolve => fixture.close(resolve))
}
