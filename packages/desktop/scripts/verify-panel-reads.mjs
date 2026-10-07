import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { promisify } from "node:util"

const root = resolve("../.."),
  desktop = resolve(process.env.BB_QA_MAIN || process.cwd()),
  { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright"),
  profile = join(root, ".tools/qa/panel-reads-" + randomUUID()),
  data = join(profile, "BitsBytesChat"),
  fault = join(profile, "fault.json"),
  captured = join(profile, "captured.json"),
  trace = join(profile, "calls.jsonl"),
  observe = process.env.BB_PANEL_READ_OBSERVE === "1",
  report = { checks: [], errors: [], observations: [] }
if (!process.env.BB_ARTIFACT_PYTHON) throw new Error("Select the QA artifact Python")
await mkdir(join(data, "config/opencode"), { recursive: true })
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(fault, "{}")
await writeFile(trace, "")
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    model: "panel-qa/fixture",
    provider: {
      "panel-qa": {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "fixture-only" },
        models: { fixture: { name: "Panel fixture", limit: { context: 128000, output: 8192 } } },
      },
    },
  }),
)
const shim = join(profile, "shim.mjs")
await writeFile(
  shim,
  `import { app, ipcMain } from "electron";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
app.getAppPath = () => ${JSON.stringify(desktop)};
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
  if (channel === "bitsbytes:call") appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ method: args[1], id: args[2]?.id }) + "\\n");
  const value = await listener(...args);
  if (channel !== "bitsbytes:call") return value;
  const mode = JSON.parse(readFileSync(${JSON.stringify(fault)}, "utf8"));
  if (mode.method !== args[1] || !mode.hold) return value;
  const snapshot = structuredClone(value);
  writeFileSync(${JSON.stringify(fault)}, "{}");
  writeFileSync(${JSON.stringify(captured)}, JSON.stringify({ round: mode.round }));
  const release = join(${JSON.stringify(profile)}, "release-" + mode.round + ".json");
  for (let index = 0; index < 750 && !existsSync(release); index++) await new Promise(resolve => setTimeout(resolve, 20));
  if (!existsSync(release)) throw new Error("QA held panel read was not released");
  if (mode.rejectHeld) throw new Error("QA disposed browser list failure");
  return snapshot;
});
await import(pathToFileURL(${JSON.stringify(join(desktop, "out/main/index.js"))}).href);
`,
)
const fixture = createServer((request, response) =>
  response.end(
    `<title>${request.url === "/current" ? "Current panel page" : "Original panel page"}</title><p>Owned QA page</p>`,
  ),
)
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve))
const baseURL = "http://127.0.0.1:" + fixture.address().port
let app
function check(label, passed, detail) {
  report.observations.push({ label, passed, ...detail })
  if (passed) {
    report.checks.push(label)
    console.log("PASS", label)
  } else if (observe) console.log("OBSERVED", label, JSON.stringify(detail))
  else throw new Error(label + ": " + JSON.stringify(detail))
}
async function capturedRound(round) {
  for (let index = 0; index < 200; index++) {
    if (JSON.parse(await readFile(captured, "utf8").catch(() => "{}")).round === round) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("No held panel read: " + round)
}
const python = (code) =>
  promisify(execFile)(process.env.BB_ARTIFACT_PYTHON, ["-c", code], { windowsHide: true, timeout: 30000 })
try {
  app = await _electron.launch({
    executablePath: process.env.BB_QA_EXECUTABLE || join(desktop, "node_modules/electron/dist/electron.exe"),
    args: [shim],
    env: { ...process.env, BB_QA_ISOLATED: "1", LOCALAPPDATA: profile },
    timeout: 90000,
  })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.hide()))
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on("pageerror", (error) => report.errors.push(error.message))
  await page.locator("[contenteditable=true]").first().waitFor({ timeout: 90000 })
  const server = await page.evaluate(() => window.api.awaitInitialization()),
    directory = join(data, "workspace"),
    headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) }
  if (server.password)
    headers.authorization =
      "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")
  const response = await fetch(server.url + "/session", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Panel read QA" }),
    signal: AbortSignal.timeout(15000),
  })
  assert.ok(response.ok)
  const session = await response.json()
  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), {
    directory,
    sessionID: session.id,
  })
  await page.locator(`.bb-workspace-chat[data-bb-chat="${session.id}"] [contenteditable=true]`).first().waitFor()
  const call = (method, args = {}) =>
      page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args }),
    closeTab = async (name) => {
      await page
        .getByRole("tab", { name, exact: true })
        .locator("..")
        .getByRole("button")
        .click()
      await page.getByRole("tab", { name, exact: true }).waitFor({ state: "detached" })
    },
    contentReads = async (id) =>
      (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
        .filter((row) => row.method === "artifact.content" && row.id === id).length
  const imagePath = join(data, "Read fixture.png")
  await python(`from PIL import Image\nImage.new('RGB',(8,8),'green').save(${JSON.stringify(imagePath)})`)
  const image = await call("artifact.publish", { path: imagePath, sessionID: session.id })
  await page.locator(".bb-panel-content:visible .bb-artifact-image img").waitFor()
  await closeTab(image.filename)
  await writeFile(fault, JSON.stringify({ method: "artifacts.list", hold: true, round: 1 }))
  await page.evaluate(
    (id) => window.dispatchEvent(new CustomEvent("bitsbytes:open-artifact", { detail: { id } })),
    image.id,
  )
  await capturedRound(1)
  const priorReads = await contentReads(image.id)
  await closeTab(image.filename)
  await writeFile(join(profile, "release-1.json"), "{}")
  await page.waitForTimeout(250)
  check(
    "Closed image panels do not start a late content read or allocate its preview",
    (await contentReads(image.id)) === priorReads,
    { priorReads, afterReads: await contentReads(image.id) },
  )
  const pdfPath = join(data, "Recovery.pdf")
  const createPDF = (text) =>
    python(
      `from reportlab.pdfgen import canvas\np=${JSON.stringify(pdfPath)}\nc=canvas.Canvas(p)\nc.drawString(50,700,${JSON.stringify(text)})\nc.save()`,
    )
  await createPDF("First valid PDF")
  const pdf = await call("artifact.publish", { path: pdfPath, sessionID: session.id })
  await page.waitForFunction(
    () => document.querySelector(".bb-panel-content:not([style*='display: none']) .bb-paper canvas")?.width > 100,
  )
  await closeTab(pdf.filename)
  if (!resolve(pdf.source).startsWith(resolve(data) + sep)) throw new Error("Fixture cache outside the owned profile")
  await writeFile(pdf.source, "%PDF-1.7\nOwned damaged preview fixture\n%%EOF")
  await page.evaluate(
    (id) => window.dispatchEvent(new CustomEvent("bitsbytes:open-artifact", { detail: { id } })),
    pdf.id,
  )
  await page.locator(".bb-panel-content:visible .bb-preview .bb-error").waitFor()
  await createPDF("Recovered valid PDF")
  const recovered = await call("artifact.publish", { path: pdfPath, sessionID: session.id })
  assert.equal(recovered.revision, 2)
  await page.waitForFunction(
    () => document.querySelector(".bb-panel-content:not([style*='display: none']) .bb-paper canvas")?.width > 100,
  )
  await page.waitForTimeout(250)
  check(
    "A valid PDF revision clears the earlier loader error",
    (await page.locator(".bb-panel-content:visible .bb-preview .bb-error").count()) === 0,
    { errorBanners: await page.locator(".bb-panel-content:visible .bb-preview .bb-error").count() },
  )
  await writeFile(fault, JSON.stringify({ method: "browser.list", hold: true, round: 2 }))
  const browser = await call("browser.open", { sessionID: session.id, url: baseURL + "/original" })
  await capturedRound(2)
  await page.getByRole("tab", { name: browser.title, exact: true }).click()
  await call("browser.navigate", { id: browser.id, url: baseURL + "/current" })
  const address = page.locator(".bb-panel-content:visible .bb-browser-panel input")
  await address.waitFor()
  assert.equal(await address.inputValue(), baseURL + "/current")
  await writeFile(join(profile, "release-2.json"), "{}")
  await page.waitForTimeout(250)
  check(
    "Initial browser metadata cannot replace a newer navigation",
    (await address.inputValue()) === baseURL + "/current",
    { address: await address.inputValue() },
  )
  await call("browser.close", { id: browser.id })
  const errorCount = report.errors.length
  await writeFile(fault, JSON.stringify({ method: "browser.list", hold: true, rejectHeld: true, round: 3 }))
  const disposed = await call("browser.open", { sessionID: session.id, url: baseURL + "/original" })
  await capturedRound(3)
  await call("browser.close", { id: disposed.id })
  await writeFile(join(profile, "release-3.json"), "{}")
  await page.waitForTimeout(250)
  check("A closed browser panel contains a rejected initial read", report.errors.length === errorCount, {
    newPageErrors: report.errors.slice(errorCount),
  })
  if (!observe) assert.deepEqual(report.errors, [])
} catch (error) {
  report.failure = String(error)
  process.exitCode = 1
  console.error(error)
} finally {
  for (const round of [1, 2, 3]) await writeFile(join(profile, "release-" + round + ".json"), "{}")
  await writeFile(
    join(root, ".tools/qa/results", process.env.BB_PANEL_READ_REPORT || "panel-reads.json"),
    JSON.stringify(report, null, 2),
  )
  await app?.close().catch(() => undefined)
  fixture.closeAllConnections()
  await new Promise((resolve) => fixture.close(resolve))
}
