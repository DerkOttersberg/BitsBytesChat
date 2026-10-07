import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"

const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/panel-recovery-" + randomUUID()),
  data = join(profile, "BitsBytesChat")
const observe = process.env.BB_PANEL_OBSERVE === "1"
const report = { checks: [], errors: [], observations: [] }
await mkdir(join(data, "config/opencode"), { recursive: true })
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
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
let app
try {
  app = await _electron.launch({
    executablePath:
      process.env.BB_QA_EXECUTABLE || join(root, "packages/desktop/node_modules/electron/dist/electron.exe"),
    args: [process.env.BB_QA_MAIN || process.cwd()],
    env: { ...process.env, LOCALAPPDATA: profile },
    timeout: 90000,
  })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.hide()))
  const page = await app.firstWindow()
  page.on("pageerror", (error) => report.errors.push(error.message))
  await page.locator("[contenteditable=true]").first().waitFor({ timeout: 90000 })
  const server = await page.evaluate(() => window.api.awaitInitialization())
  const directory = join(data, "workspace")
  const headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) }
  if (server.password)
    headers.authorization =
      "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")
  const cases = observe ? ["tabs-object"] : ["syntax", "tabs-object", "bad-neighbor", "bad-fields", "valid"]
  for (const kind of cases) {
    const response = await fetch(server.url + "/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "QA panel recovery " + kind }),
      signal: AbortSignal.timeout(15000),
    })
    assert.ok(response.ok)
    const session = await response.json()
    const key = `bitsbytes.panels.v2:${directory}:${session.id}`
    const valid = { id: "plan:" + session.id, kind: "plan", title: "Saved plan", owner: session.id }
    const source =
      kind === "syntax"
        ? "{"
        : JSON.stringify(
            kind === "tabs-object"
              ? { tabs: {} }
              : kind === "bad-neighbor"
                ? {
                    tabs: [valid, null, { id: "broken", kind: "unknown", title: "Bad tab", owner: session.id }],
                    active: valid.id,
                    open: true,
                  }
                : kind === "bad-fields"
                  ? {
                      tabs: [valid, { ...valid, id: "broken-fields", revision: "latest" }],
                      active: valid.id,
                      open: "yes",
                      width: "wide",
                    }
                  : { tabs: [valid], active: valid.id, open: true, width: 520 },
          )
    await page.evaluate(({ key, source }) => localStorage.setItem(key, source), { key, source })
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), {
      directory,
      sessionID: session.id,
    })
    const composer = page.locator(`.bb-workspace-chat[data-bb-chat="${session.id}"] [contenteditable=true]`).first()
    const available = await composer.waitFor({ timeout: 5000 }).then(
      () => true,
      () => false,
    )
    const recovery = await page.evaluate(
      (key) =>
        Object.keys(localStorage)
          .filter((candidate) => candidate.startsWith(key + ".recovery."))
          .map((candidate) => localStorage.getItem(candidate)),
      key,
    )
    report.observations.push({
      kind,
      composerAvailable: available,
      recoveryCopies: recovery.length,
      preservedOriginal: recovery.includes(source),
    })
    if (observe) {
      report.errorText = (await page.locator("body").innerText()).slice(0, 4096)
      continue
    }
    assert.equal(available, true, kind + " must retain the chat composer")
    await composer.fill("The chat remains editable after panel recovery.")
    if (["bad-neighbor", "bad-fields", "valid"].includes(kind)) {
      await page.getByRole("tab", { name: "Saved plan", exact: true }).waitFor({ timeout: 15000 })
      assert.equal(await page.getByRole("tab", { name: "Bad tab", exact: true }).count(), 0)
    }
    assert.equal(recovery.includes(source), kind !== "valid")
    report.checks.push(kind + " preserves the composer and valid saved tabs")
    console.log("PASS", report.checks.at(-1))
  }
  if (!observe) assert.deepEqual(report.errors, [])
} catch (error) {
  report.failure = String(error)
  console.error(error)
  process.exitCode = 1
} finally {
  await writeFile(
    join(root, ".tools/qa/results", process.env.BB_PANEL_REPORT || "panel-recovery.json"),
    JSON.stringify(report, null, 2),
  )
  await app?.close()
}
