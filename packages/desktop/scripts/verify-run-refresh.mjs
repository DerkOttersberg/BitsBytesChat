import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const root = resolve("../.."),
  desktop = resolve(process.env.BB_QA_MAIN || process.cwd()),
  { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright"),
  profile = join(root, ".tools/qa/run-refresh-" + randomUUID()),
  data = join(profile, "BitsBytesChat"),
  fault = join(profile, "read-fault.json"),
  captured = join(profile, "captured.json"),
  observe = process.env.BB_RUN_REFRESH_OBSERVE === "1",
  report = { checks: [], errors: [], observations: [] }
await mkdir(join(data, "config/opencode"), { recursive: true })
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(fault, "{}")
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    model: "refresh-qa/fixture",
    provider: {
      "refresh-qa": {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "fixture-only" },
        models: { fixture: { name: "Refresh fixture", limit: { context: 128000, output: 8192 } } },
      },
    },
  }),
)
const shim = join(profile, "shim.mjs")
// Keep the actual IPC listener and its origin checks. Delay or reject only a
// read for the selected chat in this owned process, after its snapshot is made.
await writeFile(
  shim,
  `import { app, ipcMain } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
app.getAppPath = () => ${JSON.stringify(desktop)};
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
  const value = await listener(...args);
  if (channel !== "bitsbytes:call" || args[1] !== "runs.get") return value;
  const mode = JSON.parse(readFileSync(${JSON.stringify(fault)}, "utf8"));
  if (mode.sessionID !== args[2]?.sessionID) return value;
  if (mode.error) throw new Error("QA temporary run read failure");
  if (!mode.hold) return value;
  const snapshot = structuredClone(value);
  const previous = existsSync(${JSON.stringify(captured)}) ? JSON.parse(readFileSync(${JSON.stringify(captured)}, "utf8")) : {};
  writeFileSync(${JSON.stringify(captured)}, JSON.stringify({ round: mode.round, mode: snapshot.mode, count: previous.round === mode.round ? previous.count + 1 : 1 }));
  const release = join(${JSON.stringify(profile)}, "release-" + mode.round + ".json");
  for (let index = 0; index < 750 && !existsSync(release); index++) await new Promise(resolve => setTimeout(resolve, 20));
  if (!existsSync(release)) throw new Error("QA held read was not released");
  if (mode.rejectHeld) throw new Error("QA disposed run read failure");
  return snapshot;
});
await import(pathToFileURL(${JSON.stringify(join(desktop, "out/main/index.js"))}).href);
`,
)
let app
async function until(check, label) {
  for (let index = 0; index < 200; index++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Timed out: " + label)
}
function check(label, passed, detail) {
  report.observations.push({ label, passed, ...detail })
  if (passed) {
    report.checks.push(label)
    console.log("PASS", label)
  } else if (!observe) throw new Error(label + ": " + JSON.stringify(detail))
  else console.log("OBSERVED", label, JSON.stringify(detail))
}
try {
  app = await _electron.launch({
    executablePath: process.env.BB_QA_EXECUTABLE || join(desktop, "node_modules/electron/dist/electron.exe"),
    args: [shim],
    env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", LOCALAPPDATA: profile },
    timeout: 90000,
  })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.hide()))
  const page = await app.firstWindow()
  page.on("pageerror", (error) => report.errors.push(error.message))
  await page.locator("[contenteditable=true]").first().waitFor({ timeout: 90000 })
  const server = await page.evaluate(() => window.api.awaitInitialization()),
    directory = join(data, "workspace"),
    headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) }
  if (server.password)
    headers.authorization =
      "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")
  const sessions = []
  for (const title of ["Run refresh first", "Run refresh next"]) {
    const response = await fetch(server.url + "/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(15000),
    })
    assert.ok(response.ok)
    sessions.push(await response.json())
  }
  const call = (action, args = {}) =>
    page.evaluate(
      ({ action, args, sessionID }) => window.api.bitsbytes.call("runs." + action, { sessionID, ...args }),
      { action, args, sessionID: sessions[0].id },
    )
  const open = async (session) => {
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), {
      directory,
      sessionID: session.id,
    })
    const chat = page.locator(`.bb-workspace-chat[data-bb-chat="${session.id}"]`)
    await chat.locator("[contenteditable=true]").first().waitFor()
    return chat
  }
  const chat = await open(sessions[0]),
    plan = chat.locator(".bb-mode-chip").filter({ hasText: "Plan" }),
    alert = chat.locator(".bb-run-controls [role=alert]")
  await call("mode", { mode: "plan" })
  await plan.waitFor()
  await writeFile(fault, JSON.stringify({ sessionID: sessions[0].id, hold: true, round: 1 }))
  await call("goal-draft", { enabled: false })
  await until(
    async () => JSON.parse(await readFile(captured, "utf8").catch(() => "{}")).count >= 2,
    "held initial snapshot",
  )
  await writeFile(fault, "{}")
  await call("mode", { mode: "normal" })
  await plan.waitFor({ state: "hidden" })
  await writeFile(join(profile, "release-1.json"), "{}")
  await page.waitForTimeout(250)
  check("A late run snapshot cannot restore removed Plan controls", (await plan.count()) === 0, {
    planChips: await plan.count(),
  })
  const errorsBefore = report.errors.length
  await writeFile(fault, JSON.stringify({ sessionID: sessions[0].id, error: true }))
  await call("mode", { mode: "plan" })
  await page.waitForTimeout(250)
  check(
    "An event-triggered read failure is visible and contained",
    (await alert.innerText().catch(() => "")).includes("QA temporary run read failure") &&
      report.errors.length === errorsBefore,
    { alerts: await alert.count(), newPageErrors: report.errors.slice(errorsBefore) },
  )
  await writeFile(fault, "{}")
  await call("mode", { mode: "normal" })
  await page.waitForTimeout(250)
  check("A successful refresh clears its prior read error", (await alert.count()) === 0, {
    alerts: await alert.count(),
  })
  const disposalErrors = report.errors.length
  await writeFile(fault, JSON.stringify({ sessionID: sessions[0].id, hold: true, rejectHeld: true, round: 2 }))
  await call("goal-draft", { enabled: false })
  await until(async () => {
    const value = JSON.parse(await readFile(captured, "utf8"))
    return value.round === 2 && value.count >= 2
  }, "held disposal read")
  const next = await open(sessions[1])
  await page.evaluate(() => {
    const title = [...document.querySelectorAll("[data-titlebar-tab-title]")].find(
      (node) => node.textContent === "Run refresh first",
    )
    const close = title?.closest("[data-titlebar-tab]")?.querySelector("[data-slot=tab-close] button")
    if (!close) throw new Error("Owned QA chat close control missing")
    close.click()
  })
  await chat.waitFor({ state: "detached" })
  await writeFile(join(profile, "release-2.json"), "{}")
  await page.waitForTimeout(250)
  check(
    "A disposed read cannot surface an error in another chat",
    report.errors.length === disposalErrors && (await next.locator(".bb-run-controls [role=alert]").count()) === 0,
    { newPageErrors: report.errors.slice(disposalErrors) },
  )
  if (!observe) assert.deepEqual(report.errors, [])
} catch (error) {
  report.failure = String(error)
  process.exitCode = 1
  console.error(error)
} finally {
  await writeFile(join(profile, "release-1.json"), "{}")
  await writeFile(join(profile, "release-2.json"), "{}")
  await writeFile(
    join(root, ".tools/qa/results", process.env.BB_RUN_REFRESH_REPORT || "run-refresh.json"),
    JSON.stringify(report, null, 2),
  )
  await app?.close().catch(() => undefined)
}
