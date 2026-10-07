import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const root = resolve("../.."),
  assets = process.env.BB_MOBILE_ASSETS || join(root, "packages/desktop/resources/bitsbytes/mobile")
const { mobileCopy } = await import(pathToFileURL(join(root, "packages/desktop/src/bitsbytes/mobile-copy.ts")).href)
const { chromium } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const file = {
  id: "grid_qa",
  sessionID: "ses_grid",
  filename: "Dense.xlsx",
  revision: 2,
  kind: "spreadsheet",
  status: "ready",
  turnIDs: ["msg_grid"],
  versions: [
    { revision: 1, turnID: "msg_grid" },
    { revision: 2, turnID: "msg_second" },
  ],
}
const state = {
  reads: [],
  hold: false,
  fail: false,
  entered: Promise.withResolvers(),
  release: Promise.withResolvers(),
}
const report = { checks: [], errors: [], observation: undefined, sends: 0, requests: state.reads }
const check = (label) => {
  report.checks.push(label)
  console.log("PASS", label)
}
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://127.0.0.1").pathname
    if (request.method === "GET") {
      if (path === "/favicon.ico") {
        response.writeHead(204).end()
        return
      }
      if (path === "/uploads") {
        response.end("[]")
        return
      }
      const value =
        path === "/copy.js"
          ? "window.BB_COPY=" + JSON.stringify(mobileCopy)
          : await readFile(join(assets, path === "/" ? "index.html" : path.slice(1)))
      response.setHeader(
        "content-type",
        path === "/" ? "text/html" : path.endsWith(".css") ? "text/css" : "text/javascript",
      )
      response.end(value)
      return
    }
    const bytes = []
    for await (const chunk of request) bytes.push(chunk)
    const input = JSON.parse(Buffer.concat(bytes).toString("utf8"))
    if (input.method === "send") report.sends++
    let value = {}
    if (input.method === "overview")
      value = { chats: [{ id: "ses_grid", title: "Phone grid QA" }], skills: [], models: [] }
    if (input.method === "chat")
      value = {
        title: "Phone grid QA",
        messages: [
          { info: { id: "msg_grid", role: "assistant" }, parts: [{ type: "text", text: "Published spreadsheet" }] },
        ],
        status: { type: "idle" },
        run: { queue: [] },
        permissions: [],
        questions: [],
        access: { mode: "ask" },
      }
    if (input.method === "artifacts") value = [file]
    if (input.method === "content") {
      const args = input.args,
        offset = args.offset || 0,
        sheet = args.sheet || "Alpha",
        revision = args.revision
      state.reads.push({ offset, sheet, revision })
      if (state.hold && offset) {
        state.entered.resolve()
        await state.release.promise
      }
      if (state.fail) {
        state.fail = false
        response
          .writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "QA source temporarily unavailable" }))
        return
      }
      const total = sheet === "Alpha" ? 260 : 4
      value = {
        sheets: ["Alpha", "Beta"],
        sheet,
        offset,
        total,
        columns: sheet === "Alpha" ? 125 : 2,
        shortened: sheet === "Alpha",
        rows: Array.from({ length: Math.min(80, Math.max(0, total - offset)) }, (_, index) => [
          `${revision === 2 ? "V2 " : ""}${sheet} Row ${offset + index}`,
          "Visible complete cell",
        ]),
      }
    }
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(value))
  } catch (error) {
    report.errors.push(String(error))
    response.writeHead(500).end("{}")
  }
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const browser = await chromium.launch({ headless: true, channel: "msedge" })
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }),
    page = await context.newPage()
  page.on("pageerror", (error) => report.errors.push(error.message))
  await page.addInitScript(() => localStorage.setItem("bb.session", "ses_grid"))
  await page.goto("http://127.0.0.1:" + server.address().port)
  await page.locator(".artifact-card").click()
  const preview = page.locator("#preview-content"),
    table = preview.locator("table"),
    next = preview.getByRole("button", { name: mobileCopy.next, exact: true }),
    previous = preview.getByRole("button", { name: mobileCopy.previous, exact: true })
  await table.getByText("Alpha Row 0", { exact: true }).waitFor()
  state.hold = true
  await next.click()
  await state.entered.promise
  report.observation = {
    requested: state.reads.at(-1).offset,
    nextDisabled: await next.isDisabled(),
    previousDisabled: await previous.isDisabled(),
    selectorDisabled: await preview.locator("select").isDisabled(),
    rowHeaders: await table.locator("th").count(),
  }
  state.hold = false
  state.release.resolve()
  if (process.env.BB_GRID_OBSERVE === "1") {
    await table.getByText("Alpha Row " + report.observation.requested, { exact: true }).waitFor()
    console.log("OBSERVATION", JSON.stringify(report.observation))
  } else {
    assert.deepEqual(report.observation, {
      requested: 80,
      nextDisabled: true,
      previousDisabled: true,
      selectorDisabled: true,
      rowHeaders: 80,
    })
    await table.getByText("Alpha Row 80", { exact: true }).waitFor()
    assert.equal(await table.locator("th").first().innerText(), "81")
    await preview.getByText(mobileCopy.sheetCellLimit, { exact: true }).waitFor()
    await preview.getByText(mobileCopy.sheetColumnLimit, { exact: true }).waitFor()
    check("Bounded pages advance by actual rows; pending controls hold and both preview limits are explicit")
    state.fail = true
    await next.click()
    await preview.getByRole("button", { name: mobileCopy.retry, exact: true }).waitFor()
    assert.equal(await table.locator("th").first().innerText(), "81")
    assert.equal(await next.isEnabled(), true)
    await preview.getByRole("button", { name: mobileCopy.retry, exact: true }).click()
    await table.getByText("Alpha Row 160", { exact: true }).waitFor()
    await previous.click()
    await table.getByText("Alpha Row 80", { exact: true }).waitFor()
    await previous.click()
    await table.getByText("Alpha Row 0", { exact: true }).waitFor()
    assert.equal(await previous.isDisabled(), true)
    check("Failed page reads keep their data, recover without unhandled errors and return through actual page history")
    await preview.locator("select").selectOption("Beta")
    await table.getByText("Beta Row 0", { exact: true }).waitFor()
    assert.equal(await table.locator("tr").count(), 4)
    assert.equal(await next.isDisabled(), true)
    assert.equal(await preview.getByText(mobileCopy.sheetCellLimit, { exact: true }).count(), 0)
    check("Switching sheets uses the new sheet total and clears old limits and navigation history")
    await preview.locator("select").selectOption("Alpha")
    await table.getByText("Alpha Row 0", { exact: true }).waitFor()
    state.hold = true
    state.entered = Promise.withResolvers()
    state.release = Promise.withResolvers()
    await next.click()
    await state.entered.promise
    await page.locator("#versions").selectOption("2")
    await table.getByText("V2 Alpha Row 0", { exact: true }).waitFor()
    state.hold = false
    state.release.resolve()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(await table.getByText("V2 Alpha Row 0", { exact: true }).count(), 1)
    assert.equal(await table.getByText("Alpha Row 80", { exact: true }).count(), 0)
    assert.equal(await previous.isDisabled(), true)
    check("Changing saved revisions invalidates a held old page and starts the new revision at its first row")
    assert.deepEqual(report.errors, [])
    assert.equal(report.sends, 0)
  }
} catch (error) {
  report.failure = String(error)
  console.error(error)
  process.exitCode = 1
} finally {
  state.release.resolve()
  await writeFile(
    join(root, ".tools/qa/results", process.env.BB_GRID_REPORT || "mobile-grid.json"),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
