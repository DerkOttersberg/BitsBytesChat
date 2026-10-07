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
const messages = Array.from({ length: 64 }, (_, index) => ({
  info: { id: "msg_" + String(index).padStart(4, "0"), role: index % 2 ? "assistant" : "user", tokens: 1 },
  parts: [
    { type: "text", text: `Message ${index} · ` + "Complete visible source 🌿 ".repeat(160) + ` END ${index}` },
    ...(index === 2 ? [{ type: "file", url: "bitsbytes://skill/stable?revision=1", filename: "Stable source" }] : []),
  ],
}))
const file = {
  id: "artifact_1",
  sessionID: "ses_a",
  filename: "Timeline file.txt",
  revision: 1,
  kind: "code",
  status: "ready",
  turnIDs: ["msg_0005"],
  versions: [{ revision: 1, turnID: "msg_0005" }],
}
const state = { revision: 0, files: [file] }
const report = {
  workload:
    "64 complete visible messages, metadata/stream/artifact/append updates through the actual phone renderer; native DOM selection and focus",
  observations: [],
  checks: [],
  errors: [],
  sends: 0,
}
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
      const source =
        path === "/copy.js"
          ? "window.BB_COPY=" + JSON.stringify(mobileCopy)
          : await readFile(join(assets, path === "/" ? "index.html" : path.slice(1)))
      response.setHeader(
        "content-type",
        path === "/" ? "text/html" : path.endsWith(".css") ? "text/css" : "text/javascript",
      )
      response.end(source)
      return
    }
    const bytes = []
    for await (const chunk of request) bytes.push(chunk)
    const body = Buffer.concat(bytes).toString("utf8")
    const input = JSON.parse(body),
      id = input.args?.sessionID || "ses_a"
    if (input.method === "send") report.sends++
    const value =
      input.method === "overview"
        ? {
            chats: [
              { id: "ses_a", title: "Timeline QA" },
              { id: "ses_b", title: "Empty chat" },
            ],
            models: [],
            skills: [],
          }
        : input.method === "chat"
          ? {
              title: id === "ses_a" ? "Timeline QA v" + state.revision : "Empty chat",
              messages: id === "ses_a" ? messages : [],
              status: { type: "busy" },
              access: { mode: "ask" },
              run: { queue: [], paused: false, awaiting: false, error: "" },
              permissions: [],
              questions: [],
            }
          : input.method === "artifacts"
            ? id === "ses_a"
              ? state.files
              : []
            : input.method === "content"
              ? { text: "Exact file revision " + input.args.revision }
              : {}
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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  page.on("pageerror", (error) => report.errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem("bb.session", "ses_a")
    localStorage.setItem("bb.draft.ses_a", JSON.stringify({ text: "Keep my unsent request" }))
  })
  await page.goto("http://127.0.0.1:" + server.address().port)
  await page.waitForFunction(() => document.querySelectorAll("#messages .message").length === 64)
  await page.evaluate(() => {
    const root = document.querySelector("#messages")
    window.__bbTimelineQA = { added: 0, removed: 0 }
    new MutationObserver((records) => {
      for (const record of records) {
        window.__bbTimelineQA.added += [...record.addedNodes].filter(
          (node) => node.nodeType === 1 && node.matches(".message"),
        ).length
        window.__bbTimelineQA.removed += [...record.removedNodes].filter(
          (node) => node.nodeType === 1 && node.matches(".message"),
        ).length
      }
    }).observe(root, { childList: true })
  })
  const pin = async () =>
    page.evaluate(() => {
      const row = [...document.querySelectorAll("#messages .message")].find((row) =>
        row.querySelector(".message-text")?.textContent.startsWith("Message 3 ·"),
      )
      const text = row.querySelector(".message-text").firstChild,
        range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 9)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      const button = document.querySelector("#messages .source-chip")
      button.focus({ preventScroll: true })
      document.querySelector("#messages").scrollTop = 0
      Object.assign(window.__bbTimelineQA, { added: 0, removed: 0, row, button })
      return { selection: selection.toString(), focused: document.activeElement === button }
    })
  const observe = async (label, mutate, expectedAdded, expectedRemoved) => {
    assert.deepEqual(await pin(), { selection: "Message 3", focused: true })
    mutate()
    state.revision++
    await page.waitForFunction(
      (title) => document.querySelector("#chat-title").textContent === title,
      "Timeline QA v" + state.revision,
    )
    const result = await page.evaluate(() => ({
      selection: window.getSelection().toString(),
      focused: document.activeElement === window.__bbTimelineQA.button,
      rowConnected: window.__bbTimelineQA.row.isConnected,
      added: window.__bbTimelineQA.added,
      removed: window.__bbTimelineQA.removed,
      rows: document.querySelectorAll("#messages .message").length,
    }))
    report.observations.push({ label, expectedAdded, expectedRemoved, expectedRows: messages.length, ...result })
    assert.equal(await page.locator("#prompt").inputValue(), "Keep my unsent request")
  }
  await observe(
    "Metadata-only update",
    () => {
      messages[63].info.tokens++
    },
    0,
    0,
  )
  await observe(
    "Streaming text update",
    () => {
      messages[63].parts[0].text += " STREAM END"
    },
    1,
    1,
  )
  await observe(
    "Artifact revision update",
    () => {
      file.revision = 2
      file.turnIDs.push("msg_0063")
      file.versions.push({ revision: 2, turnID: "msg_0063" })
    },
    2,
    2,
  )
  assert.equal(
    await page
      .locator(".artifact-card")
      .filter({ hasText: mobileCopy.revision + " 1" })
      .count(),
    1,
  )
  assert.equal(
    await page
      .locator(".artifact-card")
      .filter({ hasText: mobileCopy.revision + " 2" })
      .count(),
    1,
  )
  await observe(
    "Append a message",
    () => {
      messages.push({
        info: { id: "msg_0064", role: "assistant", tokens: 1 },
        parts: [{ type: "text", text: "Appended complete response" }],
      })
    },
    1,
    0,
  )
  assert.equal(await page.locator("#messages .message").count(), 65)
  assert.equal(
    await page.locator("#messages .message-text").filter({ hasText: "END 3" }).first().innerText(),
    messages[3].parts[0].text,
  )
  check("Complete visible text, streaming tail and historical/latest artifact labels remain correct")
  await page
    .locator(".artifact-card")
    .filter({ hasText: mobileCopy.revision + " 1" })
    .click()
  await page.getByText("Exact file revision 1", { exact: true }).waitFor()
  assert.equal(await page.locator("#versions option").count(), 2)
  assert.equal(await page.locator("#versions").inputValue(), "1")
  await page.locator("#versions").selectOption("2")
  await page.getByText("Exact file revision 2", { exact: true }).waitFor()
  await page.locator("#preview-close").click()
  check("A historical card still opens its exact revision and offers the current saved version")
  await observe(
    "Delete and reorder history",
    () => {
      messages.shift()
      messages.unshift(messages.pop())
    },
    1,
    2,
  )
  assert.ok(
    (await page.locator("#messages .message-text").first().innerText()).startsWith("Appended complete response"),
  )
  assert.equal(await page.locator("#messages .message-text").filter({ hasText: "END 0" }).count(), 0)
  await observe(
    "Repeated source IDs",
    () => {
      messages.push(
        {
          info: { id: "msg_repeated", role: "assistant", tokens: 1 },
          parts: [{ type: "text", text: "Repeated first source" }],
        },
        {
          info: { id: "msg_repeated", role: "assistant", tokens: 1 },
          parts: [{ type: "text", text: "Repeated second source" }],
        },
      )
    },
    2,
    0,
  )
  await observe(
    "Repeated IDs metadata update",
    () => {
      messages.at(-1).info.tokens++
    },
    0,
    0,
  )
  await page.locator("#menu-button").click()
  await page.getByRole("button", { name: "Empty chat", exact: true }).click()
  await page.getByText(mobileCopy.empty, { exact: true }).waitFor()
  assert.equal(await page.locator("#messages .message").count(), 0)
  await page.locator("#menu-button").click()
  await page.getByRole("button", { name: "Timeline QA", exact: true }).click()
  await page.waitForFunction(
    (count) => document.querySelectorAll("#messages .message").length === count,
    messages.length,
  )
  assert.equal(await page.locator("#prompt").inputValue(), "Keep my unsent request")
  check("Switching to an empty chat and back retains history ownership and its unsent draft")
  assert.equal(report.sends, 0)
  assert.deepEqual(report.errors, [])
  for (const observation of report.observations) {
    assert.equal(observation.selection, "Message 3", observation.label + " lost text selection")
    assert.equal(observation.focused, true, observation.label + " lost keyboard focus")
    assert.equal(observation.rowConnected, true, observation.label + " replaced an unchanged message")
    assert.equal(observation.added, observation.expectedAdded, observation.label + " inserted unnecessary rows")
    assert.equal(observation.removed, observation.expectedRemoved, observation.label + " removed unnecessary rows")
    assert.equal(observation.rows, observation.expectedRows, observation.label + " retained obsolete rows")
  }
  check(
    "Selection, focus, removals, reordering and repeated source IDs retain correct rows with only affected content changed",
  )
} catch (error) {
  report.failure = String(error)
  console.error(error)
  process.exitCode = 1
} finally {
  await writeFile(
    join(root, ".tools/qa/results", process.env.BB_TIMELINE_REPORT || "mobile-timeline-baseline.json"),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
