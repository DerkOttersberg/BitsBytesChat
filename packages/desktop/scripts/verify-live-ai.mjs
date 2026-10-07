// Explicit opt-in: this exercises real account inference through the app UI.
import { createRequire } from "node:module"
import { mkdir, copyFile, readFile, writeFile, rename, symlink } from "node:fs/promises"
import { resolve, join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import assert from "node:assert/strict"

if (process.env.BB_LIVE_AI !== "1") throw Error("Set BB_LIVE_AI=1 only after authorizing real provider tests.")
const root = resolve("../.."), profile = join(root, ".tools/qa/live-ai-" + Date.now()), data = join(profile, "BitsBytesChat")
const source = process.env.BB_CREDENTIAL_SOURCE || "\\\\localhost\\C$\\Users\\derko\\AppData\\Local\\BitsBytesChat"
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const hash = (value) => createHash("sha256").update(value).digest("hex")
const original = await readFile(join(source, "credentials.bin"))
let originalHash = hash(original)
await mkdir(join(data, "desktop"), { recursive: true })
await mkdir(join(data, "config/opencode"), { recursive: true })
await copyFile(join(source, "desktop/Local State"), join(data, "desktop/Local State"))
await writeFile(join(data, "credentials.bin"), original)
await copyFile(join(source, "model-catalog.json"), join(data, "model-catalog.json"))
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
const model = process.env.BB_LIVE_MODEL || "gpt-5.6-luna"
await writeFile(join(data, "config/opencode/opencode.json"), JSON.stringify({
  model: "bitsbytes-chatgpt/" + model, small_model: "bitsbytes-chatgpt/" + model,
  agent: { build: { steps: 8 }, plan: { steps: 6 } },
}))
const report = { checks: [], errors: [], model, profile, conversations: [], refreshedCredentials: false }
const check = (name) => { report.checks.push(name); console.log("PASS", name) }
const app = await _electron.launch({
  executablePath: process.env.BB_LIVE_EXECUTABLE || join(root, "packages/desktop/node_modules/electron/dist/electron.exe"),
  ...(process.env.BB_LIVE_EXECUTABLE ? {} : { args: [join(root, "packages/desktop")] }),
  env: { ...process.env, LOCALAPPDATA: profile }, timeout: 90000,
})
let page, call, engine
// Refresh tokens can rotate. Preserve updates only if the user's encrypted store has
// not independently changed; never copy session data, settings or plaintext tokens.
async function preserveRefresh() {
  const current = await readFile(join(source, "credentials.bin")), updated = await readFile(join(data, "credentials.bin"))
  if (hash(updated) === originalHash) return
  if (hash(current) !== originalHash) { report.credentialConflict = true; return }
  const changed = await app.evaluate(({ safeStorage }, { original, updated }) => {
    const before = JSON.parse(safeStorage.decryptString(Buffer.from(original, "base64")))
    const after = JSON.parse(safeStorage.decryptString(Buffer.from(updated, "base64")))
    return before.access !== after.access || before.refresh !== after.refresh || before.expires !== after.expires
  }, { original: current.toString("base64"), updated: updated.toString("base64") })
  if (!changed) return
  const temp = join(source, "credentials-qa-" + randomUUID() + ".tmp")
  await writeFile(temp, updated); await rename(temp, join(source, "credentials.bin"))
  originalHash = hash(updated); report.refreshedCredentials = true
}
try {
  page = await app.firstWindow(); page.setDefaultTimeout(60000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => { window.webContents.setBackgroundThrottling(false); window.hide() }))
  page.on("pageerror", (error) => report.errors.push(error.message))
  await page.locator(".bb-nav").waitFor({ timeout: 90000 })
  call = (method, args = {}) => page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
  const state = await call("state")
  assert.ok(state.account, "ChatGPT plan sign-in is unavailable")
  const catalog = await call("models.list", { force: true })
  report.catalog = catalog.map((row) => ({ id: row.id, efforts: row.efforts }))
  assert.ok(catalog.some((row) => row.id === model), "The cheaper test model is absent from the live account catalog")
  await preserveRefresh()
  const server = await page.evaluate(() => window.api.awaitInitialization())
  const headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(join(data, "workspace")),
    ...(server.password ? { authorization: "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64") } : {}),
  }
  engine = async (path, method = "GET", input) => {
    const response = await fetch(server.url + path, { method, headers, ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(60000) })
    assert.ok(response.ok, path + " " + response.status)
    return response.status === 204 ? null : response.json()
  }
  const session = await engine("/session", "POST", { title: "Live QA — cheaper GPT" })
  report.main = session.id
  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), { directory: join(data, "workspace"), sessionID: session.id })
  const main = page.locator(`.bb-workspace-chat[data-bb-chat="${session.id}"]`), editor = main.locator("[contenteditable=true]").first()
  await editor.waitFor()
  const trigger = main.locator('[data-action="prompt-model"]').first()
  await trigger.click()
  await page.locator(`[data-option-key="bitsbytes-chatgpt:${model}"]`).click()
  await main.locator('.bb-chat-access').click(); await page.getByRole('menuitemradio', { name: 'Full access', exact: true }).click()
  const completed = async (id, count) => {
    for (let i = 0; i < 180; i++) {
      const messages = await engine(`/session/${id}/message`), assistants = messages.filter((row) => row.info.role === "assistant")
      const error = assistants.findLast((row) => row.info.error)?.info.error
      if (error) throw Error(JSON.stringify(error))
      if (assistants.length >= count && assistants.at(-1)?.info.time?.completed) return messages
      await page.waitForTimeout(1000)
    }
    throw Error("Live conversation did not finish within three minutes")
  }
  const send = async (text) => { await editor.fill(text); await main.locator('[data-action="prompt-submit"]').click() }
  await send("Remember the codeword STROOM-42 in this conversation. Reply with only that codeword. Do not use tools.")
  let messages = await completed(session.id, 1)
  assert.ok(messages.some((row) => row.info.role === "assistant" && row.parts.some((part) => part.text?.includes("STROOM-42"))))
  assert.ok(messages.filter((row) => row.info.role === "assistant").every((row) => row.info.modelID === model))
  check("Actual composer streams a successful ChatGPT plan response using the cheaper GPT model")
  await send("What is the codeword I gave earlier? Reply with only the codeword. Do not use tools.")
  messages = await completed(session.id, 2)
  assert.ok(messages.filter((row) => row.info.role === "assistant").at(-1).parts.some((part) => part.text?.includes("STROOM-42")))
  check("A second live UI turn retains conversation context and model selection")
  await editor.fill("/side")
  await page.locator("[data-suggestion-id]").filter({ hasText: "Side chat" }).first().click()
  await page.getByRole("tab", { name: "Side chat", exact: true }).waitFor()
  const side = page.locator(".bb-panel-content:visible"), sideEditor = side.locator("[contenteditable=true]").first()
  await sideEditor.waitFor()
  assert.equal((await side.innerText()).includes("STROOM-42"), false)
  const before = await engine("/session")
  // Upstream's fork copies history into a new root session; parentID is reserved
  // for agent child sessions and is not guaranteed on a conversation fork.
  const fork = before.find((row) => row.id !== session.id)
  assert.ok(fork)
  report.side = fork.id
  await sideEditor.fill("What codeword was supplied in the inherited conversation? Reply with only the codeword; do not use tools.")
  await side.locator('[data-action="prompt-submit"]').click()
  const sideMessages = await completed(fork.id, 3)
  assert.ok(sideMessages.filter((row) => row.info.role === "assistant").at(-1).parts.some((part) => part.text?.includes("STROOM-42")))
  check("An empty-looking /side chat uses inherited context in an independent live request")
  await send("Create qa-live.txt in this test workspace containing exactly STROOM-42. Use the local file tools, then read the file and report the content in one short sentence. Stay inside this workspace.")
  messages = await completed(session.id, 3)
  // Tool turns can add multiple assistant records; wait for the run to become idle.
  for (let i = 0; i < 120; i++) {
    const run = await call("runs.get", { sessionID: session.id })
    if (!run.awaiting && !run.queue.length) break
    await page.waitForTimeout(1000)
  }
  assert.equal((await readFile(join(data, "workspace/qa-live.txt"), "utf8")).trim(), "STROOM-42")
  messages = await engine(`/session/${session.id}/message`)
  assert.ok(messages.some((row) => row.parts.some((part) => part.type === "tool")))
  check("A real GPT conversation executes local tools and verifies a saved file through the app engine")
  if (process.env.BB_LIVE_EXTENDED === "1") {
    const idle = async () => {
      for (let i = 0; i < 180; i++) {
        const run = await call("runs.get", { sessionID: session.id })
        const statuses = await engine("/session/status")
        if (!run.awaiting && !run.queue.length && (!statuses[session.id] || statuses[session.id].type === "idle")) return
        await page.waitForTimeout(1000)
      }
      throw Error("Extended live request did not become idle")
    }
    await main.getByRole("button", { name: "Collapse panel", exact: true }).click()
    await editor.fill("/bb-documents")
    await page.locator("[data-suggestion-id]").filter({ hasText: "documents" }).first().click()
    await send("Create a one-page Word document named Live QA.docx using the selected document skill. Title: Live QA. Include a paragraph with exactly STROOM-42 and a small table with two columns Name and Value, and one data row Test and 42. Use the local artifact tools so it is published and previewed. Inspect the saved content. Keep the final reply to one sentence. This is synthetic QA data; no questions are necessary.")
    await idle()
    let artifact = (await call("artifacts.list")).find((row) => row.sessionID === session.id && row.filename === "Live QA.docx")
    assert.ok(artifact, "The real model did not publish the requested Word document")
    for (let i = 0; i < 120 && artifact.status !== "ready"; i++) {
      if (artifact.status === "error") throw Error(artifact.error)
      await page.waitForTimeout(500)
      artifact = (await call("artifacts.list")).find((row) => row.id === artifact.id)
    }
    assert.equal(artifact.status, "ready")
    assert.ok((await readFile(artifact.pdf)).subarray(0, 5).equals(Buffer.from("%PDF-")))
    await main.locator('[data-component="artifact-cards"] button').filter({ hasText: "Live QA.docx" }).last().waitFor()
    assert.equal(await page.locator(".bb-workspace-panel").isVisible(), true)
    await page.waitForFunction(() => document.querySelector('.bb-panel-content:not([style*="display: none"]) .bb-paper canvas')?.width > 100)
    check("A live GPT document-skill conversation creates a verified Word file, clickable card and automatic PDF preview")
    await send("Revise the same Live QA.docx: append a paragraph containing exactly VERIFIED REVISION. Preserve the title, codeword and table. Publish the same file path so this becomes a new revision of the existing document. Inspect it afterward and reply in one sentence.")
    await idle()
    const revised = (await call("artifacts.list")).find((row) => row.id === artifact.id)
    assert.equal(revised.revision, 2)
    assert.equal(revised.history.length, 2)
    assert.equal((await call("artifacts.list")).filter((row) => row.sessionID === session.id && row.filename === "Live QA.docx").length, 1)
    report.document = { id: revised.id, revision: revised.revision, path: revised.path }
    check("A real chat correction retains document identity and immutable revision history")
    await editor.fill("/plan")
    await page.locator("[data-suggestion-id]").filter({ hasText: "Plan" }).first().click()
    await send("Plan creating a small text file named planned.txt containing PLANNED, inside this test workspace. Inspect existing files if useful, do not execute any changes yet, and finish with a concise proposed plan. Do not ask questions.")
    await idle()
    const run = await call("runs.get", { sessionID: session.id })
    assert.ok(run.plan?.text.includes("planned.txt"))
    assert.equal(await readFile(join(data, "workspace/planned.txt")).catch(() => null), null)
    await main.locator('[data-component="proposed-plan"]').waitFor()
    check("A live Plan request produces the plan widget while leaving the proposed output uncreated")
  }
  report.conversations = (await Promise.all([session.id, fork.id].map(async (id) => ({ id, messages: (await engine(`/session/${id}/message`)).map((row) => ({ role: row.info.role, model: row.info.modelID, tokens: row.info.tokens, tools: row.parts.filter((part) => part.type === "tool").map((part) => ({ name: part.tool, status: part.state?.status })) })) }))))
  await page.screenshot({ path: join(root, ".tools/qa/results/live-ai-033.png") })
  assert.deepEqual(report.errors, [])
} catch (error) { report.errors.push(error.stack); throw error }
finally {
  await preserveRefresh().catch((error) => { report.credentialUpdateError = error.message })
  await mkdir(join(root, ".tools/qa/results"), { recursive: true })
  await writeFile(join(root, ".tools/qa/results/live-ai-033.json"), JSON.stringify(report, null, 2))
  await app.close()
}
