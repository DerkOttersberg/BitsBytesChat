import { expect, test } from "bun:test"
import { createServer, type ServerResponse } from "node:http"
import { copyFile, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { DocumentArtifact } from "../bitsbytes/types"
import { BBImages, IMAGE_MODELS, pngDimensions, type GeneratedImage, type ImageConfiguration } from "./bitsbytes-images"

const png = await readFile(new URL("../../icons/bitsbytes/64x64.png", import.meta.url))
const imageResponse = JSON.stringify({ data: [{ b64_json: png.toString("base64") }] })
const request = { prompt: "A small blue circle", job_id: "image-fixture" }

async function fixture(waitMs = 1000) {
  const root = await mkdtemp(join(tmpdir(), "bb-images-test-"))
  const state = {
    configuration: { key: "fixture-image-key", model: IMAGE_MODELS[0] } as ImageConfiguration | undefined,
    response: { status: 200, body: imageResponse, hold: false },
    requests: [] as { authorization: string | undefined; body: Record<string, unknown> }[],
    published: [] as { path: string; sessionID: string; image: GeneratedImage; inputID?: string }[],
    validations: 0,
    changes: 0,
    failPublication: false,
    artifactError: false,
    blockJournal: false,
  }
  const pending: ServerResponse[] = []
  const respond = (response: ServerResponse) => {
    response.writeHead(state.response.status, { "Content-Type": "application/json", "x-request-id": "req_fixture" })
    response.end(state.response.body)
  }
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    state.requests.push({
      authorization: incoming.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    })
    if (state.response.hold) {
      pending.push(response)
      return
    }
    respond(response)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture did not open a local TCP port")
  const options = {
    configuration: () => state.configuration,
    saveConfiguration: async (configuration: ImageConfiguration) => {
      state.configuration = configuration
    },
    validate: async (path: string) => {
      state.validations++
      expect(await readFile(path)).toEqual(png)
      if (state.blockJournal) await mkdir(join(root, "image-jobs.json.tmp"))
    },
    publish: async (
      path: string,
      sessionID: string,
      image: GeneratedImage,
      inputID?: string,
    ): Promise<DocumentArtifact> => {
      state.published.push({ path, sessionID, image, inputID })
      if (state.failPublication) throw new Error("Fixture publication is temporarily unavailable")
      return {
        id: image.jobID,
        path,
        source: path,
        filename: "image.png",
        sessionID,
        image,
        kind: "image",
        mime: "image/png",
        revision: 1,
        hash: "fixture",
        status: state.artifactError ? "error" : "ready",
        updated: 1,
        pdf: "",
        error: "",
      }
    },
    changed: () => {
      state.changes++
    },
    endpoint: `http://127.0.0.1:${address.port}/images/generations`,
    waitMs,
  }
  const service = new BBImages(root, options)
  await service.start()
  return {
    root,
    state,
    service,
    release: () => {
      state.response.hold = false
      for (const response of pending.splice(0)) respond(response)
    },
    restart: async (path = root) => {
      const next = new BBImages(path, options)
      await next.start()
      return next
    },
    cleanup: async () => {
      service.cancel("")
      service.cancel("ses_fixture")
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error("Unexpected test directory")
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function ready(service: BBImages) {
  const verification = await service.verify()
  expect(verification.status).toBe("ready")
  expect(verification.capability.available).toBe(true)
}

test("image capability requires a validated PNG and publishes the actual generation into the artifact system", async () => {
  const f = await fixture()
  try {
    expect(f.service.status()).toMatchObject({ configured: true, available: false })
    await expect(f.service.generate(request, "ses_fixture", "msg_fixture")).rejects.toThrow("imageUnavailable")
    expect(f.state.requests).toHaveLength(0)
    await ready(f.service)
    expect(f.state.validations).toBe(1)
    expect(f.state.published).toHaveLength(0)
    expect(f.state.requests[0].body).toMatchObject({
      model: IMAGE_MODELS[0],
      quality: "low",
      n: 1,
      output_format: "png",
    })
    const result = await f.service.generate(request, "ses_fixture", "msg_fixture")
    expect(result).toMatchObject({
      status: "ready",
      requestID: "req_fixture",
      image: { width: 64, height: 64, provider: "openai", model: IMAGE_MODELS[0] },
    })
    expect(f.state.published).toHaveLength(1)
    expect(f.state.published[0].sessionID).toBe("ses_fixture")
    expect(f.state.published[0].inputID).toBe("msg_fixture")
    expect(await readFile(result.artifact!.source!)).toEqual(png)
    expect(pngDimensions(await readFile(result.artifact!.source!))).toEqual({ width: 64, height: 64 })
    expect(f.state.requests.every((row) => row.authorization === "Bearer fixture-image-key")).toBe(true)
    const saved = await readFile(join(f.root, "image-jobs.json"), "utf8")
    expect(saved).not.toContain("fixture-image-key")
    expect(saved).not.toContain(png.toString("base64"))
    expect(JSON.stringify(f.service.status())).not.toContain("fixture-image-key")
  } finally {
    await f.cleanup()
  }
})

test("missing credentials and changed keys or models cannot inherit a previous image capability", async () => {
  const f = await fixture()
  try {
    f.state.configuration = undefined
    expect(f.service.status()).toMatchObject({ configured: false, available: false })
    await expect(f.service.verify()).rejects.toThrow("imageCredential")
    await f.service.configure({ key: "fixture-image-key" })
    await ready(f.service)
    expect((await f.service.configure({ key: " " })).available).toBe(true)
    expect((await f.service.configure({ model: IMAGE_MODELS[1] })).available).toBe(false)
    await expect(f.service.generate(request, "ses_fixture", "msg_fixture")).rejects.toThrow("imageUnavailable")
    await ready(f.service)
    expect((await f.service.configure({ key: "fixture-other-key" })).available).toBe(false)
    await ready(f.service)
    expect((await f.service.configure({ disconnect: true })).configured).toBe(false)
    expect(f.service.status().available).toBe(false)
    await expect(f.service.configure({ model: "a-chat-model" })).rejects.toThrow("imageModel")
    await expect(f.service.configure({ key: "fixture\ninvalid" })).rejects.toThrow("imageCredential")
  } finally {
    await f.cleanup()
  }
})

test.each([
  { status: 401, code: "invalid_api_key", error: "imageCredential", available: false },
  { status: 403, code: "access_denied", error: "imageAccess", available: false },
  { status: 404, code: "model_not_found", error: "imageRequest", available: false },
  { status: 429, code: "insufficient_quota", error: "imageQuota", available: true },
  { status: 400, code: "content_policy_violation", error: "imageRefused", available: true },
  { status: 400, code: "moderation_blocked", error: "imageRefused", available: true },
])("provider failure $status/$code is explicit and updates capability appropriately", async (row) => {
  const f = await fixture()
  try {
    await ready(f.service)
    f.state.response = { status: row.status, body: JSON.stringify({ error: { code: row.code } }), hold: false }
    const result = await f.service.generate(request, "ses_fixture", "msg_fixture")
    expect(result.status).toBe("error")
    expect(result.error).toBe("bb.error." + row.error)
    expect(f.service.status().available).toBe(row.available)
    expect(f.state.published).toHaveLength(0)
    const retried = await f.service.generate(request, "ses_fixture", "msg_fixture")
    expect(retried.error).toBe(result.error)
    expect(f.state.requests).toHaveLength(2)
  } finally {
    await f.cleanup()
  }
})

test.each([
  JSON.stringify({ data: [{ b64_json: "not base64!" }] }),
  JSON.stringify({ data: [{ b64_json: Buffer.from("not a PNG").toString("base64") }] }),
  JSON.stringify({ data: [] }),
  "{broken",
  "null",
])("malformed successful responses never advertise image capability or publish a document: %s", async (body) => {
  const f = await fixture()
  try {
    f.state.response.body = body
    const result = await f.service.verify()
    expect(result.status).toBe("error")
    expect(result.error).toBe("bb.error.imageOutput")
    expect(result.capability.available).toBe(false)
    expect(f.state.validations).toBe(0)
    expect(f.state.published).toHaveLength(0)
  } finally {
    await f.cleanup()
  }
})

test("oversized PNG dimensions are rejected before the decoder or publisher sees the bytes", async () => {
  const f = await fixture()
  try {
    const oversized = Buffer.from(png)
    oversized.writeUInt32BE(100_000, 16)
    oversized.writeUInt32BE(100_000, 20)
    f.state.response.body = JSON.stringify({ data: [{ b64_json: oversized.toString("base64") }] })
    const result = await f.service.verify()
    expect(result.error).toBe("bb.error.imageOutput")
    expect(f.state.validations).toBe(0)
    expect(f.service.status().available).toBe(false)
  } finally {
    await f.cleanup()
  }
})

test("same-job delivery and polling deduplicate billed submissions and reject conflicting ownership or prompts", async () => {
  const f = await fixture()
  try {
    await ready(f.service)
    const [first, duplicate] = await Promise.all([
      f.service.generate(request, "ses_fixture", "msg_fixture"),
      f.service.generate(request, "ses_fixture", "msg_fixture"),
    ])
    expect(first.job_id).toBe(duplicate.job_id)
    expect((await f.service.job(first.job_id, "ses_fixture")).status).toBe("ready")
    expect(f.state.requests).toHaveLength(2)
    expect(f.state.published).toHaveLength(1)
    await expect(
      f.service.generate({ ...request, prompt: "A changed prompt" }, "ses_fixture", "msg_fixture"),
    ).rejects.toThrow("deliveryConflict")
    await expect(f.service.generate(request, "ses_other", "msg_fixture")).rejects.toThrow("deliveryConflict")
    await expect(f.service.job(first.job_id, "ses_other")).rejects.toThrow("invalidRequest")
    expect((await f.service.generate(request, "ses_fixture", "msg_other")).status).toBe("ready")
    expect(f.state.requests).toHaveLength(2)
  } finally {
    await f.cleanup()
  }
})

test("interruption cancels a pending generation and retrying that job does not submit it again", async () => {
  const f = await fixture(25)
  try {
    await ready(f.service)
    f.state.response.hold = true
    const pending = await f.service.generate(request, "ses_fixture", "msg_fixture")
    expect(pending).toMatchObject({ status: "preparing", retryAfterMs: 1000 })
    f.service.cancel("ses_fixture")
    expect((await f.service.job(pending.job_id, "ses_fixture")).status).toBe("canceled")
    const repeated = await f.service.generate(request, "ses_fixture", "msg_fixture")
    expect(repeated).toMatchObject({ status: "canceled", error: "bb.error.imageCanceled" })
    expect(f.state.requests).toHaveLength(2)
    expect(f.state.published).toHaveLength(0)
  } finally {
    await f.cleanup()
  }
})

test("changing image credentials cancels an in-flight request without granting the new key old capability", async () => {
  const f = await fixture(25)
  try {
    await ready(f.service)
    f.state.response.hold = true
    const pending = await f.service.generate(request, "ses_fixture", "msg_fixture")
    await f.service.configure({ key: "fixture-replacement" })
    f.release()
    expect((await f.service.job(pending.job_id, "ses_fixture")).status).toBe("canceled")
    expect(f.service.status().available).toBe(false)
    expect(f.state.configuration?.key).toBe("fixture-replacement")
    expect(f.state.published).toHaveLength(0)
  } finally {
    await f.cleanup()
  }
})

test("a restart preserves an uncertain in-flight request without automatically resubmitting it", async () => {
  const f = await fixture(25)
  try {
    await ready(f.service)
    f.state.response.hold = true
    const pending = await f.service.generate(request, "ses_fixture", "msg_fixture")
    const restartedRoot = join(f.root, "restarted")
    await mkdir(restartedRoot)
    await copyFile(join(f.root, "image-jobs.json"), join(restartedRoot, "image-jobs.json"))
    f.service.cancel("ses_fixture")
    await f.service.job(pending.job_id, "ses_fixture")
    const restarted = await f.restart(restartedRoot)
    expect(await restarted.job(pending.job_id, "ses_fixture")).toMatchObject({
      status: "uncertain",
      error: "bb.error.imageUncertain",
    })
    expect(await restarted.generate(request, "ses_fixture", "msg_fixture")).toMatchObject({
      status: "uncertain",
      error: "bb.error.imageUncertain",
    })
    expect(
      await restarted.generate({ ...request, job_id: "new-model-alias" }, "ses_fixture", "msg_fixture"),
    ).toMatchObject({ job_id: pending.job_id, status: "uncertain" })
    await expect(
      restarted.generate(
        { ...request, job_id: "revised-alias", prompt: "A changed description" },
        "ses_fixture",
        "msg_fixture",
      ),
    ).rejects.toThrow("imageUncertain")
    expect(f.state.requests).toHaveLength(2)
    expect(f.state.published).toHaveLength(0)
  } finally {
    await f.cleanup()
  }
})

test("publication failure is recoverable from the exact saved PNG after restart without another provider request", async () => {
  const f = await fixture()
  try {
    await ready(f.service)
    f.state.failPublication = true
    const failed = await f.service.generate(request, "ses_fixture", "msg_fixture")
    expect(failed.status).not.toBe("ready")
    expect(await readFile(join(f.root, "image-jobs", failed.job_id, "image.png"))).toEqual(png)
    f.state.failPublication = false
    const restarted = await f.restart()
    const recovered = await restarted.generate(request, "ses_fixture", "msg_fixture")
    expect(recovered.status).toBe("ready")
    expect(recovered.error).toBeUndefined()
    expect(await readFile(recovered.artifact!.source!)).toEqual(png)
    expect(f.state.requests).toHaveLength(2)
    expect(f.state.published).toHaveLength(2)
    expect(f.state.published.every((row) => row.inputID === "msg_fixture")).toBe(true)
  } finally {
    await f.cleanup()
  }
})

test("a failed artifact journal cannot claim a ready image and recovers without another billed submission", async () => {
  const f = await fixture()
  try {
    await ready(f.service)
    f.state.artifactError = true
    const failed = await f.service.generate(request, "ses_fixture", "msg_fixture")
    expect(failed).toMatchObject({ status: "error", error: "bb.error.imageStorage" })
    expect(failed.artifact).toBeUndefined()
    f.state.artifactError = false
    const recovered = await (await f.restart()).generate(request, "ses_fixture", "msg_fixture")
    expect(recovered.status).toBe("ready")
    expect(f.state.requests).toHaveLength(2)
  } finally {
    await f.cleanup()
  }
})

test("failed durable admission makes no provider request and remains retryable", async () => {
  const f = await fixture()
  try {
    await ready(f.service)
    await mkdir(join(f.root, "image-jobs.json.tmp"))
    await expect(f.service.generate(request, "ses_fixture", "msg_fixture")).rejects.toThrow()
    expect(f.state.requests).toHaveLength(1)
    await rmdir(join(f.root, "image-jobs.json.tmp"))
    expect((await f.service.generate(request, "ses_fixture", "msg_fixture")).status).toBe("ready")
    expect(f.state.requests).toHaveLength(2)
  } finally {
    await f.cleanup()
  }
})

test("a damaged job preserves valid neighbors and reserves its billed identity", async () => {
  const f = await fixture()
  try {
    await ready(f.service)
    const completed = await f.service.generate(request, "ses_fixture", "msg_fixture")
    const path = join(f.root, "image-jobs.json")
    const saved = JSON.parse(await readFile(path, "utf8"))
    await writeFile(path, JSON.stringify([...saved, { id: "damaged-job", sessionID: "ses_fixture", status: "broken" }]))
    const restarted = await f.restart()
    expect((await restarted.generate(request, "ses_fixture", "msg_fixture")).artifact?.id).toBe(completed.artifact?.id)
    await expect(
      restarted.generate({ ...request, job_id: "damaged-job" }, "ses_fixture", "msg_fixture"),
    ).rejects.toThrow("imageUncertain")
    expect(f.state.requests).toHaveLength(2)
  } finally {
    await f.cleanup()
  }
})

test("an unreadable job journal disables new billing across repeated restarts", async () => {
  const f = await fixture()
  try {
    await ready(f.service)
    await writeFile(join(f.root, "image-jobs.json"), "{damaged")
    for (let index = 0; index < 2; index++) {
      const restarted = await f.restart()
      expect(restarted.status()).toMatchObject({ available: false, error: "bb.error.imageStorage" })
      await expect(restarted.generate(request, "ses_fixture", "msg_fixture")).rejects.toThrow("imageUncertain")
      await expect(restarted.verify()).rejects.toThrow("imageStorage")
    }
    expect(f.state.requests).toHaveLength(1)
  } finally {
    await f.cleanup()
  }
})

test("journal failure after receiving PNG bytes recovers locally after restart", async () => {
  const f = await fixture()
  try {
    await ready(f.service)
    f.state.blockJournal = true
    const failed = await f.service.generate(request, "ses_fixture", "msg_fixture")
    expect(failed).toMatchObject({ status: "uncertain", error: "bb.error.imageStorage" })
    expect(await readFile(join(f.root, "image-jobs", failed.job_id, "image.png"))).toEqual(png)
    f.state.blockJournal = false
    await rmdir(join(f.root, "image-jobs.json.tmp"))
    const restarted = await f.restart()
    const recovered = await restarted.generate(request, "ses_fixture", "msg_fixture")
    expect(recovered.status).toBe("ready")
    expect(await readFile(recovered.artifact!.source!)).toEqual(png)
    expect(f.state.requests).toHaveLength(2)
    expect(f.state.published).toHaveLength(1)
  } finally {
    await f.cleanup()
  }
})
