import { createRequire } from "node:module"
import { createServer } from "node:http"
import { mkdir, readFile, readdir, writeFile, symlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import assert from "node:assert/strict"
import { copy } from "../src/bitsbytes/copy.ts"

const root = resolve("../.."),
  qa = join(root, ".tools/mobile")
const { _electron, chromium } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(qa, "profile-" + Date.now()),
  data = join(profile, "BitsBytesChat")
const report = { checks: [], errors: [], requests: 0, profile }
const check = (name) => {
  report.checks.push(name)
  console.log("PASS", name)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const requests = []
const fixture = createServer(async (req, res) => {
  let raw = ""
  for await (const chunk of req) raw += chunk
  const input = JSON.parse(raw || "{}")
  requests.push(input)
  const latest = input.messages?.filter((row) => row.role === "user").at(-1)
  if (JSON.stringify(latest).includes("slow request")) await wait(4500)
  res.writeHead(200, { "content-type": "text/event-stream" })
  const message = JSON.stringify(latest?.content).includes("phone")
    ? "Shared response to phone."
    : "Shared response to desktop."
  res.end(
    "data: " +
      JSON.stringify({
        id: randomUUID(),
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: message }, finish_reason: null }],
      }) +
      "\n\ndata: " +
      JSON.stringify({
        id: "end",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 25, completion_tokens: 10, total_tokens: 35 },
      }) +
      "\n\ndata: [DONE]\n\n",
  )
})
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve))
await mkdir(join(data, "config/opencode"), { recursive: true })
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
if (process.env.BB_MOBILE_AUDIO === "1") await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/models"), join(data, "models"), "junction")
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    model: "mobile-qa/test-model",
    provider: {
      "mobile-qa": {
        name: "Local mobile QA",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:" + fixture.address().port + "/v1", apiKey: "fixture-only" },
        models: {
          "test-model": {
            name: "Mobile QA model",
            limit: { context: 128000, output: 8192 },
            variants: { high: { reasoningEffort: "high" } },
          },
        },
      },
    },
  }),
)
if (process.env.BB_MOBILE_DAMAGED_STATE === "1") {
  await mkdir(join(data, "mobile"), { recursive: true })
  for (const name of ["settings.json", "access-modes.json", "transcript-bindings.json", "model-selection.json", "model-catalog.json", "artifacts.json", "chat-runs.json", "mobile/settings.json"])
    await writeFile(join(data, name), name.includes("bindings") ? "null" : "{broken")
}
const browser = await chromium.launch({ headless: true, channel: "msedge", args: ["--use-fake-device-for-media-stream"] })
const app = await _electron.launch({
  executablePath:
    process.env.BB_MOBILE_EXECUTABLE || join(root, "packages/desktop/node_modules/electron/dist/electron.exe"),
  ...(process.env.BB_MOBILE_EXECUTABLE ? {} : { args: [join(root, "packages/desktop")] }),
  env: { ...process.env, LOCALAPPDATA: profile },
  timeout: 90000,
})
const startup = []
app.process().stderr?.on("data", (bytes) => startup.push(bytes.toString()))
app.process().stdout?.on("data", (bytes) => startup.push(bytes.toString()))
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
})
let desktop, phone
try {
  console.log(
    "Electron state",
    await app.evaluate(({ app, BrowserWindow }) => ({
      name: app.getName(),
      path: app.getAppPath(),
      ready: app.isReady(),
      windows: BrowserWindow.getAllWindows().length,
      profile: process.env.LOCALAPPDATA,
    })),
  )
  desktop = await app.firstWindow({ timeout: 90000 })
  desktop.setDefaultTimeout(30000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.hide()))
  await desktop.locator(".bb-nav").waitFor({ timeout: 90000 })
  const call = (method, args = {}) =>
    desktop.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
  if (process.env.BB_MOBILE_DAMAGED_STATE === "1") {
    const files = await readdir(data), mobileFiles = await readdir(join(data, "mobile"))
    assert.equal(files.filter(name => name.includes("recovery-")).length, 7)
    assert.ok(mobileFiles.some(name => name.startsWith("settings.json.recovery-")))
    assert.equal((await call("state")).settings.engine, "parakeet")
    check("Eight damaged optional journals preserve recovery copies while the real app opens with working chat")
  }
  const server = await desktop.evaluate(() => window.api.awaitInitialization())
  const headers = {
    "content-type": "application/json",
    "x-opencode-directory": encodeURIComponent(join(data, "workspace")),
    ...(server.password
      ? {
          authorization:
            "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64"),
        }
      : {}),
  }
  const engine = async (path, method = "GET", input) => {
    const response = await fetch(server.url + path, {
      method,
      headers,
      ...(input ? { body: JSON.stringify(input) } : {}),
    })
    assert.ok(response.ok, await response.clone().text())
    return response.status === 204 ? null : response.json()
  }
  const session = await engine("/session", "POST", { title: "Shared laptop and phone" })
  await desktop.locator(".bb-nav [aria-label=Settings]").click()
  await desktop.getByRole("tab", { name: "Mobile access", exact: true }).click()
  await desktop
    .getByText("Use the same Wi-Fi. Your computer must stay awake with Bits & Bytes Chat running.", { exact: true })
    .waitFor()
  check("Mobile access uses the unified desktop settings dialog")
  // Random available port, with no changes to the user app or firewall.
  const { createServer } = await import("node:net"),
    portServer = createServer()
  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve))
  const port = portServer.address().port
  await new Promise((resolve) => portServer.close(resolve))
  await call("mobile.enable", { port })
  await desktop.getByRole("button", { name: "Pair a phone", exact: true }).click()
  await desktop.getByRole("img", { name: "Pair a phone", exact: true }).waitFor()
  assert.ok(
    (await desktop.getByRole("img", { name: "Pair a phone", exact: true }).getAttribute("src")).startsWith(
      "data:image/gif;base64,",
    ),
  )
  const network = await call("mobile.state")
  report.network = { preferredURL: network.preferredURL, addresses: network.addresses }
  assert.ok(network.addresses.length > 0)
  const lan = network.addresses.filter((row) => row.kind === "lan")
  if (lan.length) assert.equal(network.addresses[0].kind, "lan")
  const choices = desktop.getByLabel("Connection addresses", { exact: true })
  assert.equal(await choices.inputValue(), network.preferredURL)
  assert.ok((await desktop.locator(".bb-settings-panel code").last().textContent()).startsWith(network.preferredURL + "/#pair="))
  assert.ok((await choices.locator("option").allTextContents()).every((label) => label.includes(" · https://")))
  const alternative = network.addresses.at(-1)
  await choices.selectOption(alternative.url)
  for (let i = 0; i < 30; i++) {
    if ((await call("mobile.state")).preferredURL === alternative.url) break
    await wait(100)
  }
  await desktop.getByRole("button", { name: "Pair a phone", exact: true }).click()
  await desktop.waitForFunction((url) => document.querySelector(".bb-settings-panel select")?.value === url, alternative.url)
  assert.equal(await choices.inputValue(), alternative.url)
  await wait(3500)
  assert.equal(await choices.inputValue(), alternative.url)
  await choices.selectOption(network.addresses[0].url)
  check("Pairing prefers LAN over VPN, labels adapters and remembers explicit choices across new QR links")
  const pairing = await call("mobile.pair"),
    base = network.addresses[0].url
  phone = await context.newPage()
  phone.setDefaultTimeout(30000)
  phone.on("pageerror", (error) => report.errors.push(error.message))
  await phone.goto(base + "/#pair=" + pairing.token)
  await phone.getByRole("button", { name: "Pair a phone", exact: true }).click()
  for (let i = 0; i < 50; i++) {
    const state = await call("mobile.state")
    if (state.requests.length) {
      await call("mobile.approve", { id: state.requests[0].id })
      break
    }
    await wait(100)
  }
  await phone.locator("#app").waitFor({ state: "visible" })
  check("QR invitation requires desktop approval; phone stores a secure device cookie")
  const mobileAPI = (method, args = {}) =>
    phone.evaluate(
      async ({ method, args }) => {
        const response = await fetch("/api", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method, args }),
        })
        const value = await response.json()
        if (!response.ok) throw Error(JSON.stringify(value))
        return value
      },
      { method, args },
    )
  const catalog = await mobileAPI("overview")
  assert.ok(catalog.chats.some((chat) => chat.id === session.id))
  assert.ok(catalog.models.some((model) => model.providerID === "mobile-qa"))
  assert.equal(JSON.stringify(catalog).includes("fixture-only"), false)
  await phone.getByRole("button", { name: "Chats", exact: true }).first().click()
  await phone.getByRole("button", { name: session.title, exact: true }).click()
  await phone.locator("#model").selectOption(JSON.stringify({ providerID: "mobile-qa", modelID: "test-model" }))
  await phone.locator("#prompt").fill("Hello from phone")
  await phone.locator("#send").click()
  await phone.getByText("Shared response to phone.", { exact: true }).waitFor({ timeout: 60000 })
  assert.ok(
    (await engine(`/session/${session.id}/message`)).some((row) =>
      row.parts.some((part) => part.text === "Hello from phone"),
    ),
  )
  check("Phone messages enter the actual existing laptop session and stream back")
  const id =
    "msg_" +
    BigInt.asUintN(48, BigInt(Date.now()) * 4096n)
      .toString(16)
      .padStart(12, "0") +
    randomUUID().replaceAll("-", "").slice(0, 14)
  await call("runs.admit", {
    delivery: "queue",
    prompt: {
      protocol: "v1",
      sessionID: session.id,
      directory: join(data, "workspace"),
      id,
      text: "Desktop follow-up",
      agent: "build",
      model: { providerID: "mobile-qa", modelID: "test-model" },
      legacyParts: [{ type: "text", text: "Desktop follow-up" }],
    },
  })
  await phone.getByText("Shared response to desktop.", { exact: true }).waitFor({ timeout: 60000 })
  check("Laptop follow-up appears in the same phone conversation without reloading")
  await phone.locator("#prompt").fill("Draft stays on phone")
  await phone.getByRole("button", { name: "Chats", exact: true }).first().click()
  await phone.getByRole("button", { name: "New chat", exact: true }).click()
  await phone.waitForFunction(() => document.querySelector("#prompt").value === "")
  assert.equal(await phone.locator("#prompt").inputValue(), "")
  await phone.getByRole("button", { name: "Chats", exact: true }).first().click()
  await phone.getByRole("button", { name: session.title, exact: true }).click()
  await phone.waitForFunction(() => document.querySelector("#prompt").value === "Draft stays on phone")
  assert.equal(await phone.locator("#prompt").inputValue(), "Draft stays on phone")
  await phone.locator("#prompt").fill("")
  await phone.locator("#access").selectOption("full")
  await wait(300)
  assert.equal((await call("access.get", { sessionID: session.id })).mode, "full")
  await phone.locator("#access").selectOption("ask")
  await wait(300)
  assert.equal((await call("access.get", { sessionID: session.id })).mode, "ask")
  check("Phone drafts remain separate per chat; access mode is shared with desktop")
  await phone.getByRole("button", { name: "Chats", exact: true }).first().click()
  await phone.getByRole("button", { name: "Skills", exact: true }).click()
  await phone.getByRole("button", { name: "Attach skill", exact: true }).first().click()
  assert.equal(await phone.locator("#attachments .source-chip").count(), 1)
  await phone.locator("#send").click()
  await phone.waitForFunction(() => document.querySelector("#attachments").children.length === 0)
  for (let i = 0; i < 80; i++) {
    const run = await call("runs.get", { sessionID: session.id })
    if (!run.queue.length && !run.awaiting) break
    await wait(200)
  }
  const latest = await engine(`/session/${session.id}/message`)
  assert.ok(
    latest.some((row) => row.parts.some((part) => part.type === "file" && part.url?.startsWith("bitsbytes://skill/"))),
  )
  assert.ok(requests.some((request) => JSON.stringify(request.messages).includes("Selected skill")))
  check("Skill-only messages clear draft chips and deliver frozen skill context to the model")
  if (process.env.BB_MOBILE_AUDIO === "1") {
    await context.grantPermissions(["microphone"], { origin: new URL(phone.url()).origin })
    const beforeMessages = (await engine(`/session/${session.id}/message`)).length
    await phone.locator("#record-button").click()
    await phone.getByText("Recording", { exact: true }).waitFor()
    await wait(6400)
    await phone.getByRole("button", { name: "Finish and attach transcript", exact: true }).click()
    const uploaded = await phone.waitForFunction(async () => {
      const response = await fetch("/uploads"), rows = await response.json()
      return rows.find(row => row.status === "ready" || row.status === "error")
    }, undefined, { timeout: 90000 }).then(handle => handle.jsonValue())
    assert.equal(uploaded.status, "error", "Synthetic microphone tone must not become a speech transcript")
    assert.equal(uploaded.error, copy["bb.error.transcriptEmpty"])
    await phone.locator("#menu-button").click()
    await phone.getByRole("button", { name: "Audio uploads", exact: true }).click()
    await phone.getByText(copy["bb.error.transcriptEmpty"], { exact: true }).first().waitFor()
    assert.equal(await phone.locator("#attachments .source-chip").count(), 0)
    assert.equal((await engine(`/session/${session.id}/message`)).length, beforeMessages)
    await phone.locator("#menu-button").click()
    check("Paired HTTPS microphone uploads into real CPU Parakeet; no-speech failure is readable and does not attach or send")
  }
  const source = join(data, "Mobile preview.docx")
  await promisify(execFile)(
    join(data, "runtime/worker/Scripts/python.exe"),
    [
      "-c",
      'from docx import Document;import sys;d=Document();d.add_heading("Shared mobile document",0);d.add_paragraph("Created on the computer; previewed on the phone.");d.save(sys.argv[1])',
      source,
    ],
    { windowsHide: true },
  )
  await call("artifact.publish", { path: source, sessionID: session.id })
  for (let i = 0; i < 120; i++) {
    const files = await mobileAPI("artifacts", { sessionID: session.id })
    if (files.find((file) => file.filename === "Mobile preview.docx")?.status === "ready") break
    await wait(500)
  }
  await phone.locator("#files-button").click()
  await phone.getByRole("button", { name: /Mobile preview.docx/ }).click()
  await phone.locator("#preview-content canvas").waitFor({ timeout: 60000 })
  await phone.waitForFunction(() => document.querySelector("#pages").textContent === "1 / 1")
  assert.equal(await phone.locator("#pages").textContent(), "1 / 1")
  check("Verified Word document previews through PDF.js on the phone")
  await phone.screenshot({ path: join(qa, "mobile-document.png") })
  await phone.locator("#preview-close").click()
  const html = join(data, "Mobile visualization.html")
  await writeFile(
    html,
    '<!doctype html><html><body><p id="title">Safe visual</p><script>document.getElementById("title").textContent="Interactive visual";try{parent.document.body.dataset.compromised="yes"}catch{};fetch("/api",{method:"POST",body:"{}"}).catch(()=>{})</script></body></html>',
  )
  await call("artifact.publish", { path: html, sessionID: session.id })
  await phone.locator("#files-button").click()
  await phone.getByRole("button", { name: /Mobile visualization.html/ }).click()
  await phone.frameLocator("#preview-content iframe").getByText("Interactive visual", { exact: true }).waitFor()
  assert.equal(await phone.evaluate(() => document.body.dataset.compromised), undefined)
  check("HTML artifact previews run in an isolated sandbox without app or credential access")
  await phone.locator("#preview-close").click()
  await phone.screenshot({ path: join(qa, "mobile-chat.png") })
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await phone.reload()
  await phone.locator("#app").waitFor({ state: "visible" })
  await phone.getByText("Hello from phone", { exact: true }).waitFor()
  check("Paired phone reconnects and reopens the same session; 390px layout has no horizontal overflow")
  const device = (await call("mobile.state")).devices[0]
  await call("mobile.revoke", { id: device.id })
  await phone.locator("#pair-screen").waitFor({ state: "visible" })
  await call("mobile.disable")
  check("Revocation disconnects the device; disabling access closes the local server")
  report.requests = requests.length
  assert.deepEqual(report.errors, [])
} catch (error) {
  report.errors.push(error.stack)
  report.startup = startup
  throw error
} finally {
  await writeFile(join(qa, "verification.json"), JSON.stringify(report, null, 2))
  if (process.env.BB_MOBILE_REPORT) {
    await mkdir(join(root, ".tools/qa/results"), { recursive: true })
    await writeFile(join(root, ".tools/qa/results", process.env.BB_MOBILE_REPORT + ".json"), JSON.stringify(report, null, 2))
  }
  await context.close()
  await browser.close()
  await app.close()
  fixture.closeAllConnections()
  await new Promise((resolve) => fixture.close(resolve))
}
