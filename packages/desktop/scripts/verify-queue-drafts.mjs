import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/queue-drafts-" + randomUUID()),
  data = join(profile, "BitsBytesChat")
const observe = process.env.BB_DRAFT_OBSERVE === "1"
const report = { checks: [], errors: [], observations: [] }
await mkdir(join(data, "config/opencode"), { recursive: true })
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    model: "draft-qa/fixture",
    provider: {
      "draft-qa": {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "fixture-only" },
        models: { fixture: { name: "Draft fixture", limit: { context: 128000, output: 8192 } } },
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
    env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", LOCALAPPDATA: profile },
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
  for (const kind of observe
    ? ["missing-prompt"]
    : ["missing-prompt", "object-prompt", "null-part", "bad-context", "valid"]) {
    const response = await fetch(server.url + "/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "QA queued draft " + kind }),
      signal: AbortSignal.timeout(15000),
    })
    assert.ok(response.ok)
    const session = await response.json()
    const text = "Retain the complete queued source 🌿 " + kind
    const valid = {
      sessionID: session.id,
      sessionDirectory: directory,
      prompt: [{ type: "text", content: text, start: 0, end: text.length }],
      context: [],
      agent: "build",
      model: { providerID: "draft-qa", modelID: "fixture" },
    }
    const draft =
      kind === "missing-prompt"
        ? { transcript: "bitsbytes://transcript/saved?revision=7" }
        : kind === "object-prompt"
          ? { ...valid, prompt: {} }
          : kind === "null-part"
            ? { ...valid, prompt: [null] }
            : kind === "bad-context"
              ? { ...valid, context: {} }
              : valid
    await page.evaluate(
      async ({ sessionID, directory, text, draft }) => {
        await window.api.bitsbytes.call("runs.stop", { sessionID })
        await window.api.bitsbytes.call("runs.admit", {
          prompt: { sessionID, directory, id: "msg_saved_draft", text, draft },
        })
      },
      { sessionID: session.id, directory, text, draft },
    )
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), {
      directory,
      sessionID: session.id,
    })
    const chat = page.locator(`.bb-workspace-chat[data-bb-chat="${session.id}"]`)
    const available = await chat
      .locator("[contenteditable=true]")
      .first()
      .waitFor({ timeout: 5000 })
      .then(
        () => true,
        () => false,
      )
    report.observations.push({ kind, composerAvailable: available })
    if (observe) {
      console.log("OBSERVATION", JSON.stringify(report.observations.at(-1)))
      break
    }
    assert.equal(available, true)
    await chat.locator(".bb-queue-text").getByText(text, { exact: true }).waitFor()
    const saved = JSON.parse(await readFile(join(data, "chat-runs.json"), "utf8"))[session.id]
    assert.equal(saved.queue[0].prompt.text, text)
    assert.deepEqual(saved.queue[0].prompt.draft, draft)
    assert.equal(saved.paused, true)
    await chat.getByRole("button", { name: "Queued message actions", exact: true }).click()
    assert.equal(await page.getByRole("menuitem", { name: "Edit", exact: true }).isEnabled(), kind === "valid")
    await page.keyboard.press("Escape")
    report.checks.push(kind + " keeps the composer and source usable with safe draft controls")
    console.log("PASS", report.checks.at(-1))
  }
  if (!observe) {
    const response = await fetch(server.url + "/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "QA queued images" }),
      signal: AbortSignal.timeout(15000),
    })
    assert.ok(response.ok)
    const session = await response.json()
    await page.evaluate((sessionID) => window.api.bitsbytes.call("runs.stop", { sessionID }), session.id)
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), {
      directory,
      sessionID: session.id,
    })
    const chat = page.locator(`.bb-workspace-chat[data-bb-chat="${session.id}"]`),
      editor = chat.locator("[contenteditable=true]").first()
    await editor.waitFor()
    const image = await readFile(join(process.cwd(), "icons/bitsbytes/icon.png"))
    // PNG decoders tolerate trailing bytes; preserve two distinct byte sources
    // with the same filename without relying on an unsupported image format.
    const files = ["first", "second"].map((marker) => ({
      name: "image.png",
      mimeType: "image/png",
      buffer: Buffer.concat([image, Buffer.from("QA " + marker)]),
    }))
    await chat.locator("input[type=file]").first().setInputFiles(files)
    await chat.locator('[data-slot="prompt-attachments"] img').nth(1).waitFor()
    await editor.fill("Retain both images with identical filenames")
    await editor.press("Enter")
    await chat.locator(".bb-queue-row").waitFor()
    const saved = JSON.parse(await readFile(join(data, "chat-runs.json"), "utf8"))[session.id]
    const images = saved.queue[0].prompt.draft.prompt.filter((part) => part.type === "image")
    assert.equal(images.length, 2)
    assert.equal(new Set(images.map((image) => image.id)).size, 2)
    assert.ok(images.every((image) => typeof image.id === "string" && image.id.length > 0))
    assert.notEqual(images[0].dataUrl, images[1].dataUrl)
    assert.deepEqual(
      images.map((image) => Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(",") + 1), "base64")),
      files.map((file) => file.buffer),
    )
    report.checks.push("Normal composer Send freezes separate images with identical filenames and retains their IDs")
    console.log("PASS", report.checks.at(-1))
    const edit = async () => {
      await chat.getByRole("button", { name: "Queued message actions", exact: true }).click()
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
      await chat.locator('[data-slot="prompt-attachments"] img').nth(1).waitFor()
    }
    await edit()
    assert.deepEqual(
      await chat.locator('[data-slot="prompt-attachments"] img').evaluateAll((nodes) => nodes.map((node) => node.src)),
      images.map((image) => image.dataUrl),
    )
    await chat.getByRole("button", { name: "Remove attachment", exact: true }).first().click()
    assert.equal(await chat.locator('[data-slot="prompt-attachments"] img').count(), 1)
    assert.equal(
      await chat.locator('[data-slot="prompt-attachments"] img').first().getAttribute("src"),
      images[1].dataUrl,
    )
    await chat.getByRole("button", { name: "Cancel edit", exact: true }).click()
    await chat.locator('[data-slot="prompt-attachments"]').waitFor({ state: "hidden" })
    assert.deepEqual(
      JSON.parse(await readFile(join(data, "chat-runs.json"), "utf8"))[session.id].queue[0].prompt.draft.prompt,
      saved.queue[0].prompt.draft.prompt,
    )
    report.checks.push(
      "Editing restores both image sources; removing one leaves its neighbor and Cancel retains the original queued snapshot",
    )
    console.log("PASS", report.checks.at(-1))
    await chat.getByRole("button", { name: "Queued message actions", exact: true }).click()
    await page.getByRole("menuitem", { name: "Side chat", exact: true }).click()
    const side = page.locator(".bb-panel-content:visible")
    await side.locator("[contenteditable=true]").waitFor()
    await side.locator('[data-slot="prompt-attachments"] img').nth(1).waitFor()
    assert.deepEqual(
      await side.locator('[data-slot="prompt-attachments"] img').evaluateAll((nodes) => nodes.map((node) => node.src)),
      images.map((image) => image.dataUrl),
    )
    report.checks.push(
      "A queued image draft opens an editable side chat with both restored images and no automatic Send",
    )
    console.log("PASS", report.checks.at(-1))
    const legacyResponse = await fetch(server.url + "/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "QA historical image draft" }),
      signal: AbortSignal.timeout(15000),
    })
    assert.ok(legacyResponse.ok)
    const legacy = await legacyResponse.json()
    const legacyDraft = {
      ...saved.queue[0].prompt.draft,
      sessionID: legacy.id,
      prompt: saved.queue[0].prompt.draft.prompt.map((part) => {
        if (part.type !== "image") return part
        const { id, ...image } = part
        return image
      }),
    }
    await page.evaluate(
      async ({ sessionID, draft, original }) => {
        await window.api.bitsbytes.call("runs.stop", { sessionID })
        await window.api.bitsbytes.call("runs.admit", {
          prompt: { ...original, sessionID, id: "msg_historical_images", draft },
        })
      },
      { sessionID: legacy.id, draft: legacyDraft, original: saved.queue[0].prompt },
    )
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), {
      directory,
      sessionID: legacy.id,
    })
    const legacyChat = page.locator(`.bb-workspace-chat[data-bb-chat="${legacy.id}"]`)
    await legacyChat.locator("[contenteditable=true]").first().waitFor()
    await legacyChat.getByRole("button", { name: "Queued message actions", exact: true }).click()
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
    await legacyChat.locator('[data-slot="prompt-attachments"] img').nth(1).waitFor()
    await legacyChat.getByRole("button", { name: "Remove attachment", exact: true }).first().click()
    assert.equal(await legacyChat.locator('[data-slot="prompt-attachments"] img').count(), 1)
    assert.equal(
      await legacyChat.locator('[data-slot="prompt-attachments"] img').first().getAttribute("src"),
      images[1].dataUrl,
    )
    assert.deepEqual(
      JSON.parse(await readFile(join(data, "chat-runs.json"), "utf8"))[legacy.id].queue[0].prompt.draft,
      legacyDraft,
    )
    report.checks.push(
      "Historical portable images without IDs receive separate editing identities; removing one preserves its neighbor and original saved bytes",
    )
    console.log("PASS", report.checks.at(-1))
    assert.deepEqual(report.errors, [])
  }
} catch (error) {
  report.failure = String(error)
  console.error(error)
  process.exitCode = 1
} finally {
  await writeFile(
    join(root, ".tools/qa/results", (process.env.BB_DRAFT_REPORT || "queue-drafts") + ".json"),
    JSON.stringify(report, null, 2),
  )
  await app?.close()
}
