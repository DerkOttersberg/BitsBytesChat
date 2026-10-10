import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { dirname, join, resolve } from "node:path"
import { captureHidden } from "./qa-capture.mjs"
import { verifyComposerLayout } from "./qa-composer-layout.mjs"

setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/ic-" + randomUUID())
const data = join(profile, "BitsBytesChat")
const directory = join(data, "workspace")
const fixtures = join(root, ".tools/qa/image-chat-fixtures")
const results = join(root, ".tools/qa/results")
const reportName = process.env.BB_QA_REPORT || "image-chat"
const executablePath =
  process.env.BB_QA_EXECUTABLE || join(root, ".tools/qa/image-chat-verified-package/win-unpacked/BitsBytesChat.exe")
const report = { checks: [], errors: [], screenshots: [], profile, syntheticProvider: true, paidImageRequests: false }
report.executablePath = executablePath
report.asarSHA256 = createHash("sha256")
  .update(await readFile(join(dirname(executablePath), "resources/app.asar")))
  .digest("hex")
const prompts = {
  image: "Generate a square PNG of a blue circle centered on a white background. Show the image inline in this chat.",
  edit:
    "Merge these two reference images into one square PNG. Keep the blue circle on the left and the red square on the right, on a white background. Show it inline in this chat.\n\n" +
    [join(fixtures, "blue.png"), join(fixtures, "red.png")].join("\n"),
  word: "Create a Word document named qa-notes.docx with the title QA Notes and three bullet points: Clear messages; Visible progress; Safe approvals. Provide a preview and a download.",
  wordRevision:
    "Revise qa-notes.docx: change the title to QA Notes Revised and add the bullet Reviewed locally. Keep the same document.",
  excel:
    "Create an Excel workbook named qa-budget.xlsx with a Budget sheet: Item and Cost columns, Paper 12, Pens 8, and a Total formula summing the costs. Provide a preview and a download.",
  excelRevision: "Update qa-budget.xlsx so Pens costs 10. Keep the Total as a formula and preserve the same workbook.",
}
await Promise.all(
  [directory, join(data, "config/opencode"), fixtures, results].map((path) => mkdir(path, { recursive: true })),
)
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
execFileSync(
  join(data, "runtime/artifacts/Scripts/python.exe"),
  [
    "-c",
    [
      "from PIL import Image, ImageDraw",
      "from pathlib import Path",
      `folder=Path(${JSON.stringify(fixtures)})`,
      "blue=Image.new('RGB',(512,512),'white'); ImageDraw.Draw(blue).ellipse((128,128,384,384),fill='blue'); blue.save(folder/'blue.png')",
      "red=Image.new('RGB',(512,512),'white'); ImageDraw.Draw(red).rectangle((128,128,384,384),fill='red'); red.save(folder/'red.png')",
      "merged=Image.new('RGB',(512,512),'white'); draw=ImageDraw.Draw(merged); draw.ellipse((32,160,224,352),fill='blue'); draw.rectangle((288,160,480,352),fill='red'); merged.save(folder/'merged.png')",
    ].join("\n"),
  ],
  { windowsHide: true, stdio: "pipe" },
)
const images = {
  blue: await readFile(join(fixtures, "blue.png")),
  red: await readFile(join(fixtures, "red.png")),
  merged: await readFile(join(fixtures, "merged.png")),
}
const imageRequests = []
const modelRequests = []
const pendingImages = new Set()
const fixture = createServer(async (req, res) => {
  if (req.url === "/api/v1/images/models") {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        data: [
          {
            id: "fixture-edit",
            name: "Fixture edit",
            architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
            supported_parameters: ["input_references"],
          },
          {
            id: "fixture-text",
            name: "Fixture text only",
            architecture: { input_modalities: ["text"], output_modalities: ["image"] },
            supported_parameters: [],
          },
        ],
      }),
    )
    return
  }
  let body = ""
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body || "{}")
  if (req.url === "/images") {
    assert.equal(req.headers.authorization, "Bearer fixture-image-key")
    const gate = Promise.withResolvers()
    const entry = { input, release: gate.resolve }
    imageRequests.push(entry)
    pendingImages.add(gate.resolve)
    res.once("close", gate.resolve)
    await gate.promise
    pendingImages.delete(gate.resolve)
    if (res.destroyed) return
    if (input.prompt.includes("fixture-denied")) {
      res
        .writeHead(403, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { code: "access_denied", message: "Local fixture access denied" } }))
      return
    }
    const bytes = input.images?.length || input.input_references?.length ? images.merged : images.blue
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] }))
    return
  }
  if (req.method !== "POST") {
    res.writeHead(200).end("Local fixture")
    return
  }
  const userIndex = input.messages?.findLastIndex((row) => row.role === "user") ?? -1
  const content = input.messages?.[userIndex]?.content
  const latest =
    typeof content === "string"
      ? content
      : content
          ?.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n") || ""
  const current = input.messages?.slice(userIndex) || []
  const matches = (name, tool) => name === tool || name?.endsWith("_" + tool)
  const named = (tool) => input.tools?.find((entry) => matches(entry.function?.name, tool))?.function.name
  const executed = (tool) =>
    current.some((row) =>
      row.tool_calls?.some(
        (call) =>
          matches(call.function?.name, tool) ||
          (matches(call.function?.name, "code_mode") && call.function.arguments?.includes(tool)),
      ),
    )
  const artifact = latest.includes("qa-notes.docx")
    ? {
        job_id: "qa-word",
        ...(latest.includes("Revise") ? { revision: true } : {}),
        spec: {
          filename: "qa-notes.docx",
          title: latest.includes("Revise") ? "QA Notes Revised" : "QA Notes",
          blocks: [
            "Clear messages",
            "Visible progress",
            "Safe approvals",
            ...(latest.includes("Revise") ? ["Reviewed locally"] : []),
          ].map((text) => ({ type: "bullet", text })),
        },
      }
    : latest.includes("qa-budget.xlsx")
      ? {
          job_id: "qa-excel",
          ...(latest.includes("Update") ? { revision: true } : {}),
          spec: {
            filename: "qa-budget.xlsx",
            sheets: [
              {
                name: "Budget",
                rows: [
                  ["Item", "Cost"],
                  ["Paper", 12],
                  ["Pens", latest.includes("Update") ? 10 : 8],
                  ["Total", "=SUM(B2:B3)"],
                ],
              },
            ],
          },
        }
      : undefined
  const tool = artifact ? "create_artifact" : "generate_image"
  const args = artifact || {
    prompt: latest,
    ...(latest.includes("reference images")
      ? { referenced_image_paths: [join(fixtures, "blue.png"), join(fixtures, "red.png")] }
      : {}),
  }
  const calls =
    latest.includes("Reply with exactly: Side chat ready.") || executed(tool)
      ? []
      : [
          {
            name: named(tool) || named("code_mode"),
            args: named(tool)
              ? args
              : { code: `return await tools["bitsbytes-local"].${tool}(${JSON.stringify(args)})` },
          },
        ]
  modelRequests.push({
    latest,
    tools: input.tools?.map((tool) => tool.function.name),
    emitted: calls.map((call) => call.name),
  })
  if (calls.some((call) => !call.name)) {
    report.errors.push("Fixture tool not advertised")
    res.writeHead(500).end("Fixture tool unavailable")
    return
  }
  res.writeHead(200, { "content-type": "text/event-stream" })
  const emit = (delta, finish_reason = null) =>
    res.write(
      "data: " +
        JSON.stringify({
          id: "fixture-" + randomUUID(),
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n",
    )
  emit({ role: "assistant" })
  if (calls.length)
    emit({
      tool_calls: calls.map((call, index) => ({
        index,
        id: "call_" + randomUUID(),
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    })
  else
    emit({
      content: latest.includes("Reply with exactly: Side chat ready.")
        ? "Side chat ready."
        : "The local fixture tool result is recorded in this chat.",
    })
  emit({}, calls.length ? "tool_calls" : "stop")
  res.end("data: [DONE]\n\n")
})
await new Promise((done) => fixture.listen(0, "127.0.0.1", done))
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    provider: {
      "workspace-qa": {
        name: "Local QA",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `http://127.0.0.1:${fixture.address().port}/v1`, apiKey: "fixture-only" },
        models: {
          fixture: {
            name: "Image and artifact QA fixture",
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 1000000, output: 8192 },
          },
        },
      },
    },
    model: "workspace-qa/fixture",
  }),
)
const check = (label) => {
  report.checks.push(label)
  console.log("PASS", label)
}
const poll = async (read, accept, label, attempts = 300) => {
  for (let index = 0; index < attempts; index++) {
    const value = await read()
    if (accept(value)) return value
    await new Promise((done) => setTimeout(done, 100))
  }
  throw Error("Timed out: " + label)
}
let app, page
try {
  app = await _electron.launch({
    executablePath,
    env: {
      ...process.env,
      LOCALAPPDATA: profile,
      BB_QA_ISOLATED: "1",
      BB_QA_HIDDEN: "1",
      BB_QA_CAPTURE: "1",
      BB_QA_IMAGE_URL: `http://127.0.0.1:${fixture.address().port}/images`,
    },
    timeout: 120000,
  })
  page = await app.firstWindow({ timeout: 120000 })
  page.setDefaultTimeout(45000)
  page.on("pageerror", (error) => report.errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setBackgroundThrottling(false)
    window.setContentSize(1380, 900)
  })
  const server = await page.evaluate(() => window.api.awaitInitialization())
  const headers = {
    "content-type": "application/json",
    "x-opencode-directory": encodeURIComponent(directory),
    ...(server.password
      ? {
          authorization:
            "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64"),
        }
      : {}),
  }
  const api = async (path, method = "GET", body) => {
    const response = await fetch(server.url + path, {
      method,
      headers,
      signal: AbortSignal.timeout(45000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    assert.ok(response.ok, `${method} ${path}: ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }
  const call = (method, args = {}) =>
    page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
  const artifacts = async () => (await call("artifacts.list")).filter((item) => item.sessionID === chat.id)
  const artifactState = async (id) => (await artifacts()).find((item) => item.id === id)
  await page.locator(".bb-org-sidebar").waitFor({ timeout: 120000 })
  assert.equal(await page.getByText("DEV", { exact: true }).count(), 0, "packaged candidate uses the production channel")
  report.productionChannel = true
  await api("/api/organization/migrate", "POST", { projects: [{ directory }], defaultDirectory: directory })
  await call("images.configure", { provider: "openai", key: "fixture-image-key", model: "gpt-image-2.5-flare" })
  await poll(
    () => call("images.status"),
    (value) => value.available,
    "configured image provider",
  )
  const create = async (title) => {
    const session = await api("/session", "POST", {
      title,
      permission: [
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "read", pattern: "*", action: "allow" },
      ],
    })
    await api(`/session/${session.id}/prompt_async`, "POST", {
      noReply: true,
      agent: "build",
      model: { providerID: "workspace-qa", modelID: "fixture" },
      parts: [{ type: "text", text: "Durable fictional input" }],
    })
    return session
  }
  const chat = await create("Image and artifact comparison")
  const other = await create("Image isolation")
  const open = async (session) => {
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), {
      directory,
      sessionID: session.id,
    })
    await page.locator(`.bb-workspace-chat[data-bb-chat="${session.id}"] [contenteditable=true]`).first().waitFor()
  }
  await open(chat)
  const main = () => page.locator(`.bb-workspace-chat[data-bb-chat="${chat.id}"]`)
  const cards = () => main().locator('[data-component="image-generation-card"]')
  const editor = () => main().locator("[contenteditable=true]").first()
  const send = async (text) => {
    await editor().fill(text)
    await editor().press("Enter")
  }
  const finish = () =>
    poll(
      () => api(`/session/${chat.id}/message`),
      (rows) => rows.at(-1)?.info.finish === "stop",
      "finished turn",
    )
  const snapshot = async (label) => {
    const path = join(results, `${reportName}-${label}.png`)
    const regions = await page.evaluate(() => Object.fromEntries([
      ["chat", ".bb-workspace-chat"], ["panelHeader", ".bb-panel-header"], ["panel", ".bb-workspace-panel"], ["documentToolbar", ".bb-document-toolbar"], ["fileCard", ".bb-workspace-chat .bb-artifact-card"],
    ].flatMap(([name, selector]) => {
      const element = [...document.querySelectorAll(selector)].find(element => element.getBoundingClientRect().width && element.getBoundingClientRect().height)
      if (!element) return []
      const rect = element.getBoundingClientRect()
      return [[name, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }]]
    })))
    const documentTurn = await page.evaluate(() => {
      const card = [...document.querySelectorAll(".bb-workspace-chat .bb-artifact-card")].findLast(element => element.getBoundingClientRect().height)
      const id = card?.closest("[data-message-id]")?.getAttribute("data-message-id")
      if (!id) return
      const rects = [...document.querySelectorAll(".bb-workspace-chat [data-message-id]")].filter(element => element.getAttribute("data-message-id") === id).map(element => element.getBoundingClientRect()).filter(rect => rect.height)
      const left = Math.max(0, Math.min(...rects.map(rect => rect.left)))
      const top = Math.max(0, Math.min(...rects.map(rect => rect.top)))
      return { x: left, y: top, width: Math.max(...rects.map(rect => rect.right)) - left, height: Math.min(innerHeight, Math.max(...rects.map(rect => rect.bottom))) - top }
    })
    if (documentTurn) regions.documentTurn = documentTurn
    report.screenshots.push({ label, path, regions, ...(await captureHidden(app, page, path)) })
  }
  const allow = () => main().getByRole("button", { name: "Allow once", exact: true })
  await send(prompts.image)
  await allow().waitFor()
  assert.equal(imageRequests.length, 0)
  await snapshot("approval-waiting")
  check("Ask for approval sends no image request before Allow once")
  await allow().click()
  await poll(
    () => imageRequests.length,
    (count) => count === 1,
    "image inference admitted",
  )
  await cards().last().locator('.bb-image-placeholder[data-animated="true"]').waitFor()
  assert.equal(await main().getByText("Thinking", { exact: true }).count(), 0)
  await cards()
    .last()
    .evaluate((element) => (element.dataset.qaInstance = "original-image-card"))
  assert.equal(
    await cards()
      .last()
      .locator(".bb-image-dots")
      .evaluate((element) => getComputedStyle(element).animationName),
    "bb-image-breathe",
  )
  await snapshot("image-generating")
  imageRequests[0].release()
  await poll(
    () => cards().last().getAttribute("data-loaded"),
    (value) => value === "true",
    "inline PNG decoded",
  )
  assert.equal(await cards().last().getAttribute("data-qa-instance"), "original-image-card")
  assert.equal(await cards().last().locator(".bb-image-placeholder").count(), 0)
  assert.equal(await page.locator(".bb-workspace-panel:visible").count(), 0)
  await finish()
  await snapshot("image-completed")
  check("The animated dotted box is replaced in the same card by the actual PNG; no panel opens")
  const jobs = await call("images.list", { sessionID: chat.id })
  assert.equal(jobs.length, 1)
  assert.ok(jobs[0].inputID && jobs[0].callID)
  const original = jobs[0].artifact
  const downloadPath = join(profile, "downloaded-image.png")
  await app.evaluate(({ BrowserWindow }, path) => {
    globalThis.qaDownload = undefined
    BrowserWindow.getAllWindows()[0].webContents.session.once("will-download", (_, item) => {
      const filename = item.getFilename()
      item.setSavePath(path)
      item.once("done", (_, status) => {
        globalThis.qaDownload = { filename, status, path }
      })
    })
  }, downloadPath)
  await cards().last().getByRole("link", { name: "Download image", exact: true }).click()
  const download = await poll(
    () => app.evaluate(() => globalThis.qaDownload),
    (value) => !!value,
    "native image download",
  )
  assert.equal(download.status, "completed")
  assert.ok(download.filename.endsWith(".png"))
  const downloaded = await readFile(download.path)
  assert.ok(downloaded.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
  check("Inline Download returns a real PNG with the image's filename")
  await cards().last().getByRole("button", { name: "Enlarge image", exact: true }).last().click()
  await page.getByRole("dialog").waitFor()
  assert.ok(
    await page
      .getByRole("dialog")
      .locator("img")
      .evaluate((element) => element.complete && element.naturalWidth > 0),
  )
  await page.keyboard.press("Escape")
  await open(other)
  assert.equal(await page.locator(`.bb-workspace-chat[data-bb-chat="${other.id}"] .bb-image-card`).count(), 0)
  await open(chat)
  await page.reload()
  await page.locator(".bb-org-sidebar").waitFor({ timeout: 120000 })
  await open(chat)
  await poll(
    () =>
      cards()
        .filter({ has: page.locator("img") })
        .count(),
    (count) => count === 1,
    "saved image after reload",
  )
  await poll(
    () => cards().last().getAttribute("data-loaded"),
    (value) => value === "true",
    "saved PNG after reload",
  )
  assert.equal(await page.locator(".bb-workspace-panel:visible").count(), 0)
  check("Enlarge works; saved images survive reload and remain scoped to their chat")
  await send(prompts.edit)
  await allow().waitFor()
  assert.equal(imageRequests.length, 1)
  await allow().click()
  await poll(
    () => imageRequests.length,
    (count) => count === 2,
    "reference edit admitted",
  )
  assert.deepEqual(
    imageRequests[1].input.images.map((image) => Buffer.from(image.image_url.split(",")[1], "base64")),
    [images.blue, images.red],
  )
  await snapshot("edit-generating")
  imageRequests[1].release()
  await poll(
    () => cards().last().getAttribute("data-loaded"),
    (value) => value === "true",
    "edited PNG decoded",
  )
  await finish()
  assert.equal(await cards().count(), 2)
  await snapshot("edit-completed")
  check("Both exact reference images reach the image provider, and the merged PNG appears inline once")
  await send("Generate fixture-canceled as a square PNG.")
  await allow().waitFor()
  const canceledPermission = (await api("/permission")).find((row) => row.sessionID === chat.id)
  await main().getByRole("button", { name: "Stop", exact: true }).click()
  await poll(
    () => api("/permission"),
    (rows) => !rows.some((row) => row.id === canceledPermission.id),
    "approval dismissed on Stop",
  )
  assert.equal(imageRequests.length, 2)
  const late = await fetch(`${server.url}/permission/${canceledPermission.id}/reply`, {
    method: "POST",
    headers,
    body: JSON.stringify({ reply: "once" }),
  })
  assert.ok(!late.ok)
  assert.equal(imageRequests.length, 2)
  await snapshot("approval-canceled")
  check("Stop dismisses a waiting approval; a late approval cannot submit an image request")
  await send("Generate fixture-held as a square PNG.")
  await allow().waitFor()
  await allow().click()
  await poll(
    () => imageRequests.length,
    (count) => count === 3,
    "held image request",
  )
  await main().getByRole("button", { name: "Stop", exact: true }).click()
  await poll(
    () => call("images.list", { sessionID: chat.id }),
    (rows) => rows.at(-1)?.status === "canceled",
    "generation canceled",
  )
  imageRequests[2].release()
  await poll(
    () => cards().last().getAttribute("aria-busy"),
    (value) => value === "false",
    "canceled box static",
  )
  await snapshot("image-canceled")
  check("Stop cancels generation and leaves a static canceled card without automatic resubmission")
  await send("Generate fixture-denied as a square PNG.")
  await allow().waitFor()
  await allow().click()
  await poll(
    () => imageRequests.length,
    (count) => count === 4,
    "denied image request",
  )
  imageRequests[3].release()
  await poll(
    () => call("images.list", { sessionID: chat.id }),
    (rows) => rows.at(-1)?.status === "error",
    "provider denial recorded",
  )
  await finish()
  await snapshot("image-failed")
  assert.equal(await cards().last().getAttribute("aria-busy"), "false")
  assert.equal(await cards().last().locator("img").count(), 0)
  check("A provider failure becomes a static error with no invented image or endless animation")
  for (const [kind, prompt, revisionPrompt] of [
    ["document", prompts.word, prompts.wordRevision],
    ["spreadsheet", prompts.excel, prompts.excelRevision],
  ]) {
    await send(prompt)
    await allow().waitFor()
    await allow().click()
    await finish()
    const first = await poll(artifacts, (rows) => rows.find((row) => row.kind === kind), kind + " published")
    const artifact = first.find((row) => row.kind === kind)
    const previewUI = async (item, revised) => {
      const card = main().locator(".bb-artifact-card").filter({ hasText: item.filename }).last()
      await card.click()
      const panel = page.locator(".bb-document-panel:visible").last()
      await panel.waitFor()
      await panel.getByRole("button", { name: "Save copy", exact: true }).waitFor()
      assert.equal(await card.locator("small").textContent(), kind === "document" ? "Word" : "Excel")
      assert.equal(await card.locator("[data-component=file-type-icon]").getAttribute("data-file-type"), kind === "document" ? "word" : "spreadsheet")
      assert.equal(await card.locator(".bb-artifact-open").textContent(), "Open")
      assert.equal(await card.getByText(/Revision \d+/).count(), 0)
      await card.hover()
      await poll(() => card.evaluate(element => {
        const actions = element.closest('[data-slot="session-turn-assistant-content"]')?.querySelector('[data-slot="text-part-copy-wrapper"]')
        if (!actions) return false
        const style = getComputedStyle(actions)
        return style.opacity === "1" && style.pointerEvents === "auto"
      }), Boolean, "response actions remain reachable across the file card")
      const geometry = await card.evaluate(element => {
        const content = element.closest('[data-slot="session-turn-assistant-content"]')
        const body = content?.querySelector('[data-slot="text-part-body"]')?.getBoundingClientRect()
        const actions = content?.querySelector('[data-slot="text-part-copy-wrapper"]')?.getBoundingClientRect()
        const card = element.getBoundingClientRect()
        return { gap: body && card.top - body.bottom, actionsBelow: actions && actions.top >= card.bottom, width: card.width, height: card.height, contentWidth: content?.getBoundingClientRect().width }
      })
      assert.ok(geometry.gap !== undefined && geometry.gap >= 0 && geometry.gap <= 20, JSON.stringify(geometry))
      assert.equal(geometry.actionsBelow, true, JSON.stringify(geometry))
      assert.ok(geometry.width <= geometry.contentWidth && geometry.height <= 70, JSON.stringify(geometry))
      report.cardGeometry ??= []
      report.cardGeometry.push({ kind, revised, ...geometry })
      for (const name of [kind === "document" ? "Open in Word" : "Open in app", "Show in folder", "Save copy"]) {
        const action = panel.getByRole("button", { name, exact: true })
        assert.equal(await action.textContent(), "")
        assert.ok(await action.locator("svg").count())
      }
      assert.equal(await panel.getByRole("combobox", { name: "Version history", exact: true }).count(), revised ? 1 : 0)
      if (kind === "document" && !revised) {
        await panel.getByRole("button", { name: "Save copy", exact: true }).hover()
        await page.getByRole("tooltip").filter({ hasText: "Save copy" }).waitFor()
        await snapshot("document-actions-tooltip")
        await card.hover()
      }
      if (kind === "spreadsheet") {
        const expected = ["Item", "Cost", "Paper", "12", "Pens", revised ? "10" : "8", "Total", revised ? "22" : "20"]
        await poll(
          () => panel.locator(".bb-sheet-scroll td").allTextContents(),
          (cells) => JSON.stringify(cells) === JSON.stringify(expected),
          "visible budget values",
        )
        const grid = await call("artifact.content", { id: item.id })
        assert.equal(grid.sheet, "Budget")
        assert.match(grid.formulas[3][1], /SUM\(B2:B3\)/)
        const saved = JSON.parse(
          execFileSync(
            join(data, "runtime/artifacts/Scripts/python.exe"),
            [
              "-c",
              "from openpyxl import load_workbook; import json,sys; s=load_workbook(sys.argv[1],data_only=False)['Budget']; print(json.dumps([s['B3'].value,s['B4'].value]))",
              item.source,
            ],
            { windowsHide: true, encoding: "utf8" },
          ),
        )
        assert.deepEqual(saved, [revised ? 10 : 8, "=SUM(B2:B3)"])
        return
      }
      await poll(
        () =>
          panel.locator("canvas").evaluate((canvas) => {
            if (!canvas.width || !canvas.height) return false
            const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data
            for (let index = 0; index < pixels.length; index += 4)
              if (pixels[index + 3] && pixels[index] < 200 && pixels[index + 1] < 200 && pixels[index + 2] < 200)
                return true
            return false
          }),
        Boolean,
        "Word canvas rendered",
      )
      const title = revised ? "QA Notes Revised" : "QA Notes"
      const contents = JSON.parse(
        execFileSync(
          join(data, "runtime/artifacts/Scripts/python.exe"),
          [
            "-c",
            "from docx import Document; from pypdf import PdfReader; import json,sys; print(json.dumps({'paragraphs':[p.text for p in Document(sys.argv[1]).paragraphs],'preview':' '.join(p.extract_text() for p in PdfReader(sys.argv[2]).pages)}))",
            item.source,
            item.pdf,
          ],
          { windowsHide: true, encoding: "utf8" },
        ),
      )
      assert.deepEqual(contents.paragraphs, [
        title,
        "Clear messages",
        "Visible progress",
        "Safe approvals",
        ...(revised ? ["Reviewed locally"] : []),
      ])
      assert.ok(contents.preview.includes(title))
      if (revised) assert.ok(contents.preview.includes("Reviewed locally"))
    }
    await poll(
      () => artifactState(artifact.id),
      (item) => item.status === "ready" || item.status === "error",
      kind + " preview",
      900,
    )
    const preview = await artifactState(artifact.id)
    assert.equal(preview.status, "ready", preview.error)
    await previewUI(preview, false)
    await page.mouse.move(20, 20)
    await snapshot(kind + "-completed")
    if (kind === "document") {
      const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
      await page.emulateMedia({ colorScheme: "dark" })
      await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "dark")
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25))
      await page.waitForTimeout(250)
      await verifyComposerLayout(main())
      await snapshot("document-dark-125")
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.webContents.setZoomFactor(1)
        window.setBounds({ width: 1000, height: 800 })
      })
      await page.emulateMedia({ colorScheme: "light" })
      await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "light")
      const card = main().locator(".bb-artifact-card").filter({ hasText: preview.filename }).last()
      const fits = await card.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const content = element.closest('[data-slot="session-turn-assistant-content"]').getBoundingClientRect()
        const info = element.querySelector(".bb-artifact-file-info").getBoundingClientRect()
        return rect.width <= content.width && info.width >= 60 && element.scrollWidth <= element.clientWidth
      })
      assert.equal(fits, true)
      await verifyComposerLayout(main())
      await snapshot("document-narrow")
      await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), bounds)
    }
    await send(revisionPrompt)
    await allow().waitFor()
    await allow().click()
    await finish()
    const revised = await poll(
      () => artifactState(artifact.id),
      (item) => item.revision === 2 && (item.status === "ready" || item.status === "error"),
      kind + " revised preview",
      900,
    )
    assert.equal(revised.status, "ready", revised.error)
    await previewUI(revised, true)
    const rows = await artifacts()
    assert.equal(rows.filter((row) => row.kind === kind).length, 1)
    await snapshot(kind + "-revised")
    check(
      `The ${kind} source and visible preview contain the correct contents; revision 2 preserves its artifact identity`,
    )
  }
  check("File cards show distinct type icons and labels without revision noise; response actions follow the card, and compact Office actions retain labels, tooltips and revision history")
  check("Narrow split-view composer controls keep their own pointer targets and text bounds without overlap at 100/125%")
  await page.getByRole("button", { name: "Open panel", exact: true }).last().click()
  await page.getByRole("menuitem", { name: "Side chat", exact: true }).click()
  const side = page.locator(".bb-embedded-chat:visible")
  await side.locator("[contenteditable=true]").first().waitFor()
  const childID = await side.getAttribute("data-bb-chat")
  assert.ok(childID && childID !== chat.id)
  assert.equal((await call("images.list", { sessionID: childID })).length, 0)
  const sideEditor = side.locator("[contenteditable=true]").first()
  await sideEditor.fill("Reply with exactly: Side chat ready.")
  await sideEditor.press("Enter")
  await side.getByText("Side chat ready.", { exact: true }).waitFor()
  assert.equal(imageRequests.length, 4)
  await snapshot("side-chat")
  await page
    .locator(".bb-panel-tabs > div")
    .filter({ has: page.getByRole("tab", { name: "Side chat", exact: true }) })
    .locator(".bb-panel-tab-close")
    .click()
  await side.waitFor({ state: "detached" })
  await open(other)
  assert.equal(await page.locator(".bb-document-panel:visible").count(), 0)
  await open(chat)
  assert.equal((await artifacts()).filter((item) => item.kind === "image").length, 2)
  check(
    "A side chat responds independently, closes correctly, and navigation preserves the parent artifacts without duplicate image requests",
  )
  assert.deepEqual(report.errors, [])
  report.originalImage = original
  report.prompts = prompts
  report.artifacts = await artifacts()
} catch (error) {
  report.failure = error.stack || String(error)
  if (page) {
    report.failureUI = await page
      .evaluate(() => ({ route: location.pathname, text: document.body.innerText.slice(-8500) }))
      .catch(() => undefined)
    await captureHidden(app, page, join(results, `${reportName}-failure.png`)).catch(() => undefined)
  }
  process.exitCode = 1
} finally {
  for (const release of pendingImages) release()
  await app?.close()
  fixture.closeAllConnections()
  await new Promise((done) => fixture.close(done))
  report.imageRequests = imageRequests.map((entry) => ({
    prompt: entry.input.prompt,
    model: entry.input.model,
    references: entry.input.images?.length || entry.input.input_references?.length || 0,
  }))
  report.modelRequests = modelRequests
  await writeFile(join(results, `${reportName}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ checks: report.checks, errors: report.errors, failure: report.failure, profile }))
}
