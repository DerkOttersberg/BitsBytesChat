import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { join, resolve } from "node:path"

// Repeated real-engine work, interrupted admission and owned-profile restarts.
// No account inference, native input, notifications or visible windows.
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/endurance-" + randomUUID())
const data = join(profile, "BitsBytesChat"),
  directory = join(data, "workspace")
const results = join(root, ".tools/qa/results")
const seconds = Number(process.env.BB_QA_ENDURANCE_SECONDS || 7200)
assert.ok(Number.isInteger(seconds) && seconds >= 60 && seconds <= 21600)
const interval = Number(process.env.BB_QA_ENDURANCE_INTERVAL || 60)
assert.ok(Number.isInteger(interval) && interval >= 5 && interval <= 300)
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const holds = new Map()
const report = {
  profile,
  syntheticProvider: true,
  requestedSeconds: seconds,
  intervalSeconds: interval,
  cycles: [],
  samples: [],
  errors: [],
  restarts: 0,
  providerRequests: 0,
}
const fixture = createServer(async (request, response) => {
  let body = ""
  for await (const chunk of request) body += chunk
  const input = JSON.parse(body)
  report.providerRequests++
  const content = input.messages?.findLast((row) => row.role === "user")?.content
  const latest = typeof content === "string" ? content : content?.find((part) => part.type === "text")?.text || ""
  const held = [...holds].find(([marker, value]) => latest.includes(marker) && !value.entered)
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.flushHeaders()
  if (held) {
    held[1].entered = true
    const keepalive = setInterval(() => {
      if (!response.destroyed) response.write(": keepalive\n\n")
    }, 15000)
    try {
      await held[1].release.promise
    } finally {
      clearInterval(keepalive)
    }
  }
  if (response.destroyed) return
  const hasTool = input.messages?.at(-1)?.role === "tool"
  const tool =
    !hasTool && latest.includes("diagnostic-progress")
      ? "parent_progress"
      : !hasTool && latest.includes("required-question")
        ? "question"
        : undefined
  const name = tool && input.tools?.find((row) => row.function?.name.endsWith(tool))?.function.name
  if (tool && !name) {
    report.errors.push("Fixture tool was not advertised: " + tool)
    response.end()
    return
  }
  const delta = name
    ? {
        tool_calls: [
          {
            index: 0,
            id: "call_" + randomUUID(),
            type: "function",
            function: {
              name,
              arguments: JSON.stringify(
                tool === "question"
                  ? {
                      isBlocking: true,
                      questions: [
                        {
                          header: "Endurance",
                          question: "Required endurance preference",
                          options: [
                            { label: "Continue", description: "Continue the controlled check." },
                            { label: "Stop", description: "Stop the controlled check." },
                          ],
                        },
                      ],
                    }
                  : {},
              ),
            },
          },
        ],
      }
    : { content: "Recorded endurance response: " + latest.slice(0, 120) }
  const emit = (delta, finish_reason = null) =>
    response.write(
      "data: " +
        JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n",
    )
  emit({ role: "assistant" })
  emit(delta)
  emit({}, name ? "tool_calls" : "stop")
  response.end("data: [DONE]\n\n")
})
await new Promise((done) => fixture.listen(0, "127.0.0.1", done))
await mkdir(join(data, "config/opencode"), { recursive: true })
await mkdir(directory, { recursive: true })
await mkdir(results, { recursive: true })
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    model: "endurance-qa/fixture",
    provider: {
      "endurance-qa": {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `http://127.0.0.1:${fixture.address().port}/v1`, apiKey: "fixture-only" },
        models: { fixture: { name: "Endurance fixture", limit: { context: 128000, output: 8192 } } },
      },
    },
  }),
)
const version = JSON.parse(await readFile(join(root, "packages/desktop/package.json"), "utf8")).version
let app, page, call, engine, chat
const started = performance.now()
const reportPath = join(results, (process.env.BB_QA_REPORT || "035-endurance") + ".json")
const save = () => writeFile(reportPath, JSON.stringify({ ...report, elapsedMs: performance.now() - started }, null, 2))
const eventually = async (predicate, label, timeout = 30000) => {
  const end = performance.now() + timeout
  while (performance.now() < end) {
    if (await predicate()) return
    await delay(100)
  }
  throw Error(label)
}
const hidden = () =>
  app.evaluate(({ BrowserWindow }) => {
    if (BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()))
      throw Error("Endurance window became visible or focused")
  })
async function launch() {
  app = await _electron.launch({
    executablePath:
      process.env.BB_QA_EXECUTABLE || join(root, `packages/desktop/dist/${version}/win-unpacked/BitsBytesChat.exe`),
    ...(process.env.BB_QA_MAIN ? { args: [process.env.BB_QA_MAIN] } : {}),
    env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", BB_QA_CAPTURE: "0", LOCALAPPDATA: profile },
    timeout: 90000,
  })
  page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  page.on("pageerror", (error) => report.errors.push(error.message))
  await page.locator("[contenteditable=true]").first().waitFor({ timeout: 90000 })
  const server = await page.evaluate(() => window.api.awaitInitialization())
  const headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) }
  if (server.password)
    headers.authorization =
      "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")
  call = (method, args = {}) =>
    page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
  engine = async (path, method = "GET", body) => {
    const response = await fetch(server.url + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    })
    assert.ok(response.ok, path + " " + response.status)
    return response.status === 204 ? undefined : response.json()
  }
  await hidden()
}
const id = () =>
  "msg_" +
  ((BigInt(Date.now()) * 4096n) & 0xffffffffffffn).toString(16).padStart(12, "0") +
  randomUUID().replaceAll("-", "").slice(0, 14)
const prompt = (text, sessionID = chat.id) => ({
  id: id(),
  sessionID,
  directory,
  protocol: "v1",
  agent: "build",
  model: { providerID: "endurance-qa", modelID: "fixture" },
  text,
  legacyParts: [{ type: "text", text }],
})
const admit = (value) => call("runs.admit", { sessionID: value.sessionID, immediate: true, prompt: value })
const run = () => call("runs.get", { sessionID: chat.id })
const idle = (sessionID) =>
  eventually(async () => {
    const state = await call("runs.get", { sessionID })
    return !state.awaiting && !state.queue.length && (await engine("/session/status"))[sessionID]?.type !== "busy"
  }, "Endurance chat failed to become idle")
async function sample(cycle) {
  await hidden()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("HeapProfiler.collectGarbage")
  const heap = (await cdp.send("Runtime.getHeapUsage")).usedSize
  await cdp.detach()
  const native = await app.evaluate(({ app, BrowserWindow, webContents }) => ({
    windows: BrowserWindow.getAllWindows().length,
    webContents: webContents.getAllWebContents().length,
    metrics: app.getAppMetrics().map((row) => ({ type: row.type, workingSetKB: row.memory?.workingSetSize })),
  }))
  report.samples.push({ cycle, elapsedMs: performance.now() - started, heapBytes: heap, native })
  assert.equal(native.windows, 1)
  assert.equal(native.webContents, 1)
  assert.equal((await engine("/pty")).length, 0)
}
try {
  await launch()
  chat = await engine("/session", "POST", { title: "Owned two-hour admission endurance" })
  await call("access.set", { sessionID: chat.id, mode: "full" })
  await sample(0)
  for (let cycle = 1; performance.now() - started < seconds * 1000; cycle++) {
    const cycleStart = performance.now()
    const original = prompt(`held-${cycle}: original request`)
    const held = { entered: false, release: Promise.withResolvers() }
    holds.set(`held-${cycle}:`, held)
    await admit(original)
    await eventually(() => held.entered, "Original stream did not begin")
    const queued = prompt(`queued-${cycle}: pending input`),
      steering = prompt(`steer-${cycle}: safe-boundary intervention`)
    await admit(queued)
    if (cycle % 3 === 0) {
      await call("runs.edit", { sessionID: chat.id, id: queued.id })
      const edited = prompt(`queued-${cycle}: edited reserved input`)
      const result = await admit(edited)
      assert.equal(result.id, queued.id)
      queued.text = edited.text
    }
    await admit(steering)
    await call("runs.steer", { sessionID: chat.id, id: steering.id })
    await eventually(
      async () => (await engine(`/session/${chat.id}/message`)).some((row) => row.info.id === steering.id),
      "Steer did not reach durable history",
    )
    if (cycle % 5 === 0) {
      const child = await call("side.open", { parentID: chat.id, ownerID: "endurance-owner", directory })
      assert.equal((await engine(`/session/${child.id}/message`)).length, 0)
      assert.equal((await call("runs.get", { sessionID: child.id })).goal, undefined)
      await admit(prompt(`diagnostic-progress-${cycle}: report current parent progress`, child.id))
      await idle(child.id)
      assert.ok(
        (await engine(`/session/${child.id}/message`))
          .flatMap((row) => row.parts)
          .some((part) => part.type === "tool" && part.tool === "parent_progress" && part.state.status === "completed"),
      )
      assert.equal((await engine("/session/status"))[chat.id]?.type, "busy")
      await call("side.close", { sessionID: child.id, ownerID: "endurance-owner" })
      assert.ok((await engine(`/session/${child.id}`)).time.archived)
    }
    await call("runs.stop", { sessionID: chat.id })
    held.release.resolve()
    holds.delete(`held-${cycle}:`)
    await eventually(async () => (await engine("/session/status"))[chat.id]?.type !== "busy", "Stop did not finalize")
    assert.ok((await run()).paused)
    if (cycle % 10 === 0) {
      const saved = (await run()).queue.map((row) => row.id)
      await app.close()
      app = undefined
      await launch()
      report.restarts++
      const recovered = await run()
      assert.equal(recovered.paused, true)
      assert.deepEqual(
        recovered.queue.map((row) => row.id),
        saved,
      )
      const count = report.providerRequests
      await delay(500)
      assert.equal(report.providerRequests, count, "Recovered queue started without explicit Resume")
      await call("runs.resume", { sessionID: chat.id })
    }
    const after = prompt(`after-stop-${cycle}: new input`)
    await admit(after)
    await idle(chat.id)
    const messages = await engine(`/session/${chat.id}/message`)
    assert.equal(new Set(messages.map((row) => row.info.id)).size, messages.length)
    for (const expected of [original, queued, steering, after])
      assert.equal(
        messages.filter((row) => row.info.role === "user" && row.info.id === expected.id).length,
        1,
        "Admission identity changed or duplicated",
      )
    if (cycle % 10 === 0) {
      await admit(prompt(`required-question-${cycle}`))
      await eventually(
        async () => (await engine("/question")).some((row) => row.sessionID === chat.id),
        "Required question did not appear",
      )
      await call("runs.stop", { sessionID: chat.id })
      assert.ok(!(await engine("/question")).some((row) => row.sessionID === chat.id))
      await admit(prompt(`after-question-stop-${cycle}`))
      await idle(chat.id)
    }
    report.cycles.push({
      cycle,
      elapsedMs: performance.now() - started,
      messageCount: (await engine(`/session/${chat.id}/message`)).length,
    })
    if (cycle % 5 === 0) await sample(cycle)
    assert.equal(report.errors.length, 0, report.errors.join("\n"))
    await save()
    console.log("PASS endurance cycle", cycle, "elapsed seconds", Math.round((performance.now() - started) / 1000))
    const rest = Math.min(
      interval * 1000 - (performance.now() - cycleStart),
      seconds * 1000 - (performance.now() - started),
    )
    if (rest > 0) await delay(rest)
  }
  await sample(report.cycles.length)
  report.complete = true
} catch (error) {
  report.failure = error.stack || String(error)
  if (chat && call && engine) {
    const diagnostic = await Promise.allSettled([
      call("runs.get", { sessionID: chat.id }),
      engine("/session/status"),
      engine("/question"),
      engine("/permission"),
      engine(`/session/${chat.id}/message`),
    ])
    report.failureState = Object.fromEntries(
      ["run", "status", "questions", "permissions", "messages"].map((name, index) => [
        name,
        diagnostic[index].status === "fulfilled" ? diagnostic[index].value : String(diagnostic[index].reason),
      ]),
    )
  }
  process.exitCode = 1
  console.error("FAIL", String(error))
} finally {
  for (const value of holds.values()) value.release.resolve()
  await save()
  await app?.close()
  fixture.closeAllConnections()
  fixture.close()
  console.log(
    JSON.stringify({
      cycles: report.cycles.length,
      restarts: report.restarts,
      elapsedMs: performance.now() - started,
      failure: report.failure,
    }),
  )
}
