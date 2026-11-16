import assert from "node:assert/strict"
import { createHash, randomUUID, X509Certificate } from "node:crypto"
import { request } from "node:https"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { PhoneLink } from "../src/main/phone-link.js"
import { Library } from "../src/main/storage.js"

test("paired TLS delivery preserves long Unicode text, commits history, and never re-copies an acknowledged retry", async t => {
  const parent = path.resolve("test-results"); await mkdir(parent, { recursive: true }); const root = await mkdtemp(path.join(parent, "link-"))
  let link: PhoneLink | undefined
  t.after(async () => { await link?.close(); assert.ok(root.startsWith(parent + path.sep)); await rm(root, { recursive: true, force: true }) })
  const library = new Library(root); await library.initialize(); let clipboard = ""; let writes = 0
  const options = { protect: (value: string) => Buffer.from(value).toString("base64"), unprotect: (value: string) => Buffer.from(value, "base64").toString(),
    receive: async (delivery: { recordingId: string; title: string; text: string; duration: number }, peer: { id: string; name: string }) => { await library.receiveTranscript(delivery, peer) },
    clipboard: async (text: string) => { clipboard = text; writes++ }, changed: () => undefined }
  link = new PhoneLink(root, options); await link.start(0, false)
  const pairing = await link.pairing(); const code = JSON.parse(Buffer.from(pairing.code.split("bitsbytes://link/")[1], "base64url").toString()) as { id: string; token: string; pin: string; peerId: string }
  assert.ok(pairing.qr.startsWith("data:image/png;base64,"))
  const settings = JSON.parse(await readFile(path.join(root, "phone-link.json"), "utf8")) as { cert: string }
  assert.ok(!(await readFile(path.join(root, "phone-link.json"), "utf8")).includes(code.token))
  const phoneId = randomUUID()
  async function post(operation: string, body: unknown, token = code.token) {
    return new Promise<{ status: number; body: Record<string, string> }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: link!.snapshot().port, method: "POST", path: `/v1/peers/${code.peerId}/${operation}`, ca: settings.cert,
        checkServerIdentity: (_host, cert) => createHash("sha256").update(new X509Certificate(cert.raw).publicKey.export({ type: "spki", format: "der" })).digest("hex") === code.pin ? undefined : new Error("pin mismatch"),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, string> }))
      }); req.on("error", reject); req.end(JSON.stringify(body))
    })
  }
  assert.equal((await post("pair", { phoneId, name: "Test phone" }, "a".repeat(43))).status, 401)
  assert.equal((await post("pair", { phoneId, name: "Test phone" })).body.status, "linked")
  assert.equal((await post("pair", { phoneId, name: "Test phone" })).status, 200)
  assert.equal((await post("pair", { phoneId: randomUUID(), name: "Other phone" })).status, 403)
  const text = "An hour-long conversation.\nSpreker 1: café — 中文 🤖\n".repeat(20000)
  const delivery = { phoneId, id: randomUUID(), recordingId: randomUUID(), title: "Long conversation", text, sha256: createHash("sha256").update(text).digest("hex"), duration: 3600 }
  assert.equal((await post("deliver", { ...delivery, sha256: "0".repeat(64) })).status, 400)
  const replies = await Promise.all([post("deliver", delivery), post("deliver", delivery), post("deliver", delivery)])
  assert.ok(replies.every(reply => reply.body.status === "copied")); assert.equal(writes, 1); assert.equal(clipboard, text)
  const recovered = new Library(root); await recovered.initialize(); const saved = [...recovered.records.values()][0]
  assert.equal(saved.transcript, text); assert.equal(saved.hasAudio, false); assert.equal(saved.duration, 3600); assert.equal(saved.status, "complete")
  await link.close(); clipboard = "User's newer clipboard"
  link = new PhoneLink(root, options); await link.start(0, false)
  assert.equal(link.snapshot().desktopId, code.id)
  assert.equal((await post("deliver", delivery)).body.status, "copied"); assert.equal(writes, 1); assert.equal(clipboard, "User's newer clipboard")
  await link.revoke(code.peerId); assert.equal((await post("deliver", delivery)).status, 401)
})
