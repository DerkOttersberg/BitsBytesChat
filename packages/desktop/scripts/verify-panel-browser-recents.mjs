import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { join, resolve } from "node:path"
import { captureHidden } from "./qa-capture.mjs"

// Native, hidden, owned UI checks. No credentials, paid requests or user windows.
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/panel-browser-recents-" + randomUUID())
const data = join(profile, "BitsBytesChat")
const directory = join(data, "workspace")
const output = join(root, ".tools/qa/results")
const basename = process.env.BB_QA_REPORT || "panel-browser-recents"
const capture = process.env.BB_QA_CAPTURE === "1"
const report = { checks: [], errors: [], geometry: [], screenshots: [] }
const fixture = createServer((req, response) => {
  response.writeHead(200, { "content-type": "text/html" })
  response.end(
    `<!doctype html><title>Panel QA ${req.url}</title><h1>Fictional local page ${req.url}</h1><a href="/two">Next</a>`,
  )
})
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve))
const website = "http://127.0.0.1:" + fixture.address().port
await Promise.all([directory, join(data, "config/opencode"), output].map((path) => mkdir(path, { recursive: true })))
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    provider: {
      "panel-qa": {
        name: "Local QA",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: website + "/v1", apiKey: "fixture-only" },
        models: { fixture: { name: "Panel QA fixture", limit: { context: 128000, output: 8192 } } },
      },
    },
    model: "panel-qa/fixture",
  }),
)
const check = (text) => {
  report.checks.push(text)
  console.log("PASS", text)
}
const poll = async (read, accept, label) => {
  for (let index = 0; index < 150; index++) {
    const value = await read()
    if (accept(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw Error("Timed out: " + label)
}
let app
try {
  app = await _electron.launch({
    executablePath:
      process.env.BB_QA_EXECUTABLE || join(root, ".tools/qa/panel-tabs-package/win-unpacked/BitsBytesChat.exe"),
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
  const page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  page.on("pageerror", (error) => report.errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setBackgroundThrottling(false)
    window.setMinimumSize(0, 0)
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
  await page.locator(".bb-org-sidebar").waitFor({ timeout: 90000 })
  await poll(
    () => api("/agent"),
    (rows) => rows.some((row) => row.name === "build"),
    "workspace initialized",
  )
  await api("/api/organization/migrate", "POST", { projects: [{ directory }], defaultDirectory: directory })
  await page.locator(".bb-org-new-chat").click()
  const editor = page.locator(".bb-org-chat-content [contenteditable=true]").first()
  await editor.waitFor()
  await editor.fill("An unsent fictional draft")
  const expand = () => page.getByRole("button", { name: "Expand panel", exact: true }).filter({ visible: true })
  const collapse = () =>
    page.locator(".bb-panel-collapse:visible").getByRole("button", { name: "Collapse panel", exact: true })
  const panel = () => page.locator(".bb-workspace-panel:visible")
  const noMenu = async () => assert.equal(await page.locator('[role="menu"]:visible').count(), 0)
  const project = await api("/api/organization/projects", "POST", { name: "Fictional project" })
  const chat = await api("/session", "POST", { title: "Fictional panel conversation" })
  await api(`/session/${chat.id}/prompt_async`, "POST", {
    noReply: true,
    agent: "build",
    model: { providerID: "panel-qa", modelID: "fixture" },
    parts: [{ type: "text", text: "Durable fictional input" }],
  })
  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), {
    directory,
    sessionID: chat.id,
  })
  const main = page.locator(`.bb-workspace-chat[data-bb-chat="${chat.id}"]`)
  await main.locator("[contenteditable=true]").first().waitFor()
  await main.getByRole("button", { name: "More options", exact: true }).waitFor()
  await main.locator("[contenteditable=true]").first().fill("An unsent fictional follow-up")
  await expand().click()
  await panel().locator(".bb-panel-tools").waitFor()
  await noMenu()
  assert.equal(await page.locator(".bb-panel-tabs [role=tab]").count(), 0)
  await collapse().click()
  await expand().click()
  await noMenu()
  await collapse().click()
  assert.equal(await main.locator("[contenteditable=true]").first().textContent(), "An unsent fictional follow-up")
  check(
    "Empty-panel expansion shows Tools without opening an add-tab menu or creating a tab; toggles preserve unsent text",
  )
  const headerOrder = async (open) => {
    const state = await page.evaluate((open) => {
      const chat = document.querySelector(".bb-workspace-chat")
      const panel = document.querySelector(".bb-workspace-panel")
      const more = chat.querySelector('button[aria-label="More options"]')
      const context = chat.querySelector('button[aria-label="View context usage"]')
      const owner = open ? panel.querySelector(".bb-panel-header") : more.parentElement
      const toggle = owner.querySelector('button[aria-label="' + (open ? "Collapse panel" : "Expand panel") + '"]')
      const box = (node) => {
        const rect = node.getBoundingClientRect()
        return { x: rect.x, y: rect.y, right: rect.right, width: rect.width, height: rect.height }
      }
      const buttons = [...owner.querySelectorAll("button")].filter((node) => node.offsetWidth)
      return {
        more: box(more),
        context: context && box(context),
        toggle: box(toggle),
        last: buttons.at(-1) === toggle,
        divider:
          !!toggle.previousElementSibling?.matches(".bb-panel-divider") ||
          !!toggle.parentElement.previousElementSibling?.matches(".bb-panel-divider"),
        mainToggle: !!chat.querySelector('button[aria-label="Collapse panel"]'),
      }
    }, open)
    assert.ok(state.last && state.divider)
    assert.ok(state.context && state.context.x < state.more.x && state.more.right <= state.toggle.x)
    assert.equal(state.mainToggle, false)
    report.geometry.push({ headerOpen: open, ...state })
    return state.toggle
  }
  const sameToggle = (before, after) => {
    for (const key of ["x", "y", "width", "height"])
      assert.ok(Math.abs(before[key] - after[key]) <= 0.5, `Toggle ${key}: ${before[key]} -> ${after[key]}`)
  }
  const closedToggle = await headerOrder(false)
  await expand().click()
  sameToggle(closedToggle, await headerOrder(true))
  await noMenu()
  await collapse().click()
  check(
    "Context usage and More options remain in the main chat; the rightmost divided toggle retains identical x/y/size when moved into the panel",
  )

  const recents = page.locator(".bb-org-recents")
  const group = page.locator(`section[data-project-id="${project.id}"]`)
  const begin = async () => {
    const link = recents.locator(`.bb-org-row[data-session-id="${chat.id}"] .bb-org-chat-link`)
    await link.scrollIntoViewIfNeeded()
    const rect = await link.boundingBox()
    await page.mouse.move(rect.x + rect.width * 0.65, rect.y + rect.height / 2)
    await page.mouse.down()
    await page.mouse.move(rect.x + rect.width * 0.65 + 10, rect.y + rect.height / 2 + 8, { steps: 4 })
    await page.locator(".bb-org-drag-preview").waitFor()
  }
  const over = async (target) => {
    const rect = await target.boundingBox()
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    await page.mouse.move(point.x, point.y, { steps: 10 })
    const preview = await page.locator(".bb-org-drag-preview").boundingBox()
    assert.ok(Math.abs(preview.x + preview.width * 0.65 - point.x) < 2)
  }
  const membership = async (projectID) => {
    const result = await api("/api/organization/chats/query", "POST", { search: chat.title })
    return (result.data.find((row) => row.id === chat.id)?.projectID ?? null) === projectID
  }
  await begin()
  await over(recents.locator(".bb-org-heading").first())
  assert.equal(await recents.getAttribute("data-project-drop"), null)
  assert.equal(await recents.evaluate((node) => node.classList.contains("drop-target")), false)
  assert.equal(await page.locator(".bb-org-unassign").count(), 0)
  await over(group.locator(".bb-org-children"))
  assert.equal(await group.evaluate((node) => getComputedStyle(node).outlineWidth), "1px")
  await page.mouse.up()
  await poll(() => membership(project.id), Boolean, "project assignment")
  await poll(
    () => group.locator(`[data-session-id="${chat.id}"]`).count(),
    (count) => count === 1,
    "project row",
  )
  check(
    "Unassigned drags have no Recents removal target; the entire project contents accept drops and the card remains anchored",
  )
  await begin()
  await over(recents.locator(".bb-org-heading").first())
  assert.equal(await recents.evaluate((node) => getComputedStyle(node).outlineWidth), "1px")
  await page.keyboard.press("Escape")
  await page.mouse.up()
  assert.equal(await membership(project.id), true)
  assert.equal(await recents.getAttribute("data-project-drop"), null)
  assert.equal(await recents.evaluate((node) => node.classList.contains("drop-target")), false)
  await begin()
  await over(recents.locator(".bb-org-heading").first())
  await page.mouse.up()
  await poll(() => membership(null), Boolean, "Recents unassignment")
  assert.equal((await api("/session/" + chat.id)).directory.toLowerCase(), directory.toLowerCase())
  assert.equal(await page.locator(".bb-org-unassign").count(), 0)
  check(
    "Project members highlight all of Recents; Escape cancels, a drop unassigns durably, and the execution folder is preserved",
  )

  await expand().click()
  await panel().getByRole("button", { name: "More tools…", exact: true }).click()
  await page.getByRole("menuitem", { name: "Code review", exact: true }).waitFor()
  await page.getByRole("menuitem", { name: "Open file", exact: true }).waitFor()
  await page.keyboard.press("Escape")
  await panel().getByRole("button", { name: "New page", exact: true }).click()
  await page.locator(".bb-browser-toolbar").waitFor()
  await poll(
    () => call("browser.list"),
    (rows) => rows.length === 1 && rows[0].url === "about:blank",
    "new browser page",
  )
  const browser = (await call("browser.list"))[0]
  await panel().getByRole("tab", { name: "Browser", exact: true }).waitFor()
  const tabControls = async () => {
    const geometry = await panel()
      .locator(".bb-panel-header")
      .evaluate((header) => {
        const add = header.querySelector(".bb-panel-add")
        const tabs = header.querySelector(".bb-panel-tabs")
        return {
          addFirst: header.firstElementChild === add,
          addBeforeTabs: add.getBoundingClientRect().right <= tabs.getBoundingClientRect().left,
          closeCenters: [...tabs.querySelectorAll(".bb-panel-tab-close")].map((button) => {
            const box = button.getBoundingClientRect()
            const icon = button.querySelector("svg").getBoundingClientRect()
            return {
              x: (icon.left + icon.right - box.left - box.right) / 2,
              y: (icon.top + icon.bottom - box.top - box.bottom) / 2,
              width: box.width,
              height: box.height,
            }
          }),
        }
      })
    assert.ok(geometry.addFirst && geometry.addBeforeTabs)
    assert.ok(geometry.closeCenters.length)
    for (const close of geometry.closeCenters) {
      assert.ok(Math.abs(close.x) <= 0.5 && Math.abs(close.y) <= 0.5)
      assert.equal(close.width, close.height)
    }
    report.geometry.push({ tabControls: geometry })
  }
  await tabControls()
  const address = page.locator(".bb-browser-toolbar input")
  assert.equal(await address.inputValue(), "")
  await panel().locator(".bb-panel-tools").waitFor()
  const native = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]
        .contentView.children.filter((view) => !!view.webContents)
        .map((view) => ({ url: view.webContents.getURL(), visible: view.getVisible(), bounds: view.getBounds() })),
    )
  await poll(native, (views) => views.length === 1 && !views[0].visible, "blank native page hidden")
  await noMenu()
  check(
    "New browser tabs show a local Tools landing and empty address; overflow offers working Review/File actions; blank native content stays hidden",
  )
  for (const scheme of ["dark", "light"]) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForFunction((scheme) => document.documentElement.dataset.colorScheme === scheme, scheme)
    const geometry = await page.locator(".bb-browser-toolbar").evaluate((toolbar) => ({
      height: toolbar.getBoundingClientRect().height,
      addressRadius: getComputedStyle(toolbar.querySelector("input")).borderRadius,
      navigationRadius: getComputedStyle(toolbar.querySelector(".bb-browser-navigation")).borderRadius,
      actionsRadius: getComputedStyle(toolbar.querySelector(".bb-browser-actions")).borderRadius,
    }))
    assert.equal(geometry.height, 48)
    assert.equal(geometry.addressRadius, "999px")
    assert.equal(geometry.navigationRadius, "999px")
    assert.equal(geometry.actionsRadius, "50%")
    report.geometry.push({ scheme, ...geometry })
    if (capture) {
      const path = join(output, basename + "-" + scheme + ".png")
      report.screenshots.push({ path, ...(await captureHidden(app, page, path)) })
    }
  }
  check("Both themes retain the reference's 48px toolbar, rounded navigation/address and circular overflow")
  await address.fill(website + "/one")
  await address.press("Enter")
  await poll(
    native,
    (views) => views.length === 1 && views[0].visible && views[0].url.endsWith("/one"),
    "native page one",
  )
  await address.fill(website + "/draft")
  await call("browser.navigate", { id: browser.id, url: website + "/two" })
  assert.equal(await address.inputValue(), website + "/draft")
  await address.press("Escape")
  assert.equal(await address.inputValue(), website + "/two")
  await page.getByRole("button", { name: "Back", exact: true }).click()
  await poll(native, (views) => views[0]?.url.endsWith("/one"), "back navigation")
  await page.getByRole("button", { name: "Forward", exact: true }).click()
  await poll(native, (views) => views[0]?.url.endsWith("/two"), "forward navigation")
  await page.getByRole("button", { name: "Browser actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Copy address", exact: true }).waitFor()
  await page.getByRole("menuitem", { name: "Open in default browser", exact: true }).waitFor()
  await poll(native, (views) => views[0]?.visible === false, "menu hides native page")
  await page.keyboard.press("Escape")
  await poll(native, (views) => views[0]?.visible === true, "menu restores native page")
  check(
    "Enter navigates; background navigation preserves typed addresses; Escape restores the current URL; history and overflow isolation work",
  )
  await address.fill("file:///blocked")
  await address.press("Enter")
  await page.locator(".bb-browser-error").waitFor()
  assert.ok((await call("browser.list"))[0].url.endsWith("/two"))
  await address.fill(website + "/one")
  await page.locator(".bb-browser-error").getByRole("button", { name: "Retry", exact: true }).click()
  await page.locator(".bb-browser-error").waitFor({ state: "hidden" })
  await poll(native, (views) => views[0]?.url.endsWith("/one"), "retry navigation")
  check("Invalid protocols fail visibly without replacing the page; retry recovers with a valid address")

  const preferred = await page.evaluate(
    (id) =>
      JSON.parse(
        Object.entries(localStorage).find(
          ([key]) => key.startsWith("bitsbytes.panels.v2:") && key.endsWith(":" + id),
        )[1],
      ).width,
    chat.id,
  )
  for (const zoom of [1, 1.25])
    for (const width of [1380, 900]) {
      await app.evaluate(
        ({ BrowserWindow }, { zoom, width }) => {
          const window = BrowserWindow.getAllWindows()[0]
          window.webContents.setZoomFactor(zoom)
          window.setContentSize(width, 900)
        },
        { zoom, width },
      )
      await page.waitForFunction(({ zoom, width }) => Math.abs(innerWidth - width / zoom) < 1, { zoom, width })
      await poll(
        async () => {
          const frame = await page.locator(".bb-browser-host").evaluate((host) => {
            const panel = host.closest(".bb-workspace-panel")
            const rect = host.getBoundingClientRect()
            const panelBox = panel.getBoundingClientRect()
            const controls = [
              ...panel.querySelectorAll(".bb-panel-header button,.bb-browser-toolbar button,.bb-browser-toolbar input"),
            ].filter((node) => node.offsetWidth)
            return {
              host: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              fits: controls.every((node) => {
                const rect = node.getBoundingClientRect()
                return rect.left >= panelBox.left && rect.right <= panelBox.right && rect.right <= innerWidth
              }),
              inert: document.querySelector(".bb-workspace-chat").inert,
              overlay: panel.classList.contains("bb-workspace-panel-overlay"),
            }
          })
          const views = await native()
          return { ...frame, native: views[0] }
        },
        (frame) => {
          const expected = Object.fromEntries(
            Object.entries(frame.host).map(([key, value]) => [key, Math.round(value * zoom)]),
          )
          return (
            frame.fits &&
            frame.inert === frame.overlay &&
            frame.native?.visible &&
            Object.keys(expected).every((key) => Math.abs(expected[key] - frame.native.bounds[key]) <= 1)
          )
        },
        `browser bounds ${zoom}/${width}`,
      )
      await collapse().click()
      await panel().waitFor({ state: "hidden" })
      await poll(native, (views) => views[0]?.visible === false, "collapsed browser hidden")
      const before = await expand().boundingBox()
      await expand().click()
      sameToggle(before, await collapse().boundingBox())
      await tabControls()
      await noMenu()
      assert.equal(
        await panel()
          .locator(".bb-panel-collapse")
          .getByRole("button", { name: "Collapse panel", exact: true })
          .count(),
        1,
      )
    }
  check(
    "Toolbar/tabs/toggle and native bounds fit at 100%/125% in normal and narrow panels; collapse/reopen keeps menus closed",
  )
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setZoomFactor(1)
    window.setContentSize(1380, 900)
  })
  await panel().locator(".bb-panel-tabs>div").getByRole("button", { name: "Close tab", exact: true }).click()
  await panel().waitFor({ state: "hidden" })
  await poll(
    () => call("browser.list"),
    (rows) => rows.length === 0,
    "owned browser disposed",
  )
  await expand().click()
  await noMenu()
  await panel().locator(".bb-panel-tools").waitFor()
  assert.equal(
    await page.evaluate(
      (id) =>
        JSON.parse(
          Object.entries(localStorage).find(
            ([key]) => key.startsWith("bitsbytes.panels.v2:") && key.endsWith(":" + id),
          )[1],
        ).width,
      chat.id,
    ),
    preferred,
  )
  await panel().getByRole("button", { name: "Terminal", exact: true }).click()
  await panel().getByRole("tab", { name: "Terminal", exact: true }).waitFor()
  await poll(
    () => api("/pty"),
    (rows) => rows.length === 1,
    "single terminal",
  )
  await panel().locator(".bb-panel-tabs>div").getByRole("button", { name: "Close tab", exact: true }).click()
  await panel().waitFor({ state: "hidden" })
  check(
    "Final-tab closure releases its browser and collapses the panel; reopening retains width; Terminal landing creates one shell",
  )
  await expand().click()
  await panel().getByRole("button", { name: "Side chat", exact: true }).click()
  const sideEditor = () => panel().locator(".bb-panel-content:visible [contenteditable=true]").first()
  const sideID = () => panel().locator(".bb-panel-content:visible [data-bb-chat]").first().getAttribute("data-bb-chat")
  await sideEditor().waitFor()
  const firstSide = await sideID()
  await sideEditor().fill("Independent first side-chat draft")
  await panel().locator(".bb-panel-add button").click()
  await page.getByRole("menuitem", { name: "Side chat", exact: true }).click()
  await poll(
    () => sideID(),
    (id) => id && id !== firstSide,
    "independent second side chat",
  )
  const secondSide = await sideID()
  await sideEditor().waitFor()
  await sideEditor().fill("Independent second side-chat draft")
  const tabs = () => panel().locator(".bb-panel-tabs>div")
  assert.equal(await tabs().count(), 2)
  await tabControls()
  await tabs().nth(0).getByRole("tab").click()
  assert.equal(await sideID(), firstSide)
  assert.equal(await sideEditor().textContent(), "Independent first side-chat draft")
  await tabs().nth(1).getByRole("tab").click()
  assert.equal(await sideID(), secondSide)
  assert.equal(await sideEditor().textContent(), "Independent second side-chat draft")
  await tabs().nth(0).getByRole("button", { name: "Close tab", exact: true }).click()
  await poll(
    () => api("/session/" + firstSide),
    (child) => !!child.time?.archived,
    "only first side archived",
  )
  assert.equal((await api("/session/" + secondSide)).time?.archived, undefined)
  assert.equal(await sideID(), secondSide)
  assert.equal(await sideEditor().textContent(), "Independent second side-chat draft")
  await tabs().getByRole("button", { name: "Close tab", exact: true }).click()
  await panel().waitFor({ state: "hidden" })
  await poll(
    () => api("/session/" + secondSide),
    (child) => !!child.time?.archived,
    "second side archived",
  )
  assert.equal(await main.locator("[contenteditable=true]").first().textContent(), "An unsent fictional follow-up")
  check(
    "The add button stays left; close icons center in both axes; two side chats retain independent drafts, switching and owned closure",
  )
  assert.deepEqual(report.errors, [])
  assert.ok(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
    ),
  )
  check("Zero renderer errors; all QA windows stayed hidden and unfocused; no account or paid model was used")
} catch (error) {
  report.failure = error.stack || String(error)
  if (app)
    report.failureUI = await (
      await app.firstWindow()
    )
      .evaluate(() => ({
        route: location.pathname,
        text: document.body.innerText.slice(0, 2400),
      }))
      .catch(() => undefined)
  process.exitCode = 1
} finally {
  await app?.close()
  await new Promise((resolve) => fixture.close(resolve))
  await writeFile(join(output, basename + ".json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
