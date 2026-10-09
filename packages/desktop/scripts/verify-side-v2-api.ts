import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { constants, setPriority } from "node:os"
import { join, resolve } from "node:path"

setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const profile = join(root, ".tools/qa/side-v2-api-" + randomUUID())
const directory = join(profile, "workspace")
await mkdir(directory, { recursive: true })
process.env.OPENCODE_DB = join(profile, "api.db")
process.env.OPENCODE_TEST_HOME = profile
process.env.XDG_DATA_HOME = join(profile, "data")
process.env.XDG_STATE_HOME = join(profile, "state")
process.env.XDG_CONFIG_HOME = join(profile, "config")
process.env.XDG_CACHE_HOME = join(profile, "cache")
process.env.OPENCODE_DISABLE_MODELS_FETCH = "1"
process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
const { webHandler } = await import("../../server/src/routes")
const { Database } = await import("bun:sqlite")
const { BBSide } = await import("../src/main/bitsbytes-side")
const { BBRuns } = await import("../src/main/bitsbytes-runs")
const { EngineResponseError } = await import("../src/main/bitsbytes-engine")
const handler = webHandler()
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler.handler })
const report = { profile, checks: [] as string[], requests: [] as string[], errors: [] as string[] }
const request = async <T>(path: string, options: RequestInit = {}) => {
  report.requests.push((options.method ?? "GET") + " " + path)
  const response = await fetch(server.url + path, {
    ...options,
    headers: { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) },
  })
  if (!response.ok) throw new EngineResponseError(response.status, await response.text())
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}
const runs = new BBRuns(
  profile,
  async () => ({ busy: false, messages: [] }),
  async () => {
    throw Error("This acceptance run cannot execute any provider or parent request")
  },
  () => undefined,
)
let database: InstanceType<typeof Database> | undefined
try {
  await runs.start()
  const parent = (
    await request<{ data: { id: string } }>("/api/session", {
      method: "POST",
      body: JSON.stringify({ location: { directory } }),
    })
  ).data
  const historical = (
    await request<{ data: { id: string } }>("/api/session", {
      method: "POST",
      body: JSON.stringify({ location: { directory } }),
    })
  ).data
  database = new Database(process.env.OPENCODE_DB)
  const record = database.prepare(
    "INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)",
  )
  const timestamp = Date.now()
  record.run(
    "msg_v2_question",
    parent.id,
    "user",
    1,
    timestamp,
    timestamp,
    JSON.stringify({
      text: "Create a blue spaceship game with arrow-key controls.",
      files: [],
      agents: [],
      time: { created: timestamp },
    }),
  )
  record.run(
    "msg_v2_answer",
    parent.id,
    "assistant",
    2,
    timestamp + 1,
    timestamp + 1,
    JSON.stringify({
      agent: "build",
      model: { id: "fixture", providerID: "qa" },
      finish: "stop",
      content: [{ id: "text_reply", type: "text", text: "I inspected the existing game and its keyboard controls." }],
      time: { created: timestamp + 1, completed: timestamp + 2 },
    }),
  )
  runs.get(parent.id).last = {
    id: "msg_v2_question",
    sessionID: parent.id,
    directory,
    protocol: "v2",
    text: "Create a blue spaceship game with arrow-key controls.",
  }
  const side = new BBSide(profile, request, runs)
  const first = await side.open(parent.id, parent.id, directory, "Side chat", "v2")
  const second = await side.open(parent.id, parent.id, directory, "Side chat", "v2")
  assert.notEqual(first.id, second.id)
  assert.equal(first.parentID, parent.id)
  assert.equal(first.diagnostic?.ownerID, parent.id)
  const snapshot = await side.progress(first.id)
  assert.equal(snapshot.phase, "idle")
  assert.ok(snapshot.objective?.includes("blue spaceship"))
  assert.ok(snapshot.recentMessages.some((row) => row.role === "assistant" && row.text.includes("keyboard controls")))
  const prepared = await side.prepare({
    sessionID: first.id,
    id: "msg_side_question",
    directory,
    text: "What controls did it inspect?",
  })
  assert.equal(prepared.protocol, "v2")
  assert.ok(JSON.stringify(prepared.legacyParts).includes("arrow-key controls"))
  assert.deepEqual(await side.prepare(prepared), prepared)
  report.checks.push(
    "Actual pure V2 API creates independent owned diagnostic children and returns ordinary parent messages in frozen side context",
  )
  await side.close(first.id, parent.id)
  const archived = (await request<{ data: { time: { archived?: number } } }>("/api/session/" + first.id)).data
  const sibling = (await request<{ data: { time: { archived?: number } } }>("/api/session/" + second.id)).data
  assert.ok(archived.time.archived)
  assert.equal(sibling.time.archived, undefined)
  assert.equal(
    (await request<{ data: { time: { archived?: number } } }>("/api/session/" + parent.id)).data.time.archived,
    undefined,
  )
  report.checks.push(
    "Actual V2 interrupt/archive closes only the selected owned child and preserves its sibling and parent",
  )
  let loseReply = true
  const uncertain = new BBSide(
    profile,
    async <T>(path: string, options?: RequestInit) => {
      const result = await request<T>(path, options)
      if (path === "/api/session" && options?.method === "POST" && loseReply) {
        loseReply = false
        throw new EngineResponseError(503, "Simulated lost create acknowledgement")
      }
      return result
    },
    runs,
  )
  const before = report.requests.filter((row) => row === "POST /api/session").length
  await assert.rejects(uncertain.open(parent.id, parent.id, directory, "Side chat", "v2"))
  await new BBSide(profile, request, runs).recover()
  assert.equal(report.requests.filter((row) => row === "POST /api/session").length, before + 1)
  assert.equal(
    (await request<{ data: { time: { archived?: number } } }>("/api/session/" + historical.id)).data.time.archived,
    undefined,
  )
  assert.equal(
    (await request<{ data: { time: { archived?: number } } }>("/api/session/" + parent.id)).data.time.archived,
    undefined,
  )
  assert.ok(report.requests.every((row) => row.includes(" /api/")))
  report.checks.push(
    "Actual V2 recovery reconciles a lost create reply without resubmission, parent execution or historical-fork cleanup",
  )
} catch (error) {
  report.errors.push(String(error))
  throw error
} finally {
  runs.close()
  database?.close()
  server.stop(true)
  await handler.dispose()
  const output = join(root, ".tools/qa/results")
  await mkdir(output, { recursive: true })
  await writeFile(join(output, (process.env.BB_QA_REPORT ?? "side-v2-api") + ".json"), JSON.stringify(report, null, 2))
}
console.log(JSON.stringify(report.checks, null, 2))
