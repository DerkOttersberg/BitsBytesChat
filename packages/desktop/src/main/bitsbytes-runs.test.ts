import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { BBRuns, type Inspection, type InspectionOptions, type RunPrompt } from "./bitsbytes-runs"
import { proposedPlan } from "@opencode-ai/core/util/proposed-plan"

const fixtures: { runs: BBRuns; folder: string }[] = []
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "bb-runs-test-"))
  const state: Inspection = { busy: true, messages: [] }
  const sent: RunPrompt[] = []
  const inspections: (InspectionOptions | undefined)[] = []
  const fail = { enabled: false }
  const runs = new BBRuns(folder, async (_prompt, options) => { inspections.push(options); return structuredClone(state) }, async prompt => { sent.push(structuredClone(prompt)); state.messages.push({ id: prompt.id, text: prompt.text, tools: 0, tokens: 0 }); state.busy = true; if (fail.enabled) throw new Error("connection lost after admission") }, () => undefined)
  fixtures.push({ runs, folder }); await runs.start()
  const prompt = (id = "msg_000000000001a", text = "Complete source") => ({ sessionID: "ses_test", directory: folder, id, text, model: { providerID: "test", modelID: "test" }, legacyParts: [{ type: "text", text }] })
  const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 5)); if (!runs.get("ses_test").queue.some(item => item.status === "sending")) break } }
  return { runs, folder, state, sent, fail, prompt, settle, inspections }
}
afterEach(async () => { for (const fixture of fixtures.splice(0)) { fixture.runs.close(); const path = resolve(fixture.folder); if (!path.startsWith(resolve(tmpdir()) + "\\bb-runs-test-") && !path.startsWith(resolve(tmpdir()) + "/bb-runs-test-")) throw new Error("Unexpected cleanup path"); await rm(path, { recursive: true, force: true }) } })

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

test("Stop while admission is being journalled prevents dispatch and clears awaiting", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bb-runs-test-"))
  const entered = Promise.withResolvers<void>()
  const inspection = Promise.withResolvers<Inspection>()
  const sent: string[] = []
  const runs = new BBRuns(folder, async () => { entered.resolve(); return inspection.promise }, async prompt => { sent.push(prompt.id) }, () => undefined)
  fixtures.push({ runs, folder }); await runs.start()
  runs.get("ses_test").paused = true
  await runs.call("admit", { prompt: { sessionID: "ses_test", directory: folder, id: "msg_journalled", text: "Keep this unsent" } })
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
  expect(runs.get("ses_test").queue[0].status).toBe("pending")
  const saved = JSON.parse(await readFile(join(folder, "chat-runs.json"), "utf8")).ses_test
  expect(saved.paused).toBe(true)
  expect(saved.queue[0].status).toBe("pending")
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
  for (let i = 0; i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 5)); if (runs.get("ses_test").queue[0]?.status === "sending") break }
  runs.get("ses_test").queue[0].sentAt = Date.now() - 31000
  await runs.pump("ses_test")
  expect(runs.get("ses_test").awaiting).toBe(false)
  expect(runs.get("ses_test").queue[0].status).toBe("uncertain")
  expect(runs.get("ses_test").error).toBe("bb.error.deliveryUnknown")
  await runs.pump("ses_test")
  expect(sent).toEqual(["msg_unprojected"])
  state.messages.push({ id: "msg_unprojected", text: "Retain this request", tokens: 0, tools: 0 })
  await runs.pump("ses_test")
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

test("plan parsing ignores fenced examples and incomplete proposals cannot auto-save", async () => {
  expect(proposedPlan("```xml\n<proposed_plan>Example</proposed_plan>\n``` ")).toBeUndefined()
  expect(proposedPlan("<proposed_plan>Writing")).toMatchObject({ plan: "Writing", complete: false })
  expect(proposedPlan("Context\n<proposed_plan>Approved\n</proposed_plan>\nAfter")).toMatchObject({ before: "Context", plan: "Approved\n", complete: true, after: "\nAfter" })
  const f = await fixture(); await f.runs.call("prepare", { prompt: f.prompt() })
  f.state.busy = false; f.state.messages.push({ id: "msg_z", assistant: true, text: "<proposed_plan>Normal chat example</proposed_plan>", tokens: 0, tools: 0 })
  f.runs.get("ses_test").awaiting = true; await f.runs.pump("ses_test")
  expect(f.runs.get("ses_test").plan).toBeUndefined()
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
