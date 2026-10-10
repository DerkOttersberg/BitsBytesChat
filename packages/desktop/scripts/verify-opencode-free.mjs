import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { join, resolve } from "node:path"

// Explicit live probe: fictional prompts, public free model, no user credentials or files.
if (process.env.BB_QA_LIVE_FREE !== "1") throw Error("Set BB_QA_LIVE_FREE=1 to enable the live free-provider check.")
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/opencode-free-" + randomUUID())
const data = join(profile, "BitsBytesChat"), directory = join(data, "workspace")
const results = join(root, ".tools/qa/results"), modelID = "big-pickle"
const report = { profile, modelID, checks: [], replies: [], errors: [], publicFreeModel: true, userCredentialsUsed: false }
await Promise.all([directory, join(data, "config/opencode"), results].map(path => mkdir(path, { recursive: true })))
await writeFile(join(data, "config/opencode/opencode.json"), JSON.stringify({ model: "opencode/" + modelID, small_model: "opencode/" + modelID }))
let app
try {
  app = await _electron.launch({
    executablePath: process.env.BB_QA_EXECUTABLE || join(root, "packages/desktop/node_modules/electron/dist/electron.exe"),
    args: process.env.BB_QA_MAIN ? [process.env.BB_QA_MAIN] : [],
    env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", LOCALAPPDATA: profile }, timeout: 90000,
  })
  const page = await app.firstWindow()
  page.on("pageerror", error => report.errors.push(error.message))
  await page.locator(".bb-org-sidebar").waitFor({ timeout: 90000 })
  const server = await page.evaluate(() => window.api.awaitInitialization())
  const call = (method, args) => page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
  const headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) }
  if (server.password) headers.authorization = "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")
  const api = async (path, method = "GET", body) => {
    const response = await fetch(server.url + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) throw Error(`HTTP ${response.status}: ${await response.text()}`)
    return response.status === 204 ? undefined : response.json()
  }
  const catalog = await api("/provider")
  const model = catalog.all.find(row => row.id === "opencode")?.models[modelID]
  assert.ok(model, "Live check requires an actually advertised model")
  assert.equal(model.cost.input, 0)
  assert.equal(model.cost.output, 0)
  const parent = await api("/session", "POST", { title: "Fictional free-provider QA", permission: [{ permission: "*", pattern: "*", action: "ask" }] })
  const ask = async (sessionID, text) => {
    const id = "msg_" + ((BigInt(Date.now()) * 4096n) & 0xffffffffffffn).toString(16).padStart(12, "0") + randomUUID().replaceAll("-", "").slice(0, 14)
    await call("runs.admit", { delivery: "queue", prompt: { id, sessionID, directory, protocol: "v1", text, agent: "build", model: { providerID: "opencode", modelID } } })
    for (let attempt = 0; attempt < 240; attempt++) {
      const rows = await api(`/session/${sessionID}/message`)
      const reply = rows.findLast(row => row.info.role === "assistant" && row.info.parentID === id)
      if (reply?.info.error) throw Error(JSON.stringify(reply.info.error))
      if (reply?.info.time.completed) return reply.parts.filter(part => part.type === "text").map(part => part.text).join("\n")
      await new Promise(done => setTimeout(done, 500))
    }
    throw Error("Free-provider request did not complete within two minutes")
  }
  report.replies.push(await ask(parent.id, "Remember our fictional spaceship is blue. Reply with exactly OK."))
  report.checks.push("Actual public free model completed a main-chat request")
  console.log("PASS", report.checks.at(-1))
  const child = await call("side.open", { parentID: parent.id, ownerID: parent.id, directory, protocol: "v1" })
  report.replies.push(await ask(child.id, "What colour was the fictional spaceship in the main chat? Reply with one word."))
  assert.match(report.replies.at(-1), /blue/i)
  report.checks.push("Actual public free model completed a side-chat request with inherited main context")
  console.log("PASS", report.checks.at(-1))
  await call("side.close", { sessionID: child.id, ownerID: parent.id })
  assert.deepEqual(report.errors, [])
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible() || window.isFocused())), false)
} catch (error) { report.failure = error.stack || String(error); throw error }
finally {
  await app?.close()
  await writeFile(join(results, (process.env.BB_QA_REPORT || "opencode-free-live") + ".json"), JSON.stringify(report, null, 2))
}
