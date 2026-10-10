import { expect, test } from "bun:test"
import { createServer, type ServerResponse } from "node:http"
import { copyFile, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { DocumentArtifact, ImageJobState } from "../bitsbytes/types"
import { BBImages, IMAGE_MODELS, pngDimensions, type GeneratedImage, type ImageConfiguration } from "./bitsbytes-images"

const png = await readFile(new URL("../../icons/bitsbytes/64x64.png", import.meta.url))
const imageResponse = JSON.stringify({ data: [{ b64_json: png.toString("base64") }] })
const request = { prompt: "A small blue circle", job_id: "image-fixture" }
const routerCatalogue = {
  data: [
    {
      id: "fixture/image",
      name: "Fixture image",
      architecture: { input_modalities: ["text"], output_modalities: ["image"] },
      supported_parameters: {
        n: { type: "range", min: 1, max: 1 },
        output_format: { type: "enum", values: ["png", "jpeg"] },
      },
    },
    {
      id: "fixture/chat",
      name: "Fixture chat",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    },
  ],
}

async function fixture(waitMs = 1000) {
  const root = await mkdtemp(join(tmpdir(), "bb-images-test-"))
  const state = {
    configuration: { key: "fixture-image-key", model: IMAGE_MODELS[0] } as ImageConfiguration | undefined,
    connections: {} as Partial<Record<"openai" | "openrouter", ImageConfiguration>>,
    routerKey: "fixture-router-key" as string | undefined,
    openaiKey: undefined as string | undefined,
    catalogue: routerCatalogue as { data: Record<string, unknown>[] },
    catalogueRequests: 0,
    response: { status: 200, body: imageResponse, hold: false },
    requests: [] as { authorization: string | undefined; body: Record<string, unknown> }[],
    published: [] as { path: string; sessionID: string; image: GeneratedImage; inputID?: string }[],
    validations: 0,
    validationStarted: undefined as (() => void) | undefined,
    validationPause: undefined as Promise<void> | undefined,
    progress: [] as ImageJobState[],
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
    if (incoming.method === "GET") {
      state.catalogueRequests++
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(state.catalogue))
      return
    }
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
    connection: (provider: "openai" | "openrouter") => state.connections[provider],
    openrouterKey: () => state.routerKey,
    openaiKey: () => state.openaiKey,
    saveConfiguration: async (configuration: ImageConfiguration) => {
      if (state.configuration) state.connections[state.configuration.provider ?? "openai"] = state.configuration
      if (configuration.provider === "openrouter" || configuration.keySource === "provider") configuration = { ...configuration, key: undefined }
      state.configuration = configuration
      state.connections[configuration.provider ?? "openai"] = configuration
    },
    validate: async (path: string) => {
      state.validations++
      expect(await readFile(path)).toEqual(png)
      state.validationStarted?.()
      if (state.validationPause) await state.validationPause
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
    progress: (job: ImageJobState) => state.progress.push(job),
    endpoint: `http://127.0.0.1:${address.port}/images/generations`,
    catalogueEndpoint: `http://127.0.0.1:${address.port}/images/models`,
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

test("configured images require no billed test and publish the first actual request", async () => {
  const f = await fixture()
  try {
    expect(f.service.status()).toMatchObject({ configured: true, available: true })
    expect(f.state.requests).toHaveLength(0)
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

test("missing credentials disable images and changed keys/models do not inherit successful verification", async () => {
  const f = await fixture()
  try {
    f.state.configuration = undefined
    expect(f.service.status()).toMatchObject({ configured: false, available: false })
    await expect(f.service.verify()).rejects.toThrow("imageCredential")
    await f.service.configure({ key: "fixture-image-key" })
    await ready(f.service)
    expect((await f.service.configure({ key: " " })).available).toBe(true)
    expect((await f.service.configure({ model: IMAGE_MODELS[1] })).verifiedAt).toBeUndefined()
    await ready(f.service)
    expect((await f.service.configure({ key: "fixture-other-key" })).verifiedAt).toBeUndefined()
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
])("malformed successful responses never claim verification or publish a document: %s", async (body) => {
  const f = await fixture()
  try {
    f.state.response.body = body
    const result = await f.service.verify()
    expect(result.status).toBe("error")
    expect(result.error).toBe("bb.error.imageOutput")
    expect(result.capability.verifiedAt).toBeUndefined()
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
    expect(f.service.status().verifiedAt).toBeUndefined()
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
    expect(f.service.status().verifiedAt).toBeUndefined()
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

test("OpenRouter uses its dedicated catalogue and native key, verifies PNG, and publishes provider provenance", async () => {
  const f = await fixture()
  try {
    const [first, second] = await Promise.all([f.service.models("openrouter"), f.service.models("openrouter")])
    expect(first).toEqual(second)
    expect(first.map((row) => row.id)).toEqual(["fixture/image"])
    expect(f.state.catalogueRequests).toBe(1)
    await f.service.configure({ provider: "openrouter", model: "fixture/image" })
    expect(f.state.configuration?.key).toBeUndefined()
    expect(f.service.status().available).toBe(true)
    await ready(f.service)
    expect(f.state.requests[0]).toEqual({
      authorization: "Bearer fixture-router-key",
      body: {
        model: "fixture/image",
        prompt: "A simple blue circle on a white background.",
        n: 1,
        output_format: "png",
      },
    })
    const result = await f.service.generate(request, "ses_fixture", "input_fixture")
    expect(result.status).toBe("ready")
    expect(f.state.published[0].image).toMatchObject({
      provider: "openrouter",
      model: "fixture/image",
      width: 64,
      height: 64,
    })
    const restarted = await f.restart()
    expect(restarted.status().available).toBe(true)
    expect((await restarted.generate(request, "ses_fixture", "input_fixture")).status).toBe("ready")
    expect(f.state.requests).toHaveLength(2)
    f.state.routerKey = "new-fixture-key"
    expect(restarted.status().verifiedAt).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

test("switching image providers preserves independent OpenAI verification and disconnect leaves the chat key intact", async () => {
  const f = await fixture()
  try {
    await ready(f.service)
    const openai = f.state.configuration
    await f.service.configure({ provider: "openrouter", model: "fixture/image" })
    await ready(f.service)
    await f.service.configure({ provider: "openai", model: IMAGE_MODELS[0] })
    expect(f.state.configuration?.key).toBe(openai?.key)
    expect(f.service.status().available).toBe(true)
    await f.service.configure({ provider: "openrouter", model: "fixture/image" })
    expect(f.service.status().available).toBe(true)
    await f.service.configure({ provider: "openrouter", disconnect: true })
    expect(f.service.status().available).toBe(false)
    expect(f.service.status().configured).toBe(false)
    expect(f.state.routerKey).toBe("fixture-router-key")
    expect(f.service.status().openrouterConnected).toBe(true)
    await f.service.configure({ provider: "openrouter", model: "fixture/image" })
    expect(f.service.status().configured).toBe(true)
    expect(f.service.status().available).toBe(true)
  } finally {
    await f.cleanup()
  }
})

test("OpenRouter authentication and credit failures never claim a successful image", async () => {
  for (const status of [401, 402, 403]) {
    const f = await fixture()
    try {
      await f.service.configure({ provider: "openrouter", model: "fixture/image" })
      f.state.response = { status, body: JSON.stringify({ error: { code: "fixture-denied" } }), hold: false }
      const result = await f.service.verify()
      expect(result.status).toBe("error")
      expect(result.error).toBe(
        status === 401 ? "bb.error.imageCredential" : status === 402 ? "bb.error.imageQuota" : "bb.error.imageAccess",
      )
      expect(f.service.status().available).toBe(status === 402)
      expect(f.service.status().verifiedAt).toBeUndefined()
      expect(f.state.published).toHaveLength(0)
    } finally {
      await f.cleanup()
    }
  }
})

test("No image generation persists without losing provider choices or making any billed request", async () => {
  const f = await fixture()
  try {
    await f.service.configure({ provider: "openrouter", model: "fixture/image" })
    await f.service.configure({ provider: "none" })
    expect(f.service.status()).toMatchObject({ enabled: false, available: false, model: "fixture/image" })
    const restarted = await f.restart()
    expect(restarted.status().enabled).toBe(false)
    await restarted.configure({ provider: "openrouter" })
    expect(restarted.status()).toMatchObject({ enabled: true, available: true, model: "fixture/image" })
    expect(f.state.requests).toHaveLength(0)
    expect(f.state.routerKey).toBe("fixture-router-key")
  } finally { await f.cleanup() }
})

test("provider-managed OpenAI keys are not cached and disconnect immediately removes generation capability", async () => {
  const f = await fixture()
  try {
    f.state.configuration = undefined
    f.state.openaiKey = "current-native-api-key"
    await f.service.configure({ provider: "openai" })
    expect(f.state.configuration).toMatchObject({ keySource: "provider", key: undefined })
    expect(f.service.status().available).toBe(true)
    f.state.openaiKey = undefined
    f.service.credentialsChanged()
    expect(f.service.status()).toMatchObject({ configured: false, available: false })
    await expect(f.service.generate(request, "ses_fixture", "native-disconnected")).rejects.toThrow("imageUnavailable")
    expect(f.state.requests).toHaveLength(0)
  } finally { await f.cleanup() }
})

test("turning images off or stopping during admission cannot start a billed request", async () => {
  for (const action of ["off", "stop"]) {
    const f = await fixture()
    try {
      const pending = f.service.generate(request, "ses_fixture", "during-admission")
      if (action === "off") await f.service.configure({ provider: "none" })
      else f.service.cancel("ses_fixture")
      expect((await pending).status).toBe("canceled")
      expect(f.state.requests).toHaveLength(0)
      expect(f.state.published).toHaveLength(0)
    } finally { await f.cleanup() }
  }
})

test("auth diagnostics redact secrets and replacing the rejected credential recovers without a test charge", async () => {
  const f = await fixture()
  try {
    await f.service.configure({ provider: "openrouter", model: "fixture/image" })
    f.state.response = { status: 401, body: JSON.stringify({ error: { code: 401, message: "Invalid fixture-router-key Bearer sk-or-v1-secret" } }), hold: false }
    const failed = await f.service.generate(request, "ses_fixture", "first")
    expect(failed).toMatchObject({ status: "error", error: "bb.error.imageCredential", diagnostic: { status: 401, code: "401" } })
    expect(failed.diagnostic?.message).not.toContain("fixture-router-key")
    expect(failed.diagnostic?.message).not.toContain("sk-or-v1-secret")
    expect(f.service.status().available).toBe(false)
    f.state.routerKey = "replacement"
    f.service.credentialsChanged()
    expect(f.service.status()).toMatchObject({ available: true, error: undefined })
    f.state.response = { status: 200, body: imageResponse, hold: false }
    expect((await f.service.generate({ prompt: "New explicit request" }, "ses_fixture", "second")).status).toBe("ready")
    expect(f.state.requests).toHaveLength(2)
    expect(f.state.requests[1].authorization).toBe("Bearer replacement")
  } finally { await f.cleanup() }
})

test.each(["openai", "openrouter"] as const)("%s sends actual reference bytes and retains chat/tool ownership", async (provider) => {
  const f = await fixture()
  try {
    if (provider === "openrouter") {
      f.state.catalogue = { data: [{
        id: "fixture/edit", name: "Fixture edit",
        architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
        supported_parameters: { input_references: { type: "array" } },
      }] }
      await f.service.configure({ provider, model: "fixture/edit" })
    }
    const paths = [join(f.root, "reference-one.png"), join(f.root, "reference-two.png")]
    await Promise.all(paths.map(path => writeFile(path, png)))
    const result = await f.service.generate({ ...request, referenced_image_paths: paths }, "ses_fixture", "reference-input", undefined, "reference-call")
    expect(result.status).toBe("ready")
    expect(f.state.requests).toHaveLength(1)
    const url = `data:image/png;base64,${png.toString("base64")}`
    expect(f.state.requests[0].body).toMatchObject(provider === "openai"
      ? { images: [{ image_url: url }, { image_url: url }] }
      : { input_references: [{ type: "image_url", image_url: { url } }, { type: "image_url", image_url: { url } }] })
    expect(f.service.status().supportsEditing).toBe(true)
    expect(f.service.list("ses_fixture")).toMatchObject([{ inputID: "reference-input", callID: "reference-call", status: "ready", artifact: { id: result.job_id } }])
    expect(f.service.list("another-chat")).toEqual([])
    expect(f.state.progress.map(job => job.status)).toEqual(["preparing", "ready"])
    expect(f.state.progress.every(job => job.inputID === "reference-input" && job.callID === "reference-call")).toBe(true)
    expect(f.state.progress[1].updated).toBeGreaterThanOrEqual(f.state.progress[0].updated)
    expect(await readFile(join(f.root, "image-jobs.json"), "utf8")).not.toContain(url)
  } finally { await f.cleanup() }
})

test("text-only editing and invalid reference files fail before any provider request", async () => {
  const f = await fixture()
  try {
    const path = join(f.root, "reference.png")
    await writeFile(path, png)
    await f.service.configure({ provider: "openrouter", model: "fixture/image" })
    await expect(f.service.generate({ ...request, referenced_image_paths: [path] }, "ses_fixture", "text-only")).rejects.toThrow("imageEditingUnsupported")
    expect(f.state.validations).toBe(0)
    await f.service.configure({ provider: "openai" })
    await writeFile(path, "not an image")
    await expect(f.service.generate({ ...request, referenced_image_paths: [path] }, "ses_fixture", "invalid-reference")).rejects.toThrow("imageReference")
    await expect(f.service.generate({ ...request, referenced_image_paths: ["relative.png"] }, "ses_fixture", "relative-reference")).rejects.toThrow("imageReference")
    expect(f.state.requests).toHaveLength(0)
    expect(f.state.published).toHaveLength(0)
    expect(f.service.list("ses_fixture")).toEqual([])
  } finally { await f.cleanup() }
})

test.each(["stop", "off", "signal"])("%s during reference validation cancels without provider submission", async (action) => {
  const f = await fixture()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    const path = join(f.root, "reference.png")
    await writeFile(path, png)
    f.state.validationStarted = () => started.resolve()
    f.state.validationPause = release.promise
    const controller = new AbortController()
    const pending = f.service.generate({ ...request, referenced_image_paths: [path] }, "ses_fixture", "validation-stop", controller.signal, "validation-call")
    await started.promise
    if (action === "off") await f.service.configure({ provider: "none" })
    if (action === "stop") f.service.cancel("ses_fixture")
    if (action === "signal") controller.abort()
    release.resolve()
    expect((await pending).status).toBe("canceled")
    expect(f.state.requests).toHaveLength(0)
    expect(f.state.published).toHaveLength(0)
    expect(f.service.list("ses_fixture")).toMatchObject([{ status: "canceled", inputID: "validation-stop", callID: "validation-call" }])
    expect((await f.service.generate({ ...request, referenced_image_paths: [path] }, "ses_fixture", "validation-stop")).status).toBe("canceled")
    expect(f.state.requests).toHaveLength(0)
  } finally { release.resolve(); await f.cleanup() }
})

test("concurrent reference preparation deduplicates the eventual image submission", async () => {
  const f = await fixture()
  try {
    const path = join(f.root, "reference.png")
    await writeFile(path, png)
    const input = { ...request, referenced_image_paths: [path] }
    const results = await Promise.all([
      f.service.generate(input, "ses_fixture", "concurrent-references"),
      f.service.generate(input, "ses_fixture", "concurrent-references"),
    ])
    expect(results.every(result => result.status === "ready")).toBe(true)
    expect(results[0].job_id).toBe(results[1].job_id)
    expect(f.state.requests).toHaveLength(1)
    expect(f.state.published).toHaveLength(1)
    expect(f.service.list("ses_fixture")).toHaveLength(1)
  } finally { await f.cleanup() }
})
