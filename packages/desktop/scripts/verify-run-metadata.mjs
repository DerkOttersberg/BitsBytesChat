import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const root = resolve("../.."),
  desktop = resolve(process.env.BB_QA_MAIN || process.cwd())
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/run-metadata-" + randomUUID()),
  data = join(profile, "BitsBytesChat")
const observe = process.env.BB_METADATA_OBSERVE === "1"
const report = { checks: [], errors: [], observations: [] }
await mkdir(join(data, "config/opencode"), { recursive: true })
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    model: "metadata-qa/fixture",
    provider: {
      "metadata-qa": {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "fixture-only" },
        models: { fixture: { name: "Metadata fixture", limit: { context: 128000, output: 8192 } } },
      },
    },
  }),
)
async function launch() {
  const app = await _electron.launch({
    executablePath: process.env.BB_QA_EXECUTABLE || join(desktop, "node_modules/electron/dist/electron.exe"),
    args: [desktop],
    env: { ...process.env, BB_QA_ISOLATED: "1", LOCALAPPDATA: profile },
    timeout: 90000,
  })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.hide()))
  const page = await app.firstWindow()
  page.on("pageerror", (error) => report.errors.push(error.message))
  await page.locator("[contenteditable=true]").first().waitFor({ timeout: 90000 })
  return { app, page }
}
let app
try {
  const initial = await launch()
  app = initial.app
  const server = await initial.page.evaluate(() => window.api.awaitInitialization()),
    directory = join(data, "workspace")
  const headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) }
  if (server.password)
    headers.authorization =
      "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")
  const sessions = []
  for (const title of ["Valid metadata", "Damaged Goal evidence", "Damaged Plan revision"]) {
    const response = await fetch(server.url + "/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(15000),
    })
    assert.ok(response.ok)
    sessions.push(await response.json())
  }
  // Both processes belong to this probe. The user's running application is untouched.
  await app.close()
  app = undefined
  const journal = Object.fromEntries(
    sessions.map((session, index) => {
      const text = "Exact queued source 🌿 " + index
      const prompt = { id: "msg_metadata_" + index, sessionID: session.id, directory, text }
      return [
        session.id,
        {
          sessionID: session.id,
          mode: "normal",
          goalDraft: false,
          paused: false,
          error: "",
          queue: [{ id: prompt.id, prompt, status: "pending", delivery: "queue" }],
          goal: {
            id: "goal_" + index,
            objective: "Retain this objective " + index,
            status: "paused",
            reason: "stopped",
            evidence: index === 1 ? { damaged: true } : "Verified saved evidence",
            started: 1,
            elapsed: 2,
            tokens: 3,
            continuations: 0,
          },
          plan: {
            id: "plan_" + index,
            revision: index === 2 ? "1" : 1,
            text: "Verified Plan " + index,
            versions: [{ revision: 1, text: "Verified Plan " + index }],
          },
        },
      ]
    }),
  )
  const source = JSON.stringify(journal)
  await writeFile(join(data, "chat-runs.json"), source)
  const loaded = await launch()
  app = loaded.app
  const page = loaded.page
  const call = (action, sessionID, args = {}) =>
    page.evaluate(
      ({ action, sessionID, args }) => window.api.bitsbytes.call("runs." + action, { sessionID, ...args }),
      { action, sessionID, args },
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
  const valid = await call("get", sessions[0].id),
    damagedGoal = await call("get", sessions[1].id),
    damagedPlan = await call("get", sessions[2].id)
  if (observe) {
    report.observations.push({
      goalEvidenceType: typeof damagedGoal.goal?.evidence,
      planRevision: damagedPlan.plan?.revision,
    })
    await call("plan", sessions[2].id, { text: "New Plan after recovery" })
    report.observations.push({ nextPlanRevision: (await call("get", sessions[2].id)).plan?.revision })
    const chat = await open(sessions[1])
    await chat.locator(".bb-goal-summary").click()
    await page.waitForTimeout(750)
    report.observations.push({
      panelPresent: await page.locator(".bb-run-panel-body").count(),
      panelText: await page
        .locator(".bb-run-panel-body")
        .innerText()
        .catch(() => ""),
      composerCount: await page.locator("[contenteditable=true]").count(),
      screenText: (await page.locator("body").innerText()).slice(0, 3000),
      errors: [...report.errors],
    })
    console.log("OBSERVATIONS", JSON.stringify(report.observations))
  } else {
    assert.deepEqual(valid.goal, journal[sessions[0].id].goal)
    assert.deepEqual(valid.plan, journal[sessions[0].id].plan)
    assert.equal(damagedGoal.goal, undefined)
    assert.deepEqual(damagedGoal.plan, journal[sessions[1].id].plan)
    assert.equal(damagedPlan.plan, undefined)
    assert.deepEqual(damagedPlan.goal, journal[sessions[2].id].goal)
    for (const [index, run] of [valid, damagedGoal, damagedPlan].entries()) {
      assert.equal(run.paused, true)
      assert.deepEqual(run.queue, journal[sessions[index].id].queue)
    }
    report.checks.push(
      "Damaged Goal evidence and Plan revision are isolated while exact queues and valid neighboring metadata survive",
    )
    const backup = (await readdir(data)).find((name) => name.startsWith("chat-runs-recovery-"))
    assert.ok(backup)
    assert.equal(await readFile(join(data, backup), "utf8"), source)
    report.checks.push("Complete original metadata and frozen requests remain in the recovery copy")
    const good = await open(sessions[0])
    await good.locator(".bb-goal-summary").click()
    await page.locator(".bb-run-panel").getByText("Verified saved evidence", { exact: true }).waitFor()
    await page.locator(".bb-run-panel").getByRole("button", { name: "Edit", exact: true }).click()
    await page
      .locator(".bb-run-panel")
      .getByRole("textbox", { name: "Goal", exact: true })
      .fill("Edited recovered objective")
    await page.locator(".bb-run-panel").getByRole("button", { name: "Save", exact: true }).click()
    assert.equal((await call("get", sessions[0].id)).goal.objective, "Edited recovered objective")
    report.checks.push("A valid recovered Goal displays its evidence and remains editable")
    const bad = await open(sessions[1])
    assert.equal(await bad.locator(".bb-goal-summary").count(), 0)
    await bad.getByRole("button", { name: "Open plan", exact: true }).click()
    await page.locator(".bb-run-panel").getByText("Verified Plan 1", { exact: true }).waitFor()
    await call("plan", sessions[2].id, { text: "New Plan after recovery" })
    assert.equal((await call("get", sessions[2].id)).plan.revision, 1)
    assert.deepEqual(report.errors, [])
    report.checks.push(
      "Damaged metadata does not block chat or its valid Plan, and a new Plan starts with a numeric revision",
    )
    for (const check of report.checks) console.log("PASS", check)
  }
} catch (error) {
  report.failure = String(error)
  console.error(error)
  process.exitCode = 1
} finally {
  await writeFile(
    join(root, ".tools/qa/results", (process.env.BB_METADATA_REPORT || "run-metadata") + ".json"),
    JSON.stringify(report, null, 2),
  )
  await app?.close()
}
