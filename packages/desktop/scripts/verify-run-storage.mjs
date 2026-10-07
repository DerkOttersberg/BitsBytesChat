import assert from "node:assert/strict"
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

assert.ok(process.env.BB_RUNS_MODULE, "Set BB_RUNS_MODULE to the captured run module")
assert.ok(process.execArgv.includes("--unhandled-rejections=strict"), "Run Node with strict unhandled rejections")
const checkout = resolve("../.."),
  scratch = join(checkout, ".tools/qa")
const modulePath = resolve(process.env.BB_RUNS_MODULE)
const { BBRuns } = await import(pathToFileURL(modulePath).href)
const report = { module: modulePath, strictUnhandledRejections: true, checks: [] }

for (const phase of ["before", "after"]) {
  const root = join(scratch, "background-storage-" + randomUUID())
  const temporary = join(root, "chat-runs.json.tmp")
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers()
  const state = { busy: false, messages: [] },
    sent = [],
    notifications = []
  let durable = ""
  const runs = new BBRuns(
    root,
    async () => {
      entered.resolve()
      await release.promise
      return structuredClone(state)
    },
    async (prompt) => {
      sent.push(structuredClone(prompt))
      state.messages.push({ id: prompt.id, text: prompt.text, tokens: 0, tools: 0 })
      if (phase === "after" && sent.length === 1) {
        durable = await readFile(join(root, "chat-runs.json"), "utf8")
        await mkdir(temporary)
      }
    },
    (id) => notifications.push(id),
  )
  const prompt = {
    sessionID: "ses_storage",
    directory: root,
    id: "msg_saved",
    text: "Complete frozen source 🌿 ".repeat(6000),
    files: [{ uri: "bitsbytes://transcript/frozen?revision=2" }],
  }
  async function until(condition, label) {
    for (let index = 0; index < 200; index++) {
      if (condition()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw Error(label)
  }
  try {
    await runs.start()
    runs.close()
    await runs.call("admit", { prompt })
    await entered.promise
    durable = await readFile(join(root, "chat-runs.json"), "utf8")
    if (phase === "before") await mkdir(temporary)
    release.resolve()
    await until(() => runs.get(prompt.sessionID).paused, "Background write failure did not pause")
    const chat = runs.get(prompt.sessionID)
    assert.equal(chat.awaiting, false)
    assert.equal(chat.queue[0].status, phase === "before" ? "failed" : "uncertain")
    assert.equal(typeof chat.queue[0].sentAt, phase === "before" ? "undefined" : "number")
    assert.equal(chat.queue[0].prompt.text, prompt.text)
    assert.deepEqual(chat.queue[0].prompt.files, prompt.files)
    assert.match(chat.error, /chat-runs\.json\.tmp/)
    assert.equal(await readFile(join(root, "chat-runs.json"), "utf8"), durable)
    const beforeRecovery = sent.length
    assert.equal(beforeRecovery, phase === "before" ? 0 : 1)
    await runs.pump(prompt.sessionID)
    assert.equal(sent.length, beforeRecovery)
    await rmdir(temporary)
    await runs.call("resume", { sessionID: prompt.sessionID })
    await until(() => sent.length === 1, "Recovery did not deliver its original ID")
    for (let index = 0; index < 100 && chat.queue.length; index++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      await runs.pump(prompt.sessionID)
    }
    assert.equal(chat.queue.length, 0)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].id, prompt.id)
    assert.equal(sent[0].text, prompt.text)
    assert.deepEqual(sent[0].files, prompt.files)
    await runs.call("stop", { sessionID: prompt.sessionID })
    const recovered = JSON.parse(await readFile(join(root, "chat-runs.json"), "utf8"))[prompt.sessionID]
    assert.equal(recovered.queue.length, 0)
    assert.equal(recovered.last.text, prompt.text)
    report.checks.push({
      phase,
      providerAdmissionsBeforeRecovery: beforeRecovery,
      totalAdmissions: sent.length,
      exactSourceCharacters: prompt.text.length,
      notifications: notifications.length,
    })
    console.log("PASS", phase, "background write failure and explicit recovery")
  } finally {
    release.resolve()
    runs.close()
    const path = relative(scratch, root)
    assert.ok(
      path && !path.startsWith("..") && !path.includes(":"),
      "Cleanup must remain inside owned QA scratch space",
    )
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
}
await writeFile(
  join(scratch, "results", process.env.BB_RUN_STORAGE_REPORT || "run-storage-strict.json"),
  JSON.stringify(report, null, 2),
)
