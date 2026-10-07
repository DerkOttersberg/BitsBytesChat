import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { BBRuns, UnsentError, type Inspection, type InspectionOptions, type RunPrompt } from "./bitsbytes-runs"
import { proposedPlan } from "@opencode-ai/core/util/proposed-plan"
import { ascending } from "@opencode-ai/core/id/id"

const fixtures: { runs: BBRuns; folder: string }[] = []
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "bb-runs-test-"))
  const state: Inspection = { busy: true, messages: [] }
  const sent: RunPrompt[] = []
  const inspections: (InspectionOptions | undefined)[] = []
  const fail = { enabled: false, unsent: false }
  const runs = new BBRuns(folder, async (_prompt, options) => { inspections.push(options); return structuredClone(state) }, async prompt => { if (fail.unsent) throw new UnsentError("preparation failed before admission"); sent.push(structuredClone(prompt)); state.messages.push({ id: prompt.id, text: prompt.text, tools: 0, tokens: 0 }); state.busy = true; if (fail.enabled) throw new Error("connection lost after admission") }, () => undefined)
  fixtures.push({ runs, folder }); await runs.start()
  const prompt = (id = "msg_000000000001a", text = "Complete source") => ({ sessionID: "ses_test", directory: folder, id, text, model: { providerID: "test", modelID: "test" }, legacyParts: [{ type: "text", text }] })
  const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 5)); if (!runs.get("ses_test").queue.some(item => item.status === "sending")) break } }
  return { runs, folder, state, sent, fail, prompt, settle, inspections }
}
afterEach(async () => { for (const fixture of fixtures.splice(0)) { fixture.runs.close(); const path = resolve(fixture.folder); if (!path.startsWith(resolve(tmpdir()) + "\\bb-runs-test-") && !path.startsWith(resolve(tmpdir()) + "/bb-runs-test-")) throw new Error("Unexpected cleanup path"); await rm(path, { recursive: true, force: true }) } })

async function stoppedGoalFixture(stop = true) {
  const f = await fixture()
  f.runs.close(); f.state.busy = false
  f.state.messages.push({ id: ascending("message"), assistant: true, text: "Prior work", tokens: 5, tools: 1, progress: "prior" })
  const reach = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 50 && !condition(); attempt++) { await f.runs.pump("ses_test"); await Bun.sleep(2) }
    expect(condition()).toBe(true)
  }
  const original = { ...f.prompt(ascending("message"), "Complete the saved objective 🌿"), protocol: "v1" as const }
  await f.runs.call("goal-draft", { sessionID: "ses_test", enabled: true })
  await f.runs.call("admit", { prompt: original, budget: 1000 })
  await reach(() => f.sent.length === 1 && !f.runs.get("ses_test").queue.length)
  const canceled: Inspection["messages"][number] = { id: ascending("message"), parentID: original.id, created: Date.now() - 10, assistant: true, text: "", tokens: 7, tools: 0, aborted: true, error: '{"name":"MessageAbortedError","data":{"message":"Aborted"}}' }
  if (stop) await f.runs.call("stop", { sessionID: "ses_test" })
  return { ...f, original, canceled, reach, chat: f.runs.get("ses_test") }
}

test("queue survives renderer absence, retains full context and waits for idle", async () => {
  const f = await fixture()
  const source = "Nederlandse bron. ".repeat(12000)
  await f.runs.call("admit", { prompt: { ...f.prompt(), text: source, draft: { transcript: "bitsbytes://transcript/id?revision=3", skill: "bitsbytes://skill/bb-documents?revision=1" } } })
  expect(f.sent).toHaveLength(0)
  expect((await readFile(join(f.folder, "chat-runs.json"), "utf8"))).toContain(source)
  f.state.busy = false; await f.runs.pump("ses_test"); await f.settle()
  expect(f.sent).toHaveLength(1)
  await f.runs.pump("ses_test")
  expect(f.runs.get("ses_test").queue).toHaveLength(0)
})

test("Plan and Goal panel reads retain complete revisions without sending frozen prompts or changing the journal", async () => {
  const f = await fixture()
  f.runs.close()
  await f.runs.call("stop", { sessionID: "ses_test" })
  const source = "Complete frozen source 🌿 ".repeat(6000)
  const prompt = { ...f.prompt("msg_panel", source), draft: { attachments: [{ source }] } }
  await f.runs.call("admit", { prompt })
  await f.runs.call("prepare", { prompt })
  await f.runs.call("plan", { sessionID: "ses_test", text: "First Plan" })
  await f.runs.call("plan", { sessionID: "ses_test", text: "Latest Plan" })
  const run = f.runs.get("ses_test")
  run.goal = { id: "goal_panel", objective: "Keep exact source", status: "paused", reason: "stopped", evidence: "Recorded evidence", started: 1, elapsed: 2, tokens: 3, budget: 100, continuations: 0 }
  await f.runs.call("stop", { sessionID: "ses_test" })
  const journal = await readFile(join(f.folder, "chat-runs.json"), "utf8")
  const inspected = f.inspections.length
  const panel = await f.runs.call("panel", { sessionID: "ses_test" })
  expect(panel).toEqual({ goal: run.goal, plan: run.plan })
  expect(Object.keys(panel)).toEqual(["goal", "plan"])
  expect(JSON.stringify(panel)).not.toContain(source)
  expect(JSON.stringify(panel).length).toBeLessThan(1000)
  expect(await readFile(join(f.folder, "chat-runs.json"), "utf8")).toBe(journal)
  expect(f.inspections).toHaveLength(inspected)
  expect(f.sent).toHaveLength(0)
  expect(await f.runs.call("get", { sessionID: "ses_test" })).toMatchObject({ queue: [{ prompt }], last: prompt })
  expect(run.plan?.versions).toEqual([{ revision: 1, text: "First Plan" }, { revision: 2, text: "Latest Plan" }])
})

test("a repeated admission cannot acknowledge an unsaved request after a journal failure", async () => {
  const f = await fixture()
  f.runs.close(); f.runs.get("ses_test").paused = true
  const path = join(f.folder, "chat-runs.json")
  await rm(path); await mkdir(path)
  const input = { prompt: f.prompt("msg_unsaved", "Retain this exact frozen source") }
  await expect(f.runs.call("admit", input)).rejects.toThrow()
  await expect(f.runs.call("admit", input)).rejects.toThrow()
  expect(f.sent).toHaveLength(0)
  await rmdir(path)
  await f.runs.call("admit", input)
  const saved = JSON.parse(await readFile(path, "utf8")).ses_test
  expect(saved.queue).toHaveLength(1)
  expect(saved.queue[0].prompt).toMatchObject(input.prompt)
  expect(saved.queue[0].status).toBe("pending")
})

test("a concurrent repeated admission waits for its request to reach the journal", async () => {
  const f = await fixture()
  f.runs.close(); f.runs.get("ses_test").paused = true
  const input = { prompt: f.prompt("msg_repeated", "Frozen request") }
  const first = f.runs.call("admit", input)
  try {
    await f.runs.call("admit", input)
    const saved = JSON.parse(await readFile(join(f.folder, "chat-runs.json"), "utf8")).ses_test
    expect(saved?.queue[0]?.prompt).toMatchObject(input.prompt)
    expect(f.sent).toHaveLength(0)
  } finally { await first }
})

test("Stop during engine inspection keeps the queued request paused until Resume", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bb-runs-test-"))
  const entered = Promise.withResolvers<void>()
  const inspection = Promise.withResolvers<Inspection>()
  const sent: string[] = []
  const runs = new BBRuns(folder, async () => { entered.resolve(); return inspection.promise }, async prompt => { sent.push(prompt.id) }, () => undefined)
  fixtures.push({ runs, folder }); await runs.start()
  runs.get("ses_test").paused = true
  await runs.call("admit", { prompt: { sessionID: "ses_test", directory: folder, id: "msg_stopped", text: "Wait for Resume" } })
  runs.get("ses_test").paused = false
  const pumping = runs.pump("ses_test")
  await entered.promise
  await runs.call("stop", { sessionID: "ses_test" })
  inspection.resolve({ busy: false, messages: [] })
  await pumping
  expect(sent).toEqual([])
  expect(runs.get("ses_test").queue[0].status).toBe("pending")
  expect(runs.get("ses_test").paused).toBe(true)
  await runs.pump("ses_test")
  expect(sent).toEqual([])
  await runs.call("resume", { sessionID: "ses_test" })
  for (let i = 0; i < 100 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(sent).toEqual(["msg_stopped"])
  await new Promise(resolve => setTimeout(resolve, 20))
})

test("Stop releases host waiting after admission is confirmed and its queue is empty", async () => {
  const f = await fixture()
  f.runs.close(); f.runs.get("ses_test").paused = true
  await f.runs.call("admit", { prompt: f.prompt("msg_confirmed") })
  f.runs.get("ses_test").paused = false; f.state.busy = false
  await f.runs.pump("ses_test"); await f.runs.pump("ses_test")
  expect(f.runs.get("ses_test").queue).toHaveLength(0)
  expect(f.runs.get("ses_test").awaiting).toBe(true)
  await f.runs.call("stop", { sessionID: "ses_test" })
  expect(f.runs.get("ses_test").awaiting).toBe(false)
  expect(JSON.parse(await readFile(join(f.folder, "chat-runs.json"), "utf8")).ses_test.awaiting).toBe(false)
  expect(f.sent).toHaveLength(1)
})

test("Delete during engine inspection cannot dispatch the removed request", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bb-runs-test-"))
  const entered = Promise.withResolvers<void>()
  const inspection = Promise.withResolvers<Inspection>()
  const sent: string[] = []
  const runs = new BBRuns(folder, async () => { entered.resolve(); return inspection.promise }, async prompt => { sent.push(prompt.id) }, () => undefined)
  fixtures.push({ runs, folder }); await runs.start()
  runs.get("ses_test").paused = true
  await runs.call("admit", { prompt: { sessionID: "ses_test", directory: folder, id: "msg_deleted", text: "Remove this request" } })
  runs.get("ses_test").paused = false
  const pumping = runs.pump("ses_test")
  await entered.promise
  await runs.call("delete", { sessionID: "ses_test", id: "msg_deleted" })
  inspection.resolve({ busy: false, messages: [] })
  await pumping
  expect(sent).toEqual([])
  expect(runs.get("ses_test").queue).toHaveLength(0)
  expect(JSON.parse(await readFile(join(folder, "chat-runs.json"), "utf8")).ses_test.queue).toEqual([])
})

test.each(["first", "retry"])("Stop while %s admission is being journalled preserves its delivery history", async attempt => {
  const folder = await mkdtemp(join(tmpdir(), "bb-runs-test-"))
  const entered = Promise.withResolvers<void>()
  const inspection = Promise.withResolvers<Inspection>()
  const sent: string[] = []
  const runs = new BBRuns(folder, async () => { entered.resolve(); return inspection.promise }, async prompt => { sent.push(prompt.id) }, () => undefined)
  fixtures.push({ runs, folder }); await runs.start()
  runs.get("ses_test").paused = true
  await runs.call("admit", { prompt: { sessionID: "ses_test", directory: folder, id: "msg_journalled", text: "Keep this unsent" } })
  if (attempt === "retry") { runs.get("ses_test").queue[0].sentAt = 12345; runs.get("ses_test").queue[0].error = "bb.error.deliveryUnknown" }
  runs.get("ses_test").paused = false
  const pumping = runs.pump("ses_test")
  await entered.promise
  inspection.resolve({ busy: false, messages: [] })
  for (let i = 0; i < 20 && runs.get("ses_test").queue[0].status !== "sending"; i++) await Promise.resolve()
  expect(runs.get("ses_test").queue[0].status).toBe("sending")
  await runs.call("stop", { sessionID: "ses_test" })
  await pumping
  expect(sent).toEqual([])
  expect(runs.get("ses_test").awaiting).toBe(false)
  expect(runs.get("ses_test").queue[0].status).toBe(attempt === "retry" ? "uncertain" : "pending")
  expect(runs.get("ses_test").queue[0].sentAt).toBe(attempt === "retry" ? 12345 : undefined)
  const saved = JSON.parse(await readFile(join(folder, "chat-runs.json"), "utf8")).ses_test
  expect(saved.paused).toBe(true)
  expect(saved.queue[0].status).toBe(attempt === "retry" ? "uncertain" : "pending")
  expect(saved.queue[0].sentAt).toBe(attempt === "retry" ? 12345 : undefined)
})

test("historical failed requests with a send timestamp still reconcile against engine history", async () => {
  const f = await fixture()
  f.runs.close(); f.runs.get("ses_test").paused = true
  await f.runs.call("admit", { prompt: f.prompt("msg_old_failed") })
  const item = f.runs.get("ses_test").queue[0]
  item.status = "failed"; item.sentAt = 12345
  f.state.messages.push({ id: item.id, text: item.prompt.text, tokens: 0, tools: 0 })
  f.runs.get("ses_test").paused = false
  await f.runs.pump("ses_test")
  expect(f.runs.get("ses_test").queue).toHaveLength(0)
  expect(f.inspections.at(-1)?.readBusyMessages).toBe(true)
  expect(f.sent).toEqual([])
})

test("Stop cancels only its chat's in-progress prompt preparation", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bb-runs-test-"))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const signals = new Map<string, AbortSignal | undefined>()
  const runs = new BBRuns(folder, async () => ({ busy: false, messages: [] }), async (prompt, signal?: AbortSignal) => {
    signals.set(prompt.sessionID, signal)
    if (signals.size === 2) entered.resolve()
    await release.promise
  }, () => undefined)
  fixtures.push({ runs, folder }); await runs.start(); runs.close()
  for (const id of ["ses_a", "ses_b"]) runs.get(id).paused = true
  await Promise.all(["ses_a", "ses_b"].map(sessionID => runs.call("admit", { prompt: { sessionID, directory: folder, id: "msg_" + sessionID, text: "Wait during preparation" } })))
  for (const id of ["ses_a", "ses_b"]) runs.get(id).paused = false
  const pumping = Promise.all([runs.pump("ses_a"), runs.pump("ses_b")])
  try {
    await entered.promise
    await runs.call("stop", { sessionID: "ses_a" })
    expect(signals.get("ses_a")?.aborted).toBe(true)
    expect(signals.get("ses_b")?.aborted).toBe(false)
  } finally {
    release.resolve()
    await pumping
  }
})

test.each(["replace", "reorder"])("queue %s during engine inspection invalidates the stale candidate", async action => {
  const folder = await mkdtemp(join(tmpdir(), "bb-runs-test-"))
  const entered = Promise.withResolvers<void>()
  const inspection = Promise.withResolvers<Inspection>()
  const sent: string[] = []
  const runs = new BBRuns(folder, async () => { entered.resolve(); return inspection.promise }, async prompt => { sent.push(prompt.text) }, () => undefined)
  fixtures.push({ runs, folder }); await runs.start()
  runs.get("ses_test").paused = true
  await runs.call("admit", { prompt: { sessionID: "ses_test", directory: folder, id: "msg_first", text: "Original request" } })
  await runs.call("admit", { prompt: { sessionID: "ses_test", directory: folder, id: "msg_second", text: "Second request" } })
  runs.get("ses_test").paused = false
  const pumping = runs.pump("ses_test")
  await entered.promise
  if (action === "replace") {
    await runs.call("edit", { sessionID: "ses_test", id: "msg_first" })
    await runs.call("admit", { prompt: { sessionID: "ses_test", directory: folder, id: "msg_new", text: "Corrected request" } })
  }
  if (action === "reorder") await runs.call("reorder", { sessionID: "ses_test", ids: ["msg_second", "msg_first"] })
  inspection.resolve({ busy: false, messages: [] })
  await pumping
  expect(sent).toEqual([])
  await runs.pump("ses_test")
  expect(sent).toEqual([action === "replace" ? "Corrected request" : "Second request"])
})
test("Steer reaches an active engine and exact uncertain admission reconciles without duplicate", async () => {
  const f = await fixture(); f.fail.enabled = true
  await f.runs.call("admit", { delivery: "steer", prompt: f.prompt() }); await f.settle()
  expect(f.sent).toHaveLength(1); expect(f.sent[0].delivery).toBe("steer")
  // The dispatch catch persists its uncertainty before releasing the active
  // pump. Wait for that reconciliation, rather than racing its journal write.
  for (let i = 0; i < 100 && f.runs.get("ses_test").queue.length; i++) {
    await f.runs.pump("ses_test"); await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(f.runs.get("ses_test").queue).toHaveLength(0); expect(f.sent).toHaveLength(1)
  expect(f.runs.get("ses_test").error).toBe("")
})
test("a rejected dispatch stops waiting and retains the request for recovery", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bb-runs-test-"))
  const runs = new BBRuns(folder, async () => ({ busy: false, messages: [] }), async () => { throw new Error("Missing transcript revision") }, () => undefined)
  fixtures.push({ runs, folder }); await runs.start()
  await runs.call("admit", { prompt: { sessionID: "ses_test", directory: folder, id: "msg_rejected", text: "Use the recording" } })
  for (let i = 0; i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 5)); if (runs.get("ses_test").queue[0]?.status === "uncertain") break }
  expect(runs.get("ses_test").awaiting).toBe(false)
  expect(runs.get("ses_test").queue[0].status).toBe("uncertain")
  expect(runs.get("ses_test").queue[0].prompt.text).toBe("Use the recording")
  expect(runs.get("ses_test").error).toContain("Missing transcript revision")
  await runs.call("delete", { sessionID: "ses_test", id: "msg_rejected" })
  expect(runs.get("ses_test").error).toBe("")
})
test("an unprojected idle admission times out visibly without replaying the request", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bb-runs-test-"))
  const state: Inspection = { busy: false, messages: [] }
  const sent: string[] = []
  const runs = new BBRuns(folder, async () => structuredClone(state), async prompt => { sent.push(prompt.id) }, () => undefined)
  fixtures.push({ runs, folder }); await runs.start()
  await runs.call("admit", { prompt: { sessionID: "ses_test", directory: folder, id: "msg_unprojected", text: "Retain this request" } })
  for (let i = 0; i < 100; i++) { await new Promise(resolve => setTimeout(resolve, 20)); if (sent.length === 1) break }
  expect(sent).toEqual(["msg_unprojected"])
  runs.get("ses_test").queue[0].sentAt = Date.now() - 31000
  // Sending is visible before its journal write/dispatch finishes. Advisory
  // pumps can coalesce with that active operation; wait for the public transition.
  for (let i = 0; i < 100; i++) {
    await runs.pump("ses_test")
    if (runs.get("ses_test").queue[0]?.status === "uncertain") break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(runs.get("ses_test").awaiting).toBe(false)
  expect(runs.get("ses_test").queue[0].status).toBe("uncertain")
  expect(runs.get("ses_test").error).toBe("bb.error.deliveryUnknown")
  await runs.pump("ses_test")
  expect(sent).toEqual(["msg_unprojected"])
  state.messages.push({ id: "msg_unprojected", text: "Retain this request", tokens: 0, tools: 0 })
  for (let i = 0; i < 100; i++) {
    await runs.pump("ses_test")
    if (!runs.get("ses_test").queue.length) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(runs.get("ses_test").queue).toHaveLength(0)
  expect(runs.get("ses_test").error).toBe("")
  expect(sent).toEqual(["msg_unprojected"])
})
test("edit retains original until save and ordering/delete persist", async () => {
  const f = await fixture()
  await f.runs.call("admit", { prompt: f.prompt("msg_a", "original") })
  await f.runs.call("admit", { prompt: f.prompt("msg_b", "second") })
  await f.runs.call("edit", { sessionID: "ses_test", id: "msg_a" })
  expect(f.runs.get("ses_test").queue[0].prompt.text).toBe("original")
  await f.runs.call("admit", { prompt: f.prompt("msg_new", "corrected") })
  expect(f.runs.get("ses_test").queue[0].id).toBe("msg_a")
  expect(f.runs.get("ses_test").queue[0].prompt.text).toBe("corrected")
  await f.runs.call("reorder", { sessionID: "ses_test", ids: ["msg_b", "msg_a"] })
  await f.runs.call("delete", { sessionID: "ses_test", id: "msg_b" })
  expect(f.runs.get("ses_test").queue.map(item => item.id)).toEqual(["msg_a"])
})
test("switching queued edits replaces only the selected original and stale Cancel cannot cancel another edit", async () => {
  const f = await fixture()
  f.runs.close()
  await f.runs.call("admit", { prompt: f.prompt("msg_a", "First exact source 🌿") })
  await f.runs.call("admit", { prompt: { ...f.prompt("msg_b", "Second exact source 🌿"), files: [{ uri: "bitsbytes://transcript/frozen?revision=3" }] } })
  const first = structuredClone(f.runs.get("ses_test").queue[0].prompt)
  await f.runs.call("edit", { sessionID: "ses_test", id: "msg_a" })
  await f.runs.call("edit", { sessionID: "ses_test", id: "msg_b" })
  expect(f.runs.get("ses_test").queue.filter(item => item.editing).map(item => item.id)).toEqual(["msg_b"])
  await f.runs.call("cancel-edit", { sessionID: "ses_test", id: "msg_a" })
  expect(f.runs.get("ses_test").queue.filter(item => item.editing).map(item => item.id)).toEqual(["msg_b"])
  await f.runs.call("admit", { prompt: f.prompt("msg_replacement", "Edited second source 🌿") })
  const queue = f.runs.get("ses_test").queue
  expect(queue.map(item => item.id)).toEqual(["msg_a", "msg_b"])
  expect(queue[0].prompt).toEqual(first)
  expect(queue[1].prompt.text).toBe("Edited second source 🌿")
  expect(queue.filter(item => item.editing)).toHaveLength(0)
  await f.runs.call("edit", { sessionID: "ses_test", id: "msg_a" })
  await f.runs.call("cancel-edit", { sessionID: "ses_test", id: "msg_a" })
  expect(queue[0].prompt).toEqual(first)
  expect(queue.filter(item => item.editing)).toHaveLength(0)
  expect(JSON.parse(await readFile(join(f.folder, "chat-runs.json"), "utf8")).ses_test.queue).toEqual(queue)
  expect(f.sent).toHaveLength(0)
})

test("recovery keeps one edited row and both exact sources from an older multi-edit journal", async () => {
  const f = await fixture()
  f.runs.close()
  await f.runs.call("admit", { prompt: f.prompt("msg_a", "Original A 🌿") })
  await f.runs.call("admit", { prompt: f.prompt("msg_b", "Original B 🌿") })
  const stored = JSON.parse(await readFile(join(f.folder, "chat-runs.json"), "utf8"))
  for (const item of stored.ses_test.queue) item.editing = true
  stored.ses_test.queue[1].dismissGoalID = { damaged: true }
  const source = JSON.stringify(stored)
  await writeFile(join(f.folder, "chat-runs.json"), source)
  const restored = new BBRuns(f.folder, async () => f.state, async () => { throw new Error("Recovered work must stay paused") }, () => undefined)
  fixtures.push({ runs: restored, folder: f.folder })
  await restored.start()
  const queue = restored.get("ses_test").queue
  expect(queue.map(item => item.prompt.text)).toEqual(["Original A 🌿", "Original B 🌿"])
  expect(queue.filter(item => item.editing).map(item => item.id)).toEqual(["msg_a"])
  expect(queue[1].dismissGoalID).toBeUndefined()
  expect(restored.get("ses_test").paused).toBe(true)
  const backup = (await readdir(f.folder)).find(name => name.startsWith("chat-runs-recovery-"))
  expect(backup).toBeDefined()
  expect(await readFile(join(f.folder, backup!), "utf8")).toBe(source)
})

test("restart pauses saved work and preserves mode/model snapshots", async () => {
  const f = await fixture()
  await f.runs.call("mode", { sessionID: "ses_test", mode: "plan" })
  await f.runs.call("admit", { prompt: f.prompt() })
  await f.runs.call("mode", { sessionID: "ses_test", mode: "normal" })
  f.runs.close()
  const restored = new BBRuns(f.folder, async () => f.state, async () => { throw new Error("restart must not dispatch") }, () => undefined)
  fixtures.push({ runs: restored, folder: f.folder }); await restored.start()
  expect(restored.get("ses_test").paused).toBe(true)
  expect(restored.get("ses_test").queue[0].prompt.agent).toBe("plan")
  expect(restored.get("ses_test").queue[0].prompt.model?.modelID).toBe("test")
})
test("approved plan implementation uses exact revision and retains a compact visible request", async () => {
  const f = await fixture()
  await f.runs.call("prepare", { prompt: f.prompt() })
  await f.runs.call("plan", { sessionID: "ses_test", text: "Original plan" })
  await f.runs.call("plan", { sessionID: "ses_test", text: "Edited plan" })
  await f.runs.call("implement", { sessionID: "ses_test", revision: 1 })
  expect(f.runs.get("ses_test").queue[0].prompt.text).toContain("Original plan")
  expect(f.runs.get("ses_test").queue[0].prompt.text).not.toContain("Edited plan")
  expect(f.runs.get("ses_test").queue[0].prompt.mode).toBe("normal")
})
test("goal replacement needs confirmation, completion evidence and Stop pauses both", async () => {
  const f = await fixture()
  await f.runs.call("goal-draft", { sessionID: "ses_test", enabled: true })
  await f.runs.call("admit", { prompt: f.prompt() })
  await expect(f.runs.call("goal-progress", { sessionID: "ses_test", status: "complete" })).rejects.toThrow("goalEvidence")
  await f.runs.call("stop", { sessionID: "ses_test" })
  expect(f.runs.get("ses_test").goal?.status).toBe("paused")
  await f.runs.call("goal-draft", { sessionID: "ses_test", enabled: true })
  await expect(f.runs.call("admit", { prompt: f.prompt("msg_b") })).rejects.toThrow("goalExists")
  await f.runs.call("goal-draft", { sessionID: "ses_test", enabled: true, replace: true })
  await f.runs.call("admit", { prompt: f.prompt("msg_b", "New objective") })
  expect(f.runs.get("ses_test").goal?.objective).toBe("New objective")
  await f.runs.call("goal-progress", { sessionID: "ses_test", status: "complete", evidence: "Verified saved output" })
  expect(f.runs.get("ses_test").goal?.status).toBe("complete")
})

test("a new ordinary admission dismisses a completed Goal summary after delivery while retaining evidence", async () => {
  const f = await fixture()
  f.runs.close()
  f.runs.get("ses_test").goal = { id: "goal_complete", objective: "Verified objective", status: "complete", reason: "Done", evidence: "Exact saved validation 🌿", started: 1, elapsed: 2, tokens: 3, continuations: 0 }
  await f.runs.call("stop", { sessionID: "ses_test" })
  await f.runs.call("admit", { prompt: f.prompt("msg_next", "Next ordinary request") })
  expect(f.runs.get("ses_test").goal?.summaryDismissed).toBeUndefined()
  expect(f.runs.get("ses_test").queue[0].dismissGoalID).toBe("goal_complete")
  f.state.busy = false
  await f.runs.call("resume", { sessionID: "ses_test" })
  await f.settle()
  expect(f.sent.map(prompt => prompt.id)).toEqual(["msg_next"])
  expect(f.runs.get("ses_test").goal).toMatchObject({ status: "complete", summaryDismissed: true, evidence: "Exact saved validation 🌿" })
  expect(JSON.parse(await readFile(join(f.folder, "chat-runs.json"), "utf8")).ses_test.goal).toMatchObject({ status: "complete", summaryDismissed: true, evidence: "Exact saved validation 🌿" })
  const restored = new BBRuns(f.folder, async () => f.state, async () => { throw new Error("Restart must stay paused") }, () => undefined)
  fixtures.push({ runs: restored, folder: f.folder })
  await restored.start()
  expect(restored.get("ses_test").goal).toMatchObject({ status: "complete", summaryDismissed: true, evidence: "Exact saved validation 🌿" })
  expect((await readdir(f.folder)).filter(name => name.startsWith("chat-runs-recovery-"))).toHaveLength(0)
})

test.each(["failed", "uncertain"])("a %s ordinary send retains the completed Goal summary until a proven admission", async phase => {
  const f = await fixture()
  f.runs.close()
  f.runs.get("ses_test").goal = { id: "goal_complete", objective: "Verified objective", status: "complete", reason: "Done", evidence: "Retain completed evidence", started: 1, elapsed: 2, tokens: 3, continuations: 0 }
  f.fail.unsent = phase === "failed"
  f.fail.enabled = phase === "uncertain"
  f.state.busy = false
  await f.runs.call("admit", { prompt: f.prompt("msg_next", "Recoverable ordinary request") })
  await f.settle()
  expect(f.runs.get("ses_test").queue[0].status).toBe(phase)
  expect(f.runs.get("ses_test").goal?.summaryDismissed).toBeUndefined()
  expect(f.runs.get("ses_test").goal?.evidence).toBe("Retain completed evidence")
  if (phase === "uncertain") {
    const acknowledgement = f.state.messages[0]
    f.state.messages = []
    await f.runs.pump("ses_test")
    expect(f.runs.get("ses_test").goal?.summaryDismissed).toBeUndefined()
    f.state.messages.push(acknowledgement)
    // Delivery failure can become visible before its journal write finishes.
    // Wait for the late acknowledgement instead of racing the active pump.
    for (let attempt = 0; attempt < 50 && !f.runs.get("ses_test").goal?.summaryDismissed; attempt++) { await f.runs.pump("ses_test"); await Bun.sleep(2) }
    expect(f.sent).toHaveLength(1)
  } else {
    expect(f.sent).toHaveLength(0)
    f.fail.unsent = false
    await f.runs.call("resume", { sessionID: "ses_test" })
    await f.settle()
    expect(f.sent).toHaveLength(1)
  }
  expect(f.runs.get("ses_test").goal).toMatchObject({ summaryDismissed: true, evidence: "Retain completed evidence" })
})

test("an earlier queued request cannot dismiss a replacement Goal", async () => {
  const f = await fixture()
  f.runs.close()
  const chat = f.runs.get("ses_test")
  chat.goal = { id: "goal_old", objective: "Old completed objective", status: "complete", reason: "Done", evidence: "Original evidence", started: 1, elapsed: 2, tokens: 3, continuations: 0 }
  await f.runs.call("stop", { sessionID: "ses_test" })
  await f.runs.call("admit", { prompt: f.prompt("msg_next", "Queued after old Goal") })
  chat.goal = { ...chat.goal!, id: "goal_replacement", objective: "Replacement objective", evidence: "Replacement validation" }
  f.state.busy = false
  await f.runs.call("resume", { sessionID: "ses_test" })
  await f.settle()
  expect(f.sent.map(prompt => prompt.id)).toEqual(["msg_next"])
  expect(chat.goal).toMatchObject({ id: "goal_replacement", status: "complete", evidence: "Replacement validation" })
  expect(chat.goal?.summaryDismissed).toBeUndefined()
})

test("a damaged optional summary marker retains the valid Goal evidence during recovery", async () => {
  const f = await fixture()
  f.runs.close()
  f.runs.get("ses_test").goal = { id: "goal_complete", objective: "Verified objective", status: "complete", reason: "Done", evidence: "Retain exact validation 🌿", started: 1, elapsed: 2, tokens: 3, continuations: 0 }
  await f.runs.call("stop", { sessionID: "ses_test" })
  const stored = JSON.parse(await readFile(join(f.folder, "chat-runs.json"), "utf8"))
  stored.ses_test.goal.summaryDismissed = { damaged: true }
  const source = JSON.stringify(stored)
  await writeFile(join(f.folder, "chat-runs.json"), source)
  const restored = new BBRuns(f.folder, async () => f.state, async () => { throw new Error("Recovery cannot dispatch") }, () => undefined)
  fixtures.push({ runs: restored, folder: f.folder })
  await restored.start()
  expect(restored.get("ses_test").goal).toMatchObject({ id: "goal_complete", status: "complete", evidence: "Retain exact validation 🌿" })
  expect(restored.get("ses_test").goal?.summaryDismissed).toBeUndefined()
  const backup = (await readdir(f.folder)).find(name => name.startsWith("chat-runs-recovery-"))
  expect(backup).toBeDefined()
  expect(await readFile(join(f.folder, backup!), "utf8")).toBe(source)
})

test("the Goal's own completion and a rejected journal write cannot dismiss its summary", async () => {
  const f = await fixture()
  f.runs.close()
  f.state.busy = false
  await f.runs.call("goal-draft", { sessionID: "ses_test", enabled: true })
  await f.runs.call("admit", { prompt: f.prompt("msg_goal", "Complete the original goal") })
  await f.settle()
  await f.runs.call("goal-progress", { sessionID: "ses_test", status: "complete", evidence: "Original goal validated" })
  await f.settle()
  expect(f.runs.get("ses_test").goal?.summaryDismissed).toBeUndefined()
  const journal = await readFile(join(f.folder, "chat-runs.json"), "utf8")
  await mkdir(join(f.folder, "chat-runs.json.tmp"))
  await expect(f.runs.call("admit", { prompt: f.prompt("msg_failed_save", "Unacknowledged request") })).rejects.toThrow()
  expect(f.runs.get("ses_test").goal).toMatchObject({ evidence: "Original goal validated", status: "complete" })
  expect(f.runs.get("ses_test").goal?.summaryDismissed).toBeUndefined()
  expect(await readFile(join(f.folder, "chat-runs.json"), "utf8")).toBe(journal)
  expect(f.sent.map(prompt => prompt.id)).toEqual(["msg_goal"])
})

test("selected Plan, active Goal and reordered edited queue retain exact identities across Steer and Stop", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bb-runs-test-"))
  const state: Inspection = { busy: false, messages: [{ id: ascending("message"), assistant: true, text: "Prior work", tools: 1, tokens: 100, progress: "prior" }] }
  const sent: RunPrompt[] = []
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<Inspection>()
  const boundary = { hold: false }
  const runs = new BBRuns(folder, async () => {
    if (boundary.hold) { entered.resolve(); return release.promise }
    return structuredClone(state)
  }, async prompt => {
    sent.push(structuredClone(prompt))
    state.messages.push({ id: prompt.id, text: prompt.text, tools: 0, tokens: 0 })
    state.busy = true
  }, () => undefined)
  fixtures.push({ runs, folder })
  await runs.start(); runs.close()
  const prompt = (text: string): RunPrompt => ({ sessionID: "ses_stress", directory: folder, id: ascending("message"), text, model: { providerID: "fixture", modelID: "fixture" }, files: [{ uri: "bitsbytes://transcript/frozen?revision=3" }] })
  const reach = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 40 && !condition(); attempt++) { await runs.pump("ses_stress"); await new Promise(resolve => setTimeout(resolve, 2)) }
    expect(condition()).toBe(true)
  }
  const chat = runs.get("ses_stress")
  await runs.call("plan", { sessionID: chat.sessionID, text: "Selected revision one 🌿" })
  await runs.call("plan", { sessionID: chat.sessionID, text: "Latest revision two" })
  await runs.call("goal-draft", { sessionID: chat.sessionID, enabled: true })
  const original = prompt("Pursue the original Goal")
  await runs.call("admit", { prompt: original, budget: 10000 })
  await reach(() => sent.length === 1)
  await reach(() => !chat.queue.length)
  const goalID = chat.goal!.id
  await runs.call("implement", { sessionID: chat.sessionID, revision: 1 })
  const implementation = structuredClone(chat.queue[0].prompt)
  const first = prompt("Frozen queued A 🌿 ".repeat(1000)), second = prompt("Steered queued B")
  await runs.call("admit", { prompt: first })
  await runs.call("admit", { prompt: second })
  boundary.hold = true
  await runs.call("steer", { sessionID: chat.sessionID, id: second.id })
  await entered.promise
  const held = structuredClone(state)
  await runs.call("stop", { sessionID: chat.sessionID })
  await runs.call("edit", { sessionID: chat.sessionID, id: first.id })
  await runs.call("reorder", { sessionID: chat.sessionID, ids: [implementation.id, second.id, first.id] })
  boundary.hold = false
  release.resolve(held)
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(sent.map(item => item.id)).toEqual([original.id])
  expect(chat.paused).toBe(true)
  expect(chat.awaiting).toBe(false)
  expect(chat.goal).toMatchObject({ id: goalID, status: "paused", reason: "stopped", baseline: 100, budget: 10000 })
  expect(chat.queue.find(item => item.id === first.id)?.prompt).toMatchObject(first)
  await runs.call("resume", { sessionID: chat.sessionID })
  await reach(() => sent.length === 2)
  expect(sent[1]).toMatchObject({ id: second.id, delivery: "steer", files: second.files })
  await reach(() => !chat.queue.some(item => item.id === second.id))
  expect(chat.goal?.status).toBe("paused")
  state.busy = false
  state.messages.push({ id: ascending("message"), assistant: true, text: "Steering progress", tools: 1, tokens: 50, progress: "steered" })
  await reach(() => sent.length === 3)
  expect(sent[2]).toMatchObject({ id: implementation.id, mode: "normal", agent: "build", text: "PLEASE IMPLEMENT THIS PLAN:\nSelected revision one 🌿" })
  expect(sent[2].text).not.toContain("Latest revision two")
  await reach(() => !chat.queue.some(item => item.id === implementation.id))
  await runs.call("cancel-edit", { sessionID: chat.sessionID, id: first.id })
  state.busy = false
  state.messages.push({ id: ascending("message"), assistant: true, text: "Implemented selected source", tools: 1, tokens: 70, progress: "implemented" })
  await reach(() => sent.length === 4)
  expect(sent[3]).toMatchObject({ id: first.id, text: first.text, files: first.files })
  await reach(() => !chat.queue.length)
  state.busy = false
  state.messages.push({ id: ascending("message"), assistant: true, text: "Queued work verified", tools: 1, tokens: 90, progress: "queued" })
  await reach(() => chat.goal?.tokens === 210 && !chat.awaiting)
  expect(sent.map(item => item.id)).toEqual([original.id, second.id, implementation.id, first.id])
  expect(new Set(sent.map(item => item.id)).size).toBe(sent.length)
  expect(chat.goal).toMatchObject({ id: goalID, objective: original.text, status: "paused", reason: "stopped", tokens: 210, continuations: 0, budget: 10000 })
  expect(chat.plan).toMatchObject({ revision: 2, text: "Latest revision two", versions: [{ revision: 1, text: "Selected revision one 🌿" }, { revision: 2, text: "Latest revision two" }] })
  expect(chat.queue).toEqual([])
  const saved = JSON.parse(await readFile(join(folder, "chat-runs.json"), "utf8")).ses_stress
  expect(saved.goal).toEqual(chat.goal)
  expect(saved.plan).toEqual(chat.plan)
  expect(saved.queue).toEqual([])
})

test("plan parsing ignores fenced examples and incomplete proposals cannot auto-save", async () => {
  expect(proposedPlan("```xml\n<proposed_plan>Example</proposed_plan>\n``` ")).toBeUndefined()
  expect(proposedPlan("<proposed_plan>Writing")).toMatchObject({ plan: "Writing", complete: false })
  expect(proposedPlan("Context\n<proposed_plan>Approved\n</proposed_plan>\nAfter")).toMatchObject({ before: "Context", plan: "Approved\n", complete: true, after: "\nAfter" })
  const f = await fixture(); await f.runs.call("prepare", { prompt: f.prompt() })
  f.state.busy = false; f.state.messages.push({ id: "msg_z", assistant: true, text: "<proposed_plan>Normal chat example</proposed_plan>", tokens: 0, tools: 0 })
  f.runs.get("ses_test").awaiting = true; await f.runs.pump("ses_test")
  expect(f.runs.get("ses_test").plan).toBeUndefined()
})

test("immediate Goal Resume accounts for the deliberately stopped turn and creates one fresh continuation", async () => {
  const f = await stoppedGoalFixture()
  expect(f.chat.goal?.pendingInputIDs).toEqual([f.original.id])
  expect(f.chat.goal?.stoppedInputs).toEqual([{ id: f.original.id, before: expect.any(Number) }])
  f.state.busy = false; f.state.messages.push(f.canceled)
  await f.runs.call("goal-resume", { sessionID: "ses_test" })
  await f.reach(() => f.chat.goal?.continuations === 1)
  expect(f.chat.goal).toMatchObject({ status: "active", reason: "", tokens: 7, baseline: 5, lastTurn: f.canceled.id, pendingInputIDs: [] })
  expect(f.chat.goal?.progress).toBeUndefined()
  expect(f.chat.queue).toHaveLength(1)
  const continuation = f.chat.queue[0].id
  expect(continuation).not.toBe(f.original.id)
  expect(f.state.messages.find(row => row.id === f.canceled.id)).toEqual(f.canceled)
  expect(JSON.parse(await readFile(join(f.folder, "chat-runs.json"), "utf8")).ses_test.goal).toEqual(f.chat.goal)
  await f.reach(() => f.sent.length === 2 && !f.chat.queue.length)
  expect(f.sent.map(row => row.id)).toEqual([f.original.id, continuation])
})

test("late stopped metadata after a newer input does not block it, replay it or clear its waiting boundary", async () => {
  const f = await stoppedGoalFixture()
  const next = { ...f.prompt(ascending("message"), "Preserve this newer exact input 🌿"), protocol: "v1" as const }
  await f.runs.call("admit", { prompt: next })
  await f.runs.call("goal-resume", { sessionID: "ses_test" })
  f.state.busy = false
  await f.reach(() => f.sent.length === 2 && !f.chat.queue.length)
  f.state.busy = false; f.state.messages.push(f.canceled)
  await f.runs.pump("ses_test")
  expect(f.chat.goal).toMatchObject({ status: "active", reason: "", tokens: 7, lastTurn: f.canceled.id, pendingInputIDs: [next.id] })
  expect(f.chat.awaiting).toBe(true)
  expect(f.chat.queue).toEqual([])
  expect(f.sent.map(row => row.id)).toEqual([f.original.id, next.id])
  const completed = { id: ascending("message"), parentID: next.id, created: Date.now(), assistant: true, text: "Actual new progress", tokens: 11, tools: 1, progress: "new-progress" }
  f.state.messages.push(completed)
  await f.runs.pump("ses_test")
  expect(f.chat.goal).toMatchObject({ status: "active", tokens: 18, lastTurn: completed.id, pendingInputIDs: [], continuations: 1 })
  expect(f.chat.awaiting).toBe(false)
  expect(f.chat.queue).toHaveLength(1)
  expect(f.sent[1]).toMatchObject(next)
  expect(f.state.messages.find(row => row.id === f.canceled.id)).toEqual(f.canceled)
})

test.each([
  { kind: "fresh abort", error: '{"name":"MessageAbortedError","data":{"message":"Aborted"}}', aborted: true, status: "blocked" },
  { kind: "provider error", error: "Provider connection failed", aborted: false, status: "blocked" },
  { kind: "quota", error: "HTTP 429 usage limit", aborted: false, status: "usageLimited" },
])("a subsequent $kind remains a Goal failure after Resume", async failure => {
  const f = await stoppedGoalFixture()
  f.state.busy = false; f.state.messages.push(f.canceled)
  await f.runs.call("goal-resume", { sessionID: "ses_test" })
  await f.reach(() => f.chat.goal?.continuations === 1)
  await f.reach(() => f.sent.length === 2 && !f.chat.queue.length)
  const continuation = f.sent[1].id
  f.state.busy = false
  f.state.messages.push({ id: ascending("message"), parentID: continuation, created: Date.now(), assistant: true, text: "", tokens: 3, tools: 0, error: failure.error, aborted: failure.aborted })
  await f.runs.pump("ses_test")
  expect(f.chat.goal).toMatchObject({ status: failure.status, reason: failure.error, tokens: 10, continuations: 1, pendingInputIDs: [] })
  expect(f.sent.map(row => row.id)).toEqual([f.original.id, continuation])
  expect(f.chat.queue).toEqual([])
})

test.each(["fresh same parent", "same millisecond", "untyped", "no parent", "no timestamp"])("%s cancellation metadata is not treated as the deliberately stopped turn", async kind => {
  const f = await stoppedGoalFixture()
  const before = f.chat.goal!.stoppedInputs![0].before
  const row = { ...f.canceled, ...(kind === "fresh same parent" ? { created: before + 1 } : kind === "same millisecond" ? { created: before } : kind === "untyped" ? { aborted: false } : kind === "no parent" ? { parentID: undefined } : { created: undefined }) }
  f.state.busy = false; f.state.messages.push(row)
  await f.runs.call("goal-resume", { sessionID: "ses_test" })
  await f.reach(() => f.chat.goal?.status === "blocked")
  expect(f.chat.goal).toMatchObject({ status: "blocked", reason: row.error, tokens: 7, continuations: 0 })
  expect(f.sent.map(row => row.id)).toEqual([f.original.id])
})

test("busy Steer and repeated Stop retain ownership of the original turn after last changes", async () => {
  const f = await stoppedGoalFixture(false)
  const steer = { ...f.prompt(ascending("message"), "Steer the same Goal"), protocol: "v1" as const }
  await f.runs.call("admit", { prompt: steer, delivery: "steer" })
  await f.reach(() => f.sent.length === 2 && !f.chat.queue.length)
  expect(f.chat.last?.id).toBe(steer.id)
  expect(f.chat.goal?.pendingInputIDs).toEqual([f.original.id, steer.id])
  await f.runs.call("stop", { sessionID: "ses_test" })
  expect(f.chat.goal?.stoppedInputs?.map(row => row.id)).toEqual([f.original.id, steer.id])
  await f.runs.call("stop", { sessionID: "ses_test" })
  expect(f.chat.goal?.stoppedInputs?.map(row => row.id)).toEqual([f.original.id, steer.id])
  f.state.busy = false; f.state.messages.push(f.canceled)
  await f.runs.call("goal-resume", { sessionID: "ses_test" })
  await f.reach(() => f.chat.goal?.lastTurn === f.canceled.id)
  expect(f.chat.goal).toMatchObject({ status: "active", reason: "", tokens: 7, pendingInputIDs: [steer.id] })
  expect(f.sent.map(row => row.id)).toEqual([f.original.id, steer.id])
})

test("ignoring a deliberately stopped cancellation still enforces the original token budget", async () => {
  const f = await stoppedGoalFixture()
  await f.runs.call("goal-edit", { sessionID: "ses_test", objective: f.original.text, budget: 5 })
  f.state.busy = false; f.state.messages.push(f.canceled)
  await f.runs.call("goal-resume", { sessionID: "ses_test" })
  await f.reach(() => f.chat.goal?.status === "budgetLimited")
  expect(f.chat.goal).toMatchObject({ status: "budgetLimited", reason: "budget", tokens: 7, baseline: 5, continuations: 0 })
  expect(f.sent.map(row => row.id)).toEqual([f.original.id])
})

test("saved Stop ownership survives restart and preserves exact Goal evidence", async () => {
  const f = await stoppedGoalFixture()
  await f.runs.call("goal-progress", { sessionID: "ses_test", evidence: "Saved work and validation 🌿" })
  const restored = new BBRuns(f.folder, async () => structuredClone(f.state), async () => { throw new Error("Recovery must not dispatch") }, () => undefined)
  fixtures.push({ runs: restored, folder: f.folder }); await restored.start(); restored.close()
  expect(restored.get("ses_test").goal).toEqual(f.chat.goal)
  expect((await readdir(f.folder)).filter(name => name.startsWith("chat-runs-recovery-"))).toEqual([])
})

test.each([
  { field: "pendingInputIDs", value: ["same", "same"] },
  { field: "pendingInputIDs", value: [42] },
  { field: "stoppedInputs", value: [{ id: "original", before: "123" }] },
  { field: "stoppedInputs", value: [{ id: "original", before: -1 }] },
  { field: "stoppedInputs", value: [{ id: "same", before: 1 }, { id: "same", before: 2 }] },
])("damaged optional $field cancellation ownership retains the Goal and exact recovery source", async damaged => {
  const f = await stoppedGoalFixture()
  await f.runs.call("goal-progress", { sessionID: "ses_test", evidence: "Keep exact saved evidence 🌿" })
  const stored = JSON.parse(await readFile(join(f.folder, "chat-runs.json"), "utf8"))
  stored.ses_test.goal[damaged.field] = damaged.value
  const source = JSON.stringify(stored)
  await writeFile(join(f.folder, "chat-runs.json"), source)
  const restored = new BBRuns(f.folder, async () => f.state, async () => { throw new Error("Recovery must not dispatch") }, () => undefined)
  fixtures.push({ runs: restored, folder: f.folder }); await restored.start(); restored.close()
  expect(restored.get("ses_test").goal).toMatchObject({ id: f.chat.goal!.id, status: "paused", evidence: "Keep exact saved evidence 🌿", objective: f.original.text })
  expect(restored.get("ses_test").goal?.[damaged.field as "pendingInputIDs" | "stoppedInputs"]).toBeUndefined()
  const backup = (await readdir(f.folder)).find(name => name.startsWith("chat-runs-recovery-"))!
  expect(await readFile(join(f.folder, backup), "utf8")).toBe(source)
})

test("goal budget and provider quota stop continuation without selecting another provider", async () => {
  const f = await fixture(); await f.runs.call("goal-draft", { sessionID: "ses_test", enabled: true })
  await f.runs.call("admit", { prompt: f.prompt(), budget: 10 })
  f.state.busy = false; await f.runs.pump("ses_test"); await f.settle(); await f.runs.pump("ses_test")
  f.state.busy = false; f.state.messages.push({ id: "msg_z", assistant: true, text: "Progress", tokens: 12, tools: 1, progress: "created-file" })
  await f.runs.pump("ses_test")
  expect(f.runs.get("ses_test").goal?.status).toBe("budgetLimited")
  expect(f.runs.get("ses_test").goal?.tokens).toBe(12)
  expect(f.sent).toHaveLength(1)
  await expect(f.runs.call("goal-resume", { sessionID: "ses_test" })).rejects.toThrow("goalBudget")
  expect(f.runs.get("ses_test").goal?.status).toBe("budgetLimited")
  const quota = await fixture(); await quota.runs.call("goal-draft", { sessionID: "ses_test", enabled: true }); await quota.runs.call("admit", { prompt: quota.prompt() })
  quota.state.busy = false; await quota.runs.pump("ses_test"); await quota.settle(); await quota.runs.pump("ses_test")
  quota.state.busy = false; quota.state.messages.push({ id: "msg_z", assistant: true, text: "", tokens: 0, tools: 0, error: "HTTP 429 usage limit" })
  await quota.runs.pump("ses_test")
  expect(quota.runs.get("ses_test").goal?.status).toBe("usageLimited")
  expect(quota.sent).toHaveLength(1)
  expect(quota.sent[0].model?.providerID).toBe("test")
})

test("damaged journals retain a recovery copy and cannot block startup", async () => {
  for (const source of ["{broken", "null", '{"ses_bad":{"sessionID":"ses_bad","mode":"normal","queue":null}}']) {
    const f = await fixture(); f.runs.close()
    await writeFile(join(f.folder, "chat-runs.json"), source)
    const restored = new BBRuns(f.folder, async () => f.state, async () => { throw new Error("Recovery must not dispatch") }, () => undefined)
    fixtures.push({ runs: restored, folder: f.folder }); await restored.start()
    expect(restored.get("ses_recovered").queue).toEqual([])
    const backup = (await readdir(f.folder)).find(name => name.startsWith("chat-runs-recovery-"))!
    expect(await readFile(join(f.folder, backup), "utf8")).toBe(source)
  }
})

test("chat identity keys never inherit object properties", async () => {
  const f = await fixture()
  for (const id of ["constructor", "toString", "__proto__"]) expect(f.runs.get(id).sessionID).toBe(id)
  await f.runs.call("stop", { sessionID: "__proto__" })
  f.runs.close()
  const restored = new BBRuns(f.folder, async () => f.state, async () => undefined, () => undefined)
  fixtures.push({ runs: restored, folder: f.folder }); await restored.start()
  expect(restored.get("__proto__").paused).toBe(true)
  expect(restored.get("constructor").sessionID).toBe("constructor")
})

test("one malformed chat does not discard another chat's saved queue", async () => {
  const f = await fixture()
  await f.runs.call("admit", { prompt: f.prompt("msg_saved", "Keep this queued request") })
  f.runs.close()
  const saved = JSON.parse(await readFile(join(f.folder, "chat-runs.json"), "utf8"))
  await writeFile(join(f.folder, "chat-runs.json"), JSON.stringify({ ...saved, ses_bad: null }))
  const restored = new BBRuns(f.folder, async () => f.state, async () => { throw new Error("Recovery must not dispatch") }, () => undefined)
  fixtures.push({ runs: restored, folder: f.folder }); await restored.start()
  expect(restored.get("ses_test").paused).toBe(true)
  expect(restored.get("ses_test").queue[0].prompt.text).toBe("Keep this queued request")
  expect((await readdir(f.folder)).some(name => name.startsWith("chat-runs-recovery-"))).toBe(true)
})

test.each(["queue", "plan", "goal", "identity"])("one damaged %s record preserves the chat's remaining saved work", async damaged => {
  const f = await fixture()
  await f.runs.call("admit", { prompt: f.prompt("msg_first", "Keep the first request") })
  await f.runs.call("admit", { prompt: f.prompt("msg_second", "Keep the second request") })
  await f.runs.call("plan", { sessionID: "ses_test", text: "Keep the verified plan" })
  await f.runs.call("goal-draft", { sessionID: "ses_test", enabled: true })
  await f.runs.call("admit", { prompt: f.prompt("msg_goal", "Keep the saved goal") })
  f.runs.close()
  const saved = JSON.parse(await readFile(join(f.folder, "chat-runs.json"), "utf8"))
  if (damaged === "queue") saved.ses_test.queue[1] = null
  if (damaged === "identity") saved.ses_test.queue[1].prompt.id = "msg_wrong"
  if (damaged === "plan") saved.ses_test.plan.versions = null
  if (damaged === "goal") saved.ses_test.goal.status = "damaged"
  const source = JSON.stringify(saved)
  await writeFile(join(f.folder, "chat-runs.json"), source)
  const sent: string[] = []
  const restored = new BBRuns(f.folder, async () => ({ busy: false, messages: [] }), async prompt => { sent.push(prompt.id) }, () => undefined)
  fixtures.push({ runs: restored, folder: f.folder }); await restored.start()
  const chat = restored.get("ses_test")
  expect(chat.queue.map(item => item.id)).toEqual(damaged === "queue" || damaged === "identity" ? ["msg_first", "msg_goal"] : ["msg_first", "msg_second", "msg_goal"])
  expect(chat.paused).toBe(true)
  expect(chat.plan?.text).toBe(damaged === "plan" ? undefined : "Keep the verified plan")
  expect(chat.goal?.objective).toBe(damaged === "goal" ? undefined : "Keep the saved goal")
  expect(chat.goal?.status).toBe(damaged === "goal" ? undefined : "paused")
  await restored.pump("ses_test")
  expect(sent).toEqual([])
  const backup = (await readdir(f.folder)).find(name => name.startsWith("chat-runs-recovery-"))!
  expect(await readFile(join(f.folder, backup), "utf8")).toBe(source)
})

test.each([
  { kind: "goal", field: "evidence", value: { damaged: true } },
  { kind: "goal", field: "reason", value: { damaged: true } },
  { kind: "goal", field: "tokens", value: "0" },
  { kind: "goal", field: "budget", value: { damaged: true } },
  { kind: "goal", field: "started", value: null },
  { kind: "plan", field: "revision", value: "1" },
  { kind: "plan", field: "text", value: "Conflicts with immutable history" },
  { kind: "plan", field: "id", value: null },
  { kind: "plan", field: "versions", value: [] },
  { kind: "plan", field: "versions", value: [{ revision: 1, text: "Keep the verified plan" }, { revision: 1, text: "Duplicate revision" }] },
])("damaged $kind.$field cannot reach panels or future saves", async damaged => {
  const f = await fixture()
  f.runs.close()
  await f.runs.call("stop", { sessionID: "ses_test" })
  await f.runs.call("plan", { sessionID: "ses_test", text: "Keep the verified plan" })
  await f.runs.call("goal-draft", { sessionID: "ses_test", enabled: true })
  await f.runs.call("admit", { prompt: f.prompt("msg_metadata", "Keep this exact frozen source 🌿") })
  const stored = JSON.parse(await readFile(join(f.folder, "chat-runs.json"), "utf8"))
  const original = structuredClone(stored.ses_test)
  stored.ses_test[damaged.kind][damaged.field] = damaged.value
  const source = JSON.stringify(stored)
  await writeFile(join(f.folder, "chat-runs.json"), source)
  const restored = new BBRuns(f.folder, async () => ({ busy: false, messages: [] }), async () => { throw new Error("Recovery must stay paused") }, () => undefined)
  fixtures.push({ runs: restored, folder: f.folder }); await restored.start()
  const chat = restored.get("ses_test")
  expect(chat.queue).toEqual(original.queue)
  expect(chat.paused).toBe(true)
  expect(chat[damaged.kind as "goal" | "plan"]).toBeUndefined()
  if (damaged.kind === "goal") expect(chat.plan).toEqual(original.plan)
  if (damaged.kind === "plan") expect(chat.goal).toMatchObject({ objective: original.goal.objective, status: "paused" })
  const backup = (await readdir(f.folder)).find(name => name.startsWith("chat-runs-recovery-"))
  expect(backup).toBeDefined()
  expect(await readFile(join(f.folder, backup!), "utf8")).toBe(source)
})

test("a valid journal is retained without creating a repair backup", async () => {
  const f = await fixture()
  await f.runs.call("admit", { prompt: f.prompt("msg_valid", "Keep this valid request") })
  await f.runs.call("plan", { sessionID: "ses_test", text: "Keep this plan" })
  f.runs.close()
  const restored = new BBRuns(f.folder, async () => f.state, async () => undefined, () => undefined)
  fixtures.push({ runs: restored, folder: f.folder }); await restored.start()
  expect(restored.get("ses_test").queue[0].prompt.text).toBe("Keep this valid request")
  expect(restored.get("ses_test").plan?.text).toBe("Keep this plan")
  expect((await readdir(f.folder)).some(name => name.startsWith("chat-runs-recovery-"))).toBe(false)
})

test("only an idle-waiting queue uses busy summaries; steer, acknowledgement and Goal baseline retain history", async () => {
  const f = await fixture()
  f.runs.get("ses_test").paused = true
  await f.runs.call("admit", { prompt: f.prompt("msg_summary") })
  f.runs.get("ses_test").paused = false
  await f.runs.pump("ses_test")
  expect(f.inspections.at(-1)).toEqual({ readBusyMessages: false })
  expect(f.sent).toHaveLength(0)
  await f.runs.call("steer", { sessionID: "ses_test", id: "msg_summary" })
  await f.settle()
  expect(f.inspections.at(-1)).toEqual({ readBusyMessages: true })
  expect(f.sent).toHaveLength(1)
  await f.runs.pump("ses_test")
  expect(f.inspections.at(-1)).toEqual({ readBusyMessages: true })
  expect(f.runs.get("ses_test").queue).toHaveLength(0)
  await f.runs.call("goal-draft", { sessionID: "ses_test", enabled: true })
  const baseline = f.inspections.length
  await f.runs.call("admit", { prompt: f.prompt("msg_goal_baseline", "Account for all prior tokens") })
  expect(f.inspections[baseline]).toBeUndefined()
  expect(f.runs.get("ses_test").goal?.objective).toBe("Account for all prior tokens")
})

test.each(["before", "after", "goal"])("journal failure %s dispatch pauses background work without losing delivery history", async phase => {
  const folder = await mkdtemp(join(tmpdir(), "bb-runs-test-"))
  const state: Inspection = { busy: false, messages: [] }
  const sent: RunPrompt[] = []
  const changed: string[] = []
  let inspections = 0
  let durable = ""
  const temporary = join(folder, "chat-runs.json.tmp")
  const runs = new BBRuns(folder, async () => { inspections++; return structuredClone(state) }, async prompt => {
    sent.push(structuredClone(prompt))
    state.messages.push({ id: prompt.id, text: prompt.text, tokens: 0, tools: 0 })
    if (phase === "after" && sent.length === 1) {
      durable = await readFile(join(folder, "chat-runs.json"), "utf8")
      await mkdir(temporary)
    }
  }, id => changed.push(id))
  fixtures.push({ runs, folder })
  await runs.start(); runs.close()
  runs.get("ses_storage").paused = true
  const prompt: RunPrompt = { sessionID: "ses_storage", directory: folder, id: "msg_saved", text: "Retain the exact saved source 🌿", files: [{ uri: "bitsbytes://transcript/frozen?revision=2" }], goal: phase === "goal" }
  await runs.call("admit", { prompt })
  durable = await readFile(join(folder, "chat-runs.json"), "utf8")
  runs.get(prompt.sessionID).paused = false
  if (phase !== "after") await mkdir(temporary)
  await runs.pump(prompt.sessionID)
  const chat = runs.get(prompt.sessionID)
  expect(chat.paused).toBe(true)
  expect(chat.awaiting).toBe(false)
  expect(chat.error).toContain("chat-runs.json.tmp")
  expect(chat.queue[0].status).toBe(phase === "after" ? "uncertain" : "failed")
  expect(typeof chat.queue[0].sentAt).toBe(phase === "after" ? "number" : "undefined")
  expect(chat.queue[0].prompt).toMatchObject(JSON.parse(durable).ses_storage.queue[0].prompt)
  expect(changed).toHaveLength(phase === "after" ? 4 : 3)
  expect(await readFile(join(folder, "chat-runs.json"), "utf8")).toBe(durable)
  if (phase === "goal") {
    expect(chat.goal?.status).toBe("paused")
    expect(chat.goal?.objective).toBe(prompt.text)
    expect(chat.goal?.reason).toContain("chat-runs.json.tmp")
  }
  const inspected = inspections
  await runs.pump(prompt.sessionID)
  expect(inspections).toBe(inspected)
  expect(sent).toHaveLength(phase === "after" ? 1 : 0)
  await rmdir(temporary)
  await runs.call("resume", { sessionID: prompt.sessionID })
  for (let index = 0; index < 100; index++) {
    await new Promise(resolve => setTimeout(resolve, 5))
    await runs.pump(prompt.sessionID)
    if (!chat.queue.length) break
  }
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ id: prompt.id, files: prompt.files })
  expect(chat.queue).toHaveLength(0)
  if (phase !== "goal") expect(sent[0].text).toBe(prompt.text)
  else expect(chat.goal?.status).toBe("paused")
})

test("a failed retry journal preserves an earlier uncertain attempt and reconciles its late acknowledgement", async () => {
  const f = await fixture()
  f.runs.close()
  f.runs.get("ses_test").paused = true
  await f.runs.call("admit", { prompt: f.prompt("msg_prior_storage") })
  const chat = f.runs.get("ses_test"), item = chat.queue[0]
  item.sentAt = 42
  await f.runs.call("mode", { sessionID: chat.sessionID, mode: "normal" })
  const temporary = join(f.folder, "chat-runs.json.tmp")
  await mkdir(temporary)
  chat.paused = false; f.state.busy = false
  await f.runs.pump(chat.sessionID)
  expect(chat.paused).toBe(true)
  expect(item.status).toBe("uncertain")
  expect(item.sentAt).toBe(42)
  expect(f.sent).toHaveLength(0)
  await rmdir(temporary)
  f.state.messages.push({ id: item.id, text: "Original request acknowledged", tools: 0, tokens: 0 })
  await f.runs.call("resume", { sessionID: chat.sessionID })
  await f.settle()
  expect(chat.queue).toHaveLength(0)
  expect(f.sent).toHaveLength(0)
})

test("startup keeps a readable saved journal paused when its temporary write path is blocked", async () => {
  const f = await fixture()
  f.runs.close(); f.runs.get("ses_test").paused = true
  await f.runs.call("goal-draft", { sessionID: "ses_test", enabled: true })
  await f.runs.call("admit", { prompt: f.prompt("msg_saved_startup", "Keep the complete saved source 🌿") })
  await f.runs.call("plan", { sessionID: "ses_test", text: "Keep the saved plan" })
  const saved = JSON.parse(await readFile(join(f.folder, "chat-runs.json"), "utf8"))
  saved.ses_test.paused = false; saved.ses_test.awaiting = true
  saved.ses_test.queue[0].status = "sending"; saved.ses_test.queue[0].sentAt = 42
  const source = JSON.stringify(saved)
  await writeFile(join(f.folder, "chat-runs.json"), source)
  const temporary = join(f.folder, "chat-runs.json.tmp")
  await mkdir(temporary)
  let inspections = 0, dispatched = 0
  const restored = new BBRuns(f.folder, async () => { inspections++; return f.state }, async () => { dispatched++ }, () => undefined)
  fixtures.push({ runs: restored, folder: f.folder })
  await restored.start(); restored.close()
  const chat = restored.get("ses_test")
  expect(chat.paused).toBe(true)
  expect(chat.awaiting).toBe(false)
  expect(chat.error).toContain("chat-runs.json.tmp")
  expect(chat.queue[0].status).toBe("uncertain")
  expect(chat.queue[0].sentAt).toBe(42)
  expect(chat.queue[0].prompt).toEqual(saved.ses_test.queue[0].prompt)
  expect(chat.goal?.status).toBe("paused")
  expect(chat.goal?.objective).toBe(saved.ses_test.goal.objective)
  expect(chat.plan).toEqual(saved.ses_test.plan)
  expect(await readFile(join(f.folder, "chat-runs.json"), "utf8")).toBe(source)
  await restored.pump(chat.sessionID)
  expect(inspections).toBe(0)
  expect(dispatched).toBe(0)
  await expect(restored.call("admit", { prompt: chat.queue[0].prompt })).rejects.toThrow()
  await rmdir(temporary)
  await restored.call("stop", { sessionID: chat.sessionID })
  const recovered = JSON.parse(await readFile(join(f.folder, "chat-runs.json"), "utf8")).ses_test
  expect(recovered.paused).toBe(true)
  expect(recovered.queue[0].prompt).toEqual(saved.ses_test.queue[0].prompt)
  expect(recovered.queue[0].sentAt).toBe(42)
})

test("an unreadable journal is not treated as an empty saved state", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bb-runs-test-"))
  const path = join(folder, "chat-runs.json")
  await mkdir(path)
  const runs = new BBRuns(folder, async () => ({ busy: false, messages: [] }), async () => undefined, () => undefined)
  fixtures.push({ runs, folder })
  await expect(runs.start()).rejects.toThrow()
  expect(await readdir(folder)).toEqual(["chat-runs.json"])
})

test.each(["admit", "goal", "resume"])("a rejected %s save cannot dispatch automatically after storage recovers", async phase => {
  const f = await fixture()
  f.runs.close(); f.state.busy = false
  const prompt = f.prompt("msg_rejected_save", "Keep this unacknowledged source 🌿")
  if (phase === "goal") await f.runs.call("goal-draft", { sessionID: prompt.sessionID, enabled: true })
  if (phase === "resume") {
    await f.runs.call("stop", { sessionID: prompt.sessionID })
    await f.runs.call("admit", { prompt })
  }
  const durable = await readFile(join(f.folder, "chat-runs.json"), "utf8")
  const temporary = join(f.folder, "chat-runs.json.tmp")
  await mkdir(temporary)
  await expect(phase === "resume"
    ? f.runs.call("resume", { sessionID: prompt.sessionID })
    : f.runs.call("admit", { prompt })).rejects.toThrow()
  const chat = f.runs.get(prompt.sessionID)
  expect(chat.paused).toBe(true)
  expect(chat.awaiting).toBe(false)
  expect(chat.error).toContain("chat-runs.json.tmp")
  expect(chat.queue[0].prompt.text).toContain(prompt.text)
  expect(await readFile(join(f.folder, "chat-runs.json"), "utf8")).toBe(durable)
  if (phase === "goal") expect(chat.goal?.status).toBe("paused")
  await rmdir(temporary)
  await f.runs.pump(prompt.sessionID)
  expect(f.sent).toHaveLength(0)
  await f.runs.call("resume", { sessionID: prompt.sessionID })
  await f.settle(); await f.runs.pump(prompt.sessionID)
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0].id).toBe(prompt.id)
  expect(f.sent[0].text).toContain(prompt.text)
})
