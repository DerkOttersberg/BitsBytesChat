import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { request } from "node:https"
import { mkdtemp, readFile, appendFile, writeFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { BBMobile } from "./bitsbytes-mobile"
import { bbt } from "../bitsbytes/copy"
import type { DocumentArtifact } from "../bitsbytes/types"

const calls: { method: string; args: Record<string, unknown>; directory?: string }[] = []
let mobile: BBMobile,
  root: string,
  port: number,
  cookie = ""
const sessions = [{ id: "ses_shared", title: "Laptop conversation", directory: "C:/mobile-test/shared-project" }]
const frozenSource = "SAVED-QUEUE-CONTEXT 🌿 ".repeat(6000)
const sessionRead = { held: false, entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
const journalFailure = { enabled: false }
const savedRun = {
  sessionID: "ses_shared",
  queue: [{ id: "msg_pending", status: "pending", delivery: "queue", prompt: { text: frozenSource } }],
  last: { text: frozenSource, directory: undefined as string | undefined },
  awaiting: false,
  paused: true,
  error: "",
}
const host = {
  get root() {
    return root
  },
  assets: resolve("resources/bitsbytes"),
  settings: { engine: "parakeet" },
  runs: { get: () => savedRun },
  artifacts: {
    items: [] as DocumentArtifact[],
    content: async () => ({ text: "" }),
    previewPath: async (id: string, revision?: number) => {
      const item = host.artifacts.items.find((item) => item.id === id)
      return (
        (revision === undefined ? item?.pdf : item?.history?.find((item) => item.revision === revision)?.pdf) || null
      )
    },
  },
  skills: async () => [],
  engineFetch: async <T>(path: string, options: RequestInit = {}, directory?: string): Promise<T> => {
    calls.push({ method: path, args: options, directory })
    if (path.startsWith("/experimental/session")) return sessions as T
    if (path === "/session") {
      const chat = { ...sessions[0], id: "ses_phone" }
      sessions.push(chat)
      return chat as T
    }
    if (path === "/provider")
      return {
        connected: ["test"],
        all: [
          {
            id: "test",
            name: "Connected provider",
            key: "SHOULD_NOT_LEAK",
            models: { model: { id: "model", name: "Test model", variants: { high: {} }, apiKey: "SHOULD_NOT_LEAK" } },
          },
          { id: "offline", name: "Offline provider", models: { hidden: { id: "hidden" } } },
        ],
      } as T
    if (path === "/config") return { model: "test/model", provider: { test: { apiKey: "SHOULD_NOT_LEAK" } } } as T
    if (path === "/session/status") return { ses_shared: { type: "busy" } } as T
    if (path === "/permission")
      return [
        { id: "per_shared", sessionID: "ses_shared" },
        { id: "per_other", sessionID: "ses_other" },
      ] as T
    if (path === "/question") return [] as T
    if (path.endsWith("/message"))
      return [
        {
          info: { id: "msg_desktop", role: "user" },
          parts: [
            { type: "text", text: "Written on laptop" },
            { type: "text", text: "Complete source stays in the engine", synthetic: true },
          ],
        },
      ] as T
    if (path === "/session/ses_shared") {
      if (sessionRead.held) {
        sessionRead.entered.resolve()
        await sessionRead.release.promise
      }
      return sessions[0] as T
    }
    if (path.endsWith("/abort")) return true as T
    if (path.includes("/reply")) return true as T
    throw Error(path)
  },
  call: async (method: string, args: Record<string, unknown>) => {
    calls.push({ method, args })
    if (method === "runs.stop") {
      savedRun.paused = true
      if (journalFailure.enabled) throw Error("Journal storage unavailable")
    }
    return method === "access.get" ? { mode: "ask" } : { ok: true }
  },
  rpc: async (method: string) => {
    if (method === "jobs") return []
    throw Error("Fixture transcription is unavailable")
  },
}

function http(path: string, method = "GET", input?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          rejectUnauthorized: false,
          headers: { origin: `https://127.0.0.1:${port}`, ...(cookie ? { cookie } : {}), ...headers },
        },
        (res) => {
          const bytes: Buffer[] = []
          res.on("data", (chunk) => bytes.push(chunk))
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(bytes).toString() }),
          )
        },
      )
      req.on("error", reject)
      req.end(Buffer.isBuffer(input) ? input : input === undefined ? undefined : JSON.stringify(input))
    },
  )
}
const api = (method: string, args: Record<string, unknown> = {}) => http("/api", "POST", { method, args })
async function pair() {
  const invitation = (await mobile.call("pair")) as { token: string }
  const result = await http("/pair", "POST", { token: invitation.token, name: "Test phone" })
  assert.equal(result.status, 200)
  const pairing = JSON.parse(result.body) as { id: string; secret: string }
  assert.equal((await http("/pair", "POST", { token: invitation.token })).status, 401)
  assert.equal(
    JSON.parse(
      (await http("/pair/" + pairing.id, "GET", undefined, { authorization: "Bearer " + pairing.secret })).body,
    ).status,
    "pending",
  )
  await mobile.call("approve", { id: pairing.id })
  const approved = await http("/pair/" + pairing.id, "GET", undefined, { authorization: "Bearer " + pairing.secret })
  assert.match(approved.headers["set-cookie"]![0], /HttpOnly; Secure; SameSite=Strict/)
  cookie = approved.headers["set-cookie"]![0].split(";")[0]
  return pairing
}

before(
  async () => {
    root = await mkdtemp(join(tmpdir(), "bitsbytes-mobile-test-"))
    const listener = createServer()
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
    const address = listener.address()
    if (!address || typeof address === "string") throw Error("No test port")
    port = address.port
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    mobile = new BBMobile(
      host as unknown as ConstructorParameters<typeof BBMobile>[0],
      () => {},
      (value) => Buffer.from(value).toString("base64"),
      (value) => Buffer.from(value, "base64").toString(),
    )
    await mobile.start()
    await mobile.call("enable", { port })
  },
  { timeout: 30000 },
)
after(async () => {
  mobile?.close()
  await rm(root, { recursive: true, force: true })
})

test("HTTPS pairing, shared sessions and credential boundary", async () => {
  const state = mobile.state()
  assert.equal(state.preferredURL, state.urls[0])
  const selected = state.addresses.at(-1)!
  assert.equal((await mobile.call("address", { url: selected.url })).preferredURL, selected.url)
  await assert.rejects(mobile.call("address", { url: "https://untrusted.invalid:24483" }))
  assert.equal((await http("/")).status, 200)
  assert.equal((await api("overview")).status, 401)
  assert.equal((await http("/pair", "POST", {}, { origin: "https://untrusted.invalid" })).status, 403)
  await pair()
  const overview = await api("overview")
  assert.equal(overview.status, 200)
  assert.equal(overview.body.includes("SHOULD_NOT_LEAK"), false)
  assert.deepEqual(JSON.parse(overview.body).chats, [{ id: "ses_shared", title: "Laptop conversation" }])
  assert.equal(JSON.parse(overview.body).models.length, 1)
  const chat = JSON.parse((await api("chat", { sessionID: "ses_shared" })).body)
  assert.equal(chat.messages[0].parts[0].text, "Written on laptop")
  assert.equal(chat.messages[0].parts.length, 1)
  assert.equal(chat.permissions.length, 1)
  assert.equal(calls.findLast((row) => row.method === "/session/ses_shared/message")?.directory, sessions[0].directory)
  const send = await api("send", {
    sessionID: "ses_shared",
    id: "msg_123456789abc123456789abc12",
    text: "Phone reply",
    model: { providerID: "test", modelID: "model" },
  })
  assert.equal(send.status, 200, send.body)
  assert.equal(
    (calls.findLast((row) => row.method === "runs.admit")!.args.prompt as { directory: string }).directory,
    sessions[0].directory,
  )
  assert.equal((await api("permission", { sessionID: "ses_shared", id: "per_other", reply: "once" })).status, 400)
  assert.equal((await api("permission", { sessionID: "ses_shared", id: "per_shared", reply: "always" })).status, 400)
  assert.equal((await api("permission", { sessionID: "ses_shared", id: "per_shared", reply: "once" })).status, 200)
  assert.equal(
    (await http("/api", "POST", { method: "overview" }, { origin: "https://untrusted.invalid" })).status,
    403,
  )
  assert.equal((await http("/", "GET", undefined, { host: `untrusted.invalid:${port}` })).status, 403)
  assert.equal((await api("arbitrary.engine.proxy", {})).status, 400)
})

test("HTTPS status omits frozen prompt context while the host retains its queue", async () => {
  const response = await api("chat", { sessionID: "ses_shared" })
  assert.equal(response.status, 200)
  assert.equal(response.body.includes("SAVED-QUEUE-CONTEXT"), false)
  assert.ok(Buffer.byteLength(response.body) < 1024)
  assert.deepEqual(JSON.parse(response.body).run, {
    sessionID: "ses_shared",
    queue: [{ id: "msg_pending", status: "pending", delivery: "queue" }],
    awaiting: false,
    paused: true,
    error: "",
  })
  assert.equal(host.runs.get().queue[0].prompt.text, frozenSource)
  assert.equal(host.runs.get().last.text, frozenSource)
})

test("HTTPS queue status resolves recovery copy while preserving the host error key", async () => {
  savedRun.error = "bb.error.deliveryUnknown"
  try {
    const response = await api("chat", { sessionID: "ses_shared" })
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(response.body).run.error, bbt("bb.error.deliveryUnknown"))
    assert.equal(savedRun.error, "bb.error.deliveryUnknown")
  } finally {
    savedRun.error = ""
  }
})

test("phone Stop pauses the host before waiting for engine session metadata", { timeout: 5000 }, async () => {
  savedRun.paused = false
  sessionRead.held = true
  const offset = calls.length,
    stopping = api("stop", { sessionID: "ses_shared" })
  try {
    await sessionRead.entered.promise
    assert.equal(savedRun.paused, true)
    assert.ok(calls.slice(offset).some((row) => row.method === "runs.stop"))
    assert.equal(
      calls.slice(offset).some((row) => row.method.endsWith("/abort")),
      false,
    )
  } finally {
    sessionRead.held = false
    sessionRead.release.resolve()
    await stopping
  }
})

test("phone Stop uses a known host directory without another metadata read", async () => {
  savedRun.last.directory = sessions[0].directory
  const offset = calls.length
  try {
    const response = await api("stop", { sessionID: "ses_shared" })
    assert.equal(response.status, 200)
    assert.equal(
      calls.slice(offset).some((row) => row.method === "/session/ses_shared"),
      false,
    )
    assert.equal(calls.findLast((row) => row.method === "/session/ses_shared/abort")?.directory, sessions[0].directory)
  } finally {
    savedRun.last.directory = undefined
  }
})

for (const known of [false, true]) {
  test(`phone Stop interrupts after a journal failure with a ${known ? "known" : "fallback"} directory`, async () => {
    savedRun.last.directory = known ? sessions[0].directory : undefined
    savedRun.paused = false
    journalFailure.enabled = true
    const offset = calls.length
    try {
      const response = await api("stop", { sessionID: "ses_shared" })
      assert.equal(response.status, 400)
      assert.equal(JSON.parse(response.body).error, "Journal storage unavailable")
      assert.equal(savedRun.paused, true)
      assert.deepEqual(
        calls.slice(offset).map((row) => row.method),
        known
          ? ["runs.stop", "/session/ses_shared/abort"]
          : ["runs.stop", "/session/ses_shared", "/session/ses_shared/abort"],
      )
      assert.equal(
        calls.findLast((row) => row.method === "/session/ses_shared/abort")?.directory,
        sessions[0].directory,
      )
    } finally {
      savedRun.last.directory = undefined
      journalFailure.enabled = false
    }
  })
}

test("paired downloads preserve historical bytes, PDF selection and Unicode filenames", async () => {
  const source = join(root, "latest.txt"),
    previous = join(root, "previous.txt"),
    pdf = join(root, "previous.pdf"),
    original = "Earlier saved revision 🌿\r\n".repeat(7000),
    filename = "Bijlage 🌿 résumé.txt"
  await writeFile(source, "Latest saved revision")
  await writeFile(previous, original)
  await writeFile(pdf, "%PDF-1.7\nHistorical fixture\n%%EOF")
  host.artifacts.items.push({
    id: "download_revision",
    sessionID: "ses_shared",
    filename,
    path: source,
    source,
    revision: 2,
    hash: "latest",
    kind: "code",
    mime: "text/plain",
    status: "ready",
    updated: 2,
    pdf: "",
    error: "",
    history: [
      { revision: 1, hash: "previous", source: previous, pdf, updated: 1 },
      { revision: 2, hash: "latest", source, pdf: "", updated: 2 },
    ],
  })
  try {
    const revision = await http("/file/download_revision?revision=1")
    assert.equal(revision.status, 200)
    assert.equal(revision.body, original)
    assert.equal(Number(revision.headers["content-length"]), Buffer.byteLength(original))
    assert.equal(revision.headers["cache-control"], "no-store")
    assert.equal(revision.headers["content-type"], "text/plain")
    assert.equal(
      revision.headers["content-disposition"],
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    )
    const preview = await http("/file/download_revision?revision=1&preview=1")
    assert.equal(preview.status, 200)
    assert.equal(preview.body, await readFile(pdf, "utf8"))
    assert.equal(preview.headers["content-type"], "application/pdf")
    assert.equal(
      preview.headers["content-disposition"],
      `inline; filename*=UTF-8''${encodeURIComponent(filename + ".pdf")}`,
    )
    assert.equal((await http("/file/download_revision?revision=99")).status, 400)
    assert.equal((await http("/file/download_revision?preview=1")).status, 400)
    host.artifacts.items[0].history!.push(
      { revision: 3, hash: "missing", source: join(root, "missing.txt"), pdf: "", updated: 3 },
      { revision: 4, hash: "directory", source: root, pdf: "", updated: 4 },
    )
    assert.equal((await http("/file/download_revision?revision=3")).status, 400)
    assert.equal((await http("/file/download_revision?revision=4")).status, 400)
    assert.equal((await http("/file/download_revision", "GET", undefined, { cookie: "" })).status, 401)
    assert.equal((await http("/file/download_revision")).body, "Latest saved revision")
    assert.equal(await readFile(source, "utf8"), "Latest saved revision")
  } finally {
    host.artifacts.items.length = 0
  }
})

test("resumable upload journal, exact retries, interruption tail and device revocation", async () => {
  const result = await http("/upload", "POST", {
    name: "hour-long.wav",
    size: 8,
    sessionID: "ses_shared",
    fingerprint: "checked-sample",
  })
  const upload = JSON.parse(result.body)
  assert.equal(result.status, 200)
  assert.equal((await http(`/upload/${upload.id}?offset=0`, "PUT", Buffer.from("1234"))).status, 200)
  assert.equal(
    JSON.parse((await http(`/upload/${upload.id}?offset=0`, "PUT", Buffer.from("1234"))).body).chunks.length,
    1,
  )
  assert.equal((await http(`/upload/${upload.id}?offset=0`, "PUT", Buffer.from("xxxx"))).status, 400)
  await appendFile(join(root, "mobile/uploads", upload.id + ".part"), "uncommitted-crash-tail")
  assert.equal((await http(`/upload/${upload.id}?offset=4`, "PUT", Buffer.from("5678"))).status, 200)
  assert.equal(await readFile(join(root, "mobile/uploads", upload.id + ".part"), "utf8"), "12345678")
  assert.equal(
    JSON.parse(
      (
        await http("/upload", "POST", {
          name: "hour-long.wav",
          size: 8,
          sessionID: "ses_shared",
          fingerprint: "checked-sample",
        })
      ).body,
    ).id,
    upload.id,
  )
  // Reproduce interruption after the final rename but before the journal commit.
  const { rename } = await import("node:fs/promises")
  await rename(join(root, "mobile/uploads", upload.id + ".part"), join(root, "mobile/uploads", upload.id + ".wav"))
  assert.equal((await http(`/upload/${upload.id}/finish`, "POST", {})).status, 200)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(JSON.parse((await http("/uploads")).body)[0].error, "Fixture transcription is unavailable")
  assert.equal(await readFile(join(root, "mobile/uploads", upload.id + ".wav"), "utf8"), "12345678")
  const device = mobile.state().devices[0]
  const preferredURL = mobile.state().preferredURL
  mobile.close()
  const restarted = new BBMobile(
    host as unknown as ConstructorParameters<typeof BBMobile>[0],
    () => {},
    (value) => Buffer.from(value).toString("base64"),
    (value) => Buffer.from(value, "base64").toString(),
  )
  mobile = restarted
  await mobile.start()
  assert.equal(mobile.state().preferredURL, preferredURL)
  assert.equal((await api("overview")).status, 200)
  await mobile.call("revoke", { id: device.id })
  assert.equal((await api("overview")).status, 401)
  assert.notEqual((await http("/file/../../tls.json")).status, 200)
})

test("audio uploads exceed 25 MB through bounded resumable requests", async () => {
  await pair()
  const size = 32 * 1024 ** 2
  const upload = JSON.parse(
    (
      await http("/upload", "POST", {
        name: "long-recording.wav",
        size,
        sessionID: "ses_shared",
        fingerprint: "long-source",
      })
    ).body,
  )
  for (let offset = 0; offset < size; offset += 4 * 1024 ** 2) {
    const response = await http(
      `/upload/${upload.id}?offset=${offset}`,
      "PUT",
      Buffer.alloc(4 * 1024 ** 2, offset / (4 * 1024 ** 2)),
    )
    assert.equal(response.status, 200, response.body)
  }
  const saved = JSON.parse(await readFile(join(root, "mobile/uploads", upload.id + ".json"), "utf8"))
  assert.equal(
    saved.chunks.reduce((sum: number, chunk: { length: number }) => sum + chunk.length, 0),
    size,
  )
  assert.equal(saved.chunks.length, 8)
  assert.equal(
    (await http("/upload", "POST", { name: "too-large.wav", size: 1024 ** 3 + 1, sessionID: "ses_shared" })).status,
    400,
  )
})
