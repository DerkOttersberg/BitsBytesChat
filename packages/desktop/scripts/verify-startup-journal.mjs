import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { mkdir, readFile, rmdir, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/startup-journal-" + randomUUID())
const data = join(profile, "BitsBytesChat")
const desktop = resolve(process.env.BB_QA_MAIN || process.cwd())
const observe = process.env.BB_STARTUP_OBSERVE === "1"
const report = { checks: [], errors: [], observe }
const sessionID = "ses_saved_startup_qa"
const prompt = {
  id: "msg_saved_startup_qa",
  sessionID,
  directory: join(data, "workspace"),
  text: "Complete saved source 🌿\n".repeat(6500),
  prepared: true,
  mode: "plan",
  draft: { transcript: "bitsbytes://transcript/saved?revision=7" },
}
const source = JSON.stringify({
  [sessionID]: {
    sessionID,
    mode: "plan",
    goalDraft: false,
    paused: false,
    awaiting: true,
    error: "",
    queue: [{ id: prompt.id, prompt, status: "sending", sentAt: 42, delivery: "queue" }],
    goal: {
      id: "goal_saved",
      objective: "Retain the saved objective",
      status: "active",
      reason: "",
      evidence: "",
      started: Date.now(),
      elapsed: 0,
      tokens: 0,
      continuations: 0,
    },
    plan: {
      id: "plan_saved",
      revision: 1,
      text: "Retain the saved plan",
      versions: [{ revision: 1, text: "Retain the saved plan" }],
    },
  },
})
await mkdir(join(data, "config/opencode"), { recursive: true })
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    model: "startup-qa/fixture",
    provider: {
      "startup-qa": {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "fixture-only" },
        models: { fixture: { name: "Startup fixture", limit: { context: 128000, output: 8192 } } },
      },
    },
  }),
)
await writeFile(join(data, "chat-runs.json"), source)
const temporary = join(data, "chat-runs.json.tmp")
await mkdir(temporary)
const diagnostic = join(profile, "startup-error.json")
const shim = join(profile, "startup-shim.mjs")
// Intercept native fatal dialogs and protocol registration only in this owned
// diagnostic process. The application entrypoint itself is the production build.
await writeFile(
  shim,
  `import { app, dialog } from "electron";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
app.getAppPath = () => ${JSON.stringify(desktop)};
app.setAsDefaultProtocolClient = () => true;
dialog.showErrorBox = (title, message) => writeFileSync(${JSON.stringify(diagnostic)}, JSON.stringify({ title, message }));
await import(pathToFileURL(${JSON.stringify(join(desktop, "out/main/index.js"))}).href);
`,
)
let app
try {
  app = await _electron.launch({
    executablePath:
      process.env.BB_QA_EXECUTABLE || join(root, "packages/desktop/node_modules/electron/dist/electron.exe"),
    args: [shim],
    env: { ...process.env, BB_QA_ISOLATED: "1", LOCALAPPDATA: profile },
    timeout: 30000,
  })
  const page = await app.firstWindow({ timeout: 30000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.hide()))
  page.on("pageerror", (error) => report.errors.push(error.message))
  await page.locator("[contenteditable=true]").first().waitFor({ timeout: 90000 })
  const chat = await page.evaluate((sessionID) => window.api.bitsbytes.call("runs.get", { sessionID }), sessionID)
  assert.equal(chat.paused, true)
  assert.equal(chat.awaiting, false)
  assert.ok(chat.error.includes("chat-runs.json.tmp"))
  assert.equal(chat.queue[0].status, "uncertain")
  assert.equal(chat.queue[0].sentAt, 42)
  assert.deepEqual(chat.queue[0].prompt, prompt)
  assert.equal(chat.goal.status, "paused")
  assert.equal(chat.goal.objective, "Retain the saved objective")
  assert.equal(chat.plan.text, "Retain the saved plan")
  assert.equal(await readFile(join(data, "chat-runs.json"), "utf8"), source)
  report.checks.push(
    "Blocked startup journal write leaves the composer usable and preserves the complete original journal, queue, Goal and Plan",
  )
  const rejected = await page.evaluate(async (prompt) => {
    try {
      await window.api.bitsbytes.call("runs.admit", { prompt })
      return false
    } catch {
      return true
    }
  }, prompt)
  assert.equal(rejected, true)
  assert.equal(await readFile(join(data, "chat-runs.json"), "utf8"), source)
  report.checks.push("An unsaved duplicate admission is rejected without replacing the original bytes")
  await rmdir(temporary)
  await page.evaluate((sessionID) => window.api.bitsbytes.call("runs.stop", { sessionID }), sessionID)
  const recovered = JSON.parse(await readFile(join(data, "chat-runs.json"), "utf8"))[sessionID]
  assert.equal(recovered.paused, true)
  assert.equal(recovered.awaiting, false)
  assert.deepEqual(recovered.queue[0].prompt, prompt)
  assert.equal(recovered.queue[0].sentAt, 42)
  assert.equal(recovered.goal.status, "paused")
  assert.deepEqual(report.errors, [])
  report.checks.push("After storage repair, an explicit Stop saves the retained request without dispatching it")
  for (const check of report.checks) console.log("PASS", check)
} catch (error) {
  report.failure = String(error)
  const fatal = await readFile(diagnostic, "utf8")
    .then(JSON.parse)
    .catch(() => undefined)
  if (fatal) report.fatal = fatal
  if (!observe) process.exitCode = 1
  console.log(observe ? "OBSERVED" : "FAIL", report.failure, fatal?.message || "")
} finally {
  await writeFile(
    join(root, ".tools/qa/results", (process.env.BB_STARTUP_REPORT || "startup-journal") + ".json"),
    JSON.stringify(report, null, 2),
  )
  await app?.close().catch(() => undefined)
}
