import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { mobileCopy } from "../src/bitsbytes/mobile-copy.ts"

const root = resolve("../.."),
  assets = process.env.BB_MOBILE_ASSETS || join(root, "packages/desktop/resources/bitsbytes/mobile")
const { chromium } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const observe = process.env.BB_PHONE_PREVIEW_OBSERVE === "1"
const report = { checks: [], observations: [], errors: [] }
const file = {
  id: "artifact_pdf",
  sessionID: "ses_pdf",
  filename: "Phone PDF.pdf",
  revision: 1,
  kind: "pdf",
  status: "ready",
  turnIDs: ["msg_pdf"],
  versions: [{ revision: 1, turnID: "msg_pdf" }],
}
const pdfModule = `export const GlobalWorkerOptions = {};
export function getDocument() {
  const control = window.__phonePDF = { calls: [], hold: 0, held: null };
  const sheet = index => ({ getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }), render: ({ canvas, canvasContext }) => { const target = canvas || canvasContext.canvas; target.dataset.page = String(index); return { promise: Promise.resolve(), cancel() {} }; } });
  const pdf = { numPages: 3, destroy: () => Promise.resolve(), getPage(index) { control.calls.push(index); if (control.hold !== index) return Promise.resolve(sheet(index)); return new Promise((resolve, reject) => { control.held = { release: () => resolve(sheet(index)), reject: () => reject(new Error("QA phone PDF page failed")) }; }); } };
  return { promise: Promise.resolve(pdf), destroy: () => Promise.resolve() };
}`
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://127.0.0.1").pathname
    if (request.method === "GET") {
      if (path === "/favicon.ico") {
        response.writeHead(204).end()
        return
      }
      const source =
        path === "/uploads"
          ? "[]"
          : path === "/copy.js"
            ? "window.BB_COPY=" + JSON.stringify(mobileCopy)
            : path === "/pdf.mjs"
              ? pdfModule
              : await readFile(join(assets, path === "/" ? "index.html" : path.slice(1)))
      response.setHeader(
        "content-type",
        path === "/" ? "text/html" : path.endsWith(".css") ? "text/css" : "text/javascript",
      )
      response.end(source)
      return
    }
    let source = ""
    for await (const chunk of request) source += chunk
    const input = JSON.parse(source)
    const value =
      input.method === "overview"
        ? { chats: [{ id: "ses_pdf", title: "Phone PDF QA" }], models: [], skills: [] }
        : input.method === "chat"
          ? {
              title: "Phone PDF QA",
              messages: [
                {
                  info: { id: "msg_pdf", role: "assistant" },
                  parts: [{ type: "text", text: "Synthetic PDF fixture" }],
                },
              ],
              status: { type: "idle" },
              access: { mode: "ask" },
              run: { queue: [], paused: false, awaiting: false, error: "" },
              permissions: [],
              questions: [],
            }
          : input.method === "artifacts"
            ? [file]
            : {}
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(value))
  } catch (error) {
    report.errors.push(String(error))
    response.writeHead(500).end("{}")
  }
})
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const browser = await chromium.launch({ headless: true, channel: "msedge" })
try {
  for (const scenario of ["close", "error", "ordering"]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } }),
      page = await context.newPage(),
      errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.addInitScript(() => localStorage.setItem("bb.session", "ses_pdf"))
    await page.goto("http://127.0.0.1:" + server.address().port)
    await page.locator(".artifact-card").click()
    await page.waitForFunction(() => document.querySelector("#preview-content canvas")?.dataset.page === "1")
    await page.evaluate(() => {
      window.__phonePDF.hold = 2
    })
    await page.locator("#next-page").click()
    await page.waitForFunction(() => Boolean(window.__phonePDF.held))
    if (scenario === "close") {
      await page.locator("#preview-close").click()
      await page.evaluate(() => window.__phonePDF.held.reject())
    } else if (scenario === "error") {
      await page.evaluate(() => window.__phonePDF.held.reject())
    } else {
      await page.locator("#next-page").click()
      await page.waitForFunction(() => document.querySelector("#preview-content canvas")?.dataset.page === "3")
      await page.evaluate(() => window.__phonePDF.held.release())
    }
    await page.waitForTimeout(150)
    const result = await page.evaluate(() => ({
      page: document.querySelector("#preview-content canvas")?.dataset.page,
      visibleError: document.querySelector("#preview-content")?.textContent.includes("QA phone PDF page failed"),
      open: document.querySelector("#preview").open,
    }))
    const passed =
      errors.length === 0 &&
      (scenario === "close" ? !result.open : scenario === "error" ? result.visibleError : result.page === "3")
    report.observations.push({ scenario, passed, ...result, errors })
    if (!observe) {
      assert.equal(passed, true, JSON.stringify(report.observations.at(-1)))
      if (scenario === "error") {
        await page.evaluate(() => {
          window.__phonePDF.hold = 0
        })
        await page.locator("#preview-content").getByRole("button", { name: mobileCopy.retry, exact: true }).click()
        await page.waitForFunction(() => document.querySelector("#preview-content canvas")?.dataset.page === "2")
      }
      report.checks.push(scenario)
      console.log("PASS", scenario)
    }
    await context.close()
  }
  assert.deepEqual(report.errors, [])
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  await writeFile(
    join(root, ".tools/qa/results", process.env.BB_PHONE_PREVIEW_REPORT || "phone-preview.json"),
    JSON.stringify(report, null, 2),
  )
}
console.log(JSON.stringify(report))
