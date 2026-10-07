import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const root = resolve("../.."),
  desktop = resolve(process.env.BB_QA_MAIN || process.cwd())
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/plan-revisions-" + randomUUID()),
  data = join(profile, "BitsBytesChat")
const observe = process.env.BB_PLAN_OBSERVE === "1"
const readMethod = process.env.BB_PLAN_READ_METHOD || "runs.panel"
const report = { checks: [], errors: [], observations: [] }
const fault = join(profile, "read-fault.json"),
  captured = join(profile, "captured.json"),
  release = join(profile, "release.json")
await mkdir(join(data, "config/opencode"), { recursive: true })
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(fault, "{}")
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    model: "plan-qa/fixture",
    provider: {
      "plan-qa": {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "fixture-only" },
        models: { fixture: { name: "Plan fixture", limit: { context: 128000, output: 8192 } } },
      },
    },
  }),
)
const shim = join(profile, "shim.mjs")
// Preserve the production IPC listener and origin checks. The owned adapter
// supplies only a rejected read or a held snapshot for one selected QA chat.
await writeFile(
  shim,
  `import { app, ipcMain } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
app.getAppPath = () => ${JSON.stringify(desktop)};
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
  const value = await listener(...args);
  if (channel !== "bitsbytes:call" || args[1] !== ${JSON.stringify(readMethod)}) return value;
  const mode = JSON.parse(readFileSync(${JSON.stringify(fault)}, "utf8"));
  if (mode.sessionID !== args[2]?.sessionID) return value;
  if (mode.error) throw new Error("QA temporary run read failure");
  if (!mode.hold) return value;
  const snapshot = structuredClone(value);
  writeFileSync(${JSON.stringify(fault)}, "{}");
  writeFileSync(${JSON.stringify(captured)}, JSON.stringify({ revision: snapshot.plan?.revision }));
  for (let index = 0; index < 750 && !existsSync(${JSON.stringify(release)}); index++) await new Promise(resolve => setTimeout(resolve, 20));
  if (!existsSync(${JSON.stringify(release)})) throw new Error("QA held read was not released");
  return snapshot;
});
await import(pathToFileURL(${JSON.stringify(join(desktop, "out/main/index.js"))}).href);
`,
)
let app
try {
  app = await _electron.launch({
    executablePath: process.env.BB_QA_EXECUTABLE || join(desktop, "node_modules/electron/dist/electron.exe"),
    args: [shim],
    env: { ...process.env, BB_QA_ISOLATED: "1", LOCALAPPDATA: profile },
    timeout: 90000,
  })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.hide()))
  const page = await app.firstWindow()
  page.on("pageerror", (error) => report.errors.push(error.message))
  await page.locator("[contenteditable=true]").first().waitFor({ timeout: 90000 })
  const server = await page.evaluate(() => window.api.awaitInitialization()),
    directory = join(data, "workspace")
  const headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) }
  if (server.password)
    headers.authorization =
      "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")
  const response = await fetch(server.url + "/session", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "QA Plan history" }),
    signal: AbortSignal.timeout(15000),
  })
  assert.ok(response.ok)
  const session = await response.json()
  const call = (action, args = {}) =>
    page.evaluate(
      ({ action, args, sessionID }) => window.api.bitsbytes.call("runs." + action, { sessionID, ...args }),
      { action, args, sessionID: session.id },
    )
  await call("plan", { text: "First saved plan" })
  await call("plan", { text: "Second saved plan" })
  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), {
    directory,
    sessionID: session.id,
  })
  const chat = page.locator(`.bb-workspace-chat[data-bb-chat="${session.id}"]`)
  await chat.locator("[contenteditable=true]").first().waitFor()
  await chat.getByRole("button", { name: "Open plan", exact: true }).click()
  const panel = page.locator(".bb-run-panel"),
    versions = panel.getByRole("combobox", { name: "Version history", exact: true })
  await versions.waitFor()
  await versions.selectOption("1")
  await panel.getByText("First saved plan", { exact: true }).waitFor()
  await call("mode", { mode: "normal" })
  await page.waitForTimeout(300)
  report.observations.push({
    case: "history-after-run-update",
    revision: await versions.inputValue(),
    text: await panel.locator(".bb-run-panel-body").innerText(),
  })
  if (observe) console.log("OBSERVATION", JSON.stringify(report.observations.at(-1)))
  else {
    assert.equal(await versions.inputValue(), "1")
    await panel.getByText("First saved plan", { exact: true }).waitFor()
    report.checks.push("Background run updates retain the selected historical Plan revision")
    await panel.getByRole("button", { name: "Edit", exact: true }).click()
    await panel.getByRole("textbox", { name: "Plan", exact: true }).fill("Unsaved historical edit")
    await panel.getByRole("button", { name: "Revert", exact: true }).click()
    await panel.getByText("First saved plan", { exact: true }).waitFor()
    assert.equal(await versions.inputValue(), "1")
    report.checks.push("Revert restores the selected historical source without switching to the latest Plan")
    await panel.getByRole("button", { name: "Edit", exact: true }).click()
    await panel.getByRole("textbox", { name: "Plan", exact: true }).fill("Reviewed historical plan edit")
    await panel.getByRole("button", { name: "Save", exact: true }).click()
    await panel.getByText("Reviewed historical plan edit", { exact: true }).waitFor()
    assert.equal(await versions.inputValue(), "3")
    const saved = await call("get")
    assert.deepEqual(
      saved.plan.versions.map((version) => version.text),
      ["First saved plan", "Second saved plan", "Reviewed historical plan edit"],
    )
    report.checks.push("Saving an edited historical Plan creates and selects a new immutable revision")
    await writeFile(fault, JSON.stringify({ sessionID: session.id, error: true }))
    await panel.getByRole("button", { name: "Edit", exact: true }).click()
    await panel.getByRole("button", { name: "Revert", exact: true }).click()
    await panel.getByRole("alert").waitFor()
    await panel.getByText("Reviewed historical plan edit", { exact: true }).waitFor()
    await writeFile(fault, "{}")
    await panel.getByRole("button", { name: "Edit", exact: true }).click()
    await panel.getByRole("button", { name: "Revert", exact: true }).click()
    await panel.getByRole("alert").waitFor({ state: "hidden" })
    report.checks.push(
      "A rejected panel read preserves the source, shows recovery and clears its error after a successful read",
    )
    await writeFile(fault, JSON.stringify({ sessionID: session.id, hold: true }))
    await panel.getByRole("button", { name: "Edit", exact: true }).click()
    await panel.getByRole("button", { name: "Revert", exact: true }).click()
    for (let index = 0; index < 100; index++) {
      if (await readFile(captured, "utf8").catch(() => "")) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(JSON.parse(await readFile(captured, "utf8")).revision, 3)
    await call("plan", { text: "Latest plan after the held read" })
    await panel.getByText("Latest plan after the held read", { exact: true }).waitFor()
    await writeFile(release, "{}")
    await page.waitForTimeout(300)
    assert.equal(await versions.inputValue(), "4")
    await panel.getByText("Latest plan after the held read", { exact: true }).waitFor()
    report.checks.push("A released older IPC snapshot cannot replace a newer Plan read")
    await call("stop")
    const source = "Frozen projection source 🌿 ".repeat(6000)
    const prompt = {
      sessionID: session.id,
      directory,
      id: "msg_panel_projection",
      text: source,
      legacyParts: [{ type: "text", text: source }],
      draft: { attachments: [{ source }] },
      model: { providerID: "plan-qa", modelID: "fixture" },
    }
    await call("admit", { prompt })
    await call("prepare", { prompt })
    const journal = await readFile(join(data, "chat-runs.json"), "utf8")
    report.projection = await page.evaluate(
      async ({ sessionID, source }) => {
        const samples = { get: [], panel: [] },
          bytes = {},
          encoder = new TextEncoder()
        for (let index = -1; index < 20; index++) {
          for (const action of index % 2 === 0 ? ["get", "panel"] : ["panel", "get"]) {
            const started = performance.now()
            const value = await window.api.bitsbytes.call("runs." + action, { sessionID })
            const elapsed = performance.now() - started
            if (index >= 0) samples[action].push(elapsed)
            bytes[action] = encoder.encode(JSON.stringify(value)).length
            if (action === "get" && (value.queue[0]?.prompt.text !== source || value.last?.text !== source))
              throw new Error("Full recovery read lost its frozen source")
            if (
              action === "panel" &&
              (Object.keys(value).some((key) => key !== "goal" && key !== "plan") ||
                value.plan?.revision !== 4 ||
                value.plan?.versions.length !== 4)
            )
              throw new Error("Panel projection lost revisions or included queue data")
          }
        }
        return { samples, bytes }
      },
      { sessionID: session.id, source },
    )
    assert.ok(report.projection.bytes.get > 1000000)
    assert.ok(report.projection.bytes.panel < 1000)
    assert.equal(await readFile(join(data, "chat-runs.json"), "utf8"), journal)
    report.checks.push(
      "Compact native panel reads retain all revisions and full recovery sources without journal writes",
    )
    assert.deepEqual(report.errors, [])
    for (const check of report.checks) console.log("PASS", check)
  }
} catch (error) {
  report.failure = String(error)
  console.error(error)
  process.exitCode = 1
} finally {
  await writeFile(release, "{}")
  await writeFile(
    join(root, ".tools/qa/results", (process.env.BB_PLAN_REPORT || "plan-revisions") + ".json"),
    JSON.stringify(report, null, 2),
  )
  await app?.close()
}
