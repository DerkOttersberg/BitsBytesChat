import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { DocumentArtifact } from "../bitsbytes/types"
import { stateRecord } from "./bitsbytes-state"

export const IMAGE_MODELS = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2"] as const
export type ImageConfiguration = {
  key?: string
  model: string
  verified?: { fingerprint: string; at: number }
  error?: string
}
export type ImageStatus = {
  configured: boolean
  available: boolean
  model: string
  models: readonly string[]
  verifiedAt?: number
  error?: string
  revision: number
}
export type GeneratedImage = { width: number; height: number; provider: "openai"; model: string; jobID: string }
type Job = {
  id: string
  sessionID: string
  signature: string
  model: string
  created: number
  updated: number
  status: "preparing" | "ready" | "error" | "canceled" | "uncertain"
  verification?: boolean
  inputID?: string
  image?: GeneratedImage
  artifact?: DocumentArtifact
  error?: string
  requestID?: string
}
type Options = {
  configuration: () => ImageConfiguration | undefined
  saveConfiguration: (value: ImageConfiguration) => Promise<void>
  validate: (path: string) => Promise<unknown>
  publish: (path: string, sessionID: string, image: GeneratedImage, inputID?: string) => Promise<DocumentArtifact>
  changed: () => void
  endpoint?: string
  waitMs?: number
}

// Image credentials and successful image inference are deliberately independent
// of the conversational provider catalogue and its OAuth credential.
export class BBImages {
  private jobs: Job[] = []
  private active = new Map<string, { abort: AbortController; done: Promise<void> }>()
  private saving = Promise.resolve()
  private configuring = Promise.resolve()
  private listeners = new Set<() => void>()
  private revision = 0
  private historyUncertain = false
  constructor(
    private root: string,
    private options: Options,
  ) {}

  async start() {
    const source = await readFile(join(this.root, "image-jobs.json"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    this.historyUncertain = await readFile(join(this.root, "image-history-uncertain")).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    )
    let stored: unknown = []
    try {
      stored = source === undefined ? [] : JSON.parse(source)
    } catch {
      stored = undefined
    }
    this.jobs = (Array.isArray(stored) ? stored : []).flatMap((value) => {
      if (validJob(value)) return [value as Job]
      // Keep recognizable identities as tombstones. Losing one malformed row
      // must never make its old billed request look like a new admission.
      if (stateRecord(value) && typeof value.id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value.id))
        return [
          {
            id: value.id,
            sessionID: typeof value.sessionID === "string" ? value.sessionID : "",
            signature: "lost",
            model: typeof value.model === "string" ? value.model : "",
            created: Date.now(),
            updated: Date.now(),
            status: "uncertain" as const,
            error: "bb.error.imageStorage",
          },
        ]
      this.historyUncertain = true
      return []
    })
    if (!Array.isArray(stored)) this.historyUncertain = true
    if (source !== undefined && (!Array.isArray(stored) || stored.some((value) => !validJob(value))))
      await writeFile(join(this.root, `image-jobs-recovery-${randomUUID()}.json`), source)
    if (this.historyUncertain)
      await writeFile(
        join(this.root, "image-history-uncertain"),
        "Some billed job identities could not be recovered. Automatic new image submissions are disabled.",
      )
    // A lost HTTP response is not evidence that the provider did no work.
    // Never repeat a potentially billed submission after a process restart.
    for (const job of this.jobs)
      if (job.status === "preparing") {
        job.status = "uncertain"
        job.error = "bb.error.imageUncertain"
      }
    await this.persist()
  }

  status(): ImageStatus {
    const configuration = this.options.configuration()
    return {
      configured: Boolean(configuration?.key),
      available: Boolean(
        !this.historyUncertain &&
          configuration?.key &&
          configuration.verified?.fingerprint === fingerprint(configuration),
      ),
      model: configuration?.model ?? IMAGE_MODELS[0],
      models: IMAGE_MODELS,
      verifiedAt: configuration?.verified?.at,
      error: this.historyUncertain ? "bb.error.imageStorage" : configuration?.error,
      revision: this.revision,
    }
  }

  async configure(args: { key?: string; model?: string; disconnect?: boolean }) {
    const operation = this.configuring.then(async () => {
      const previous = this.options.configuration()
      const model = args.model ?? previous?.model ?? IMAGE_MODELS[0]
      if (!IMAGE_MODELS.includes(model as (typeof IMAGE_MODELS)[number])) throw new Error("bb.error.imageModel")
      const key = args.disconnect ? undefined : args.key?.trim() || previous?.key
      if (key && (key.length > 4096 || /[\r\n\0]/.test(key))) throw new Error("bb.error.imageCredential")
      const unchanged = key === previous?.key && model === previous?.model
      await this.options.saveConfiguration({
        key,
        model,
        ...(unchanged ? { verified: previous?.verified, error: previous?.error } : {}),
      })
      if (!unchanged) for (const operation of this.active.values()) operation.abort.abort()
      this.changed()
      return this.status()
    })
    this.configuring = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  async verify(signal?: AbortSignal) {
    if (this.historyUncertain) throw new Error("bb.error.imageStorage")
    const configuration = this.options.configuration()
    if (!configuration?.key) throw new Error("bb.error.imageCredential")
    const job = await this.begin(
      "",
      `verify-${randomUUID()}`,
      {
        prompt: "A simple blue circle on a white background.",
        quality: "low",
        size: "1024x1024",
        background: "opaque",
      },
      configuration,
      true,
    )
    await this.wait(job, signal)
    return { ...this.result(job), capability: this.status() }
  }

  async generate(args: Record<string, unknown>, sessionID: string, inputID: string, signal?: AbortSignal) {
    if (!sessionID || !inputID) throw new Error("bb.error.invalidRequest")
    const request = imageRequest(args)
    const id =
      args.job_id === undefined
        ? createHash("sha256")
            .update(JSON.stringify([sessionID, inputID, request]))
            .digest("hex")
            .slice(0, 32)
        : String(args.job_id)
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("bb.error.invalidRequest")
    const previous =
      this.jobs.find((job) => job.id === id) ??
      this.jobs.find(
        (job) =>
          !job.verification &&
          job.sessionID === sessionID &&
          job.inputID === inputID &&
          job.signature === signature(request),
      )
    if (previous) {
      if (previous.signature === "lost") throw new Error("bb.error.imageUncertain")
      if (previous.sessionID !== sessionID || previous.verification || previous.signature !== signature(request))
        throw new Error("bb.error.deliveryConflict")
      // An explicit retry may finish publishing already received bytes. It must
      // never resubmit the original, potentially billed provider request.
      if (!this.active.has(previous.id) && previous.status !== "ready" && previous.status !== "canceled")
        await this.recover(previous, signal)
      await this.wait(previous, signal)
      return this.result(previous)
    }
    if (this.historyUncertain) throw new Error("bb.error.imageUncertain")
    // A model-supplied new job ID or revised prompt is not human authorization
    // to repeat work whose billed outcome is unknown. A new human input owns
    // its own admission; polling/recovery stays bound to the original job.
    if (
      this.jobs.some(
        (job) =>
          job.sessionID === sessionID &&
          job.inputID === inputID &&
          (job.status === "uncertain" || job.status === "canceled" || job.error === "bb.error.imageStorage"),
      )
    )
      throw new Error("bb.error.imageUncertain")
    const configuration = this.options.configuration()
    if (!configuration?.key || !this.status().available) throw new Error("bb.error.imageUnavailable")
    const job = await this.begin(sessionID, id, request, configuration, false, inputID)
    await this.wait(job, signal)
    return this.result(job)
  }

  async job(id: string, sessionID?: string, signal?: AbortSignal) {
    const job = this.jobs.find((row) => row.id === id && (sessionID === undefined || row.sessionID === sessionID))
    if (!job) throw new Error("bb.error.invalidRequest")
    await this.wait(job, signal)
    return { ...this.result(job), capability: this.status() }
  }

  cancel(sessionID: string) {
    for (const job of this.jobs) if (job.sessionID === sessionID) this.active.get(job.id)?.abort.abort()
  }

  async capabilities(revision?: number, signal?: AbortSignal) {
    if (revision === this.revision && !signal?.aborted)
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          signal?.removeEventListener("abort", finish)
          this.listeners.delete(finish)
          resolve()
        }
        const timer = setTimeout(finish, 30000)
        this.listeners.add(finish)
        signal?.addEventListener("abort", finish, { once: true })
      })
    return this.status()
  }

  private async begin(
    sessionID: string,
    id: string,
    request: ReturnType<typeof imageRequest>,
    configuration: ImageConfiguration,
    verification = false,
    inputID?: string,
  ) {
    const job: Job = {
      id,
      sessionID,
      signature: signature(request),
      model: configuration.model,
      created: Date.now(),
      updated: Date.now(),
      status: "preparing",
      verification,
      inputID,
    }
    this.jobs.push(job)
    // Commit the admission before making the first potentially billed request.
    try {
      await this.persist()
    } catch (error) {
      this.jobs = this.jobs.filter((row) => row !== job)
      throw error
    }
    const abort = new AbortController()
    const done = this.execute(job, request, { ...configuration }, abort.signal)
      .catch(() => {
        job.status = "uncertain"
        job.error = "bb.error.imageStorage"
        this.options.changed()
      })
      .finally(() => this.active.delete(id))
    this.active.set(id, { abort, done })
    return job
  }

  private async execute(
    job: Job,
    request: ReturnType<typeof imageRequest>,
    configuration: ImageConfiguration,
    signal: AbortSignal,
  ) {
    try {
      const response = await fetch(this.options.endpoint ?? "https://api.openai.com/v1/images/generations", {
        method: "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(600000)]),
        headers: { Authorization: `Bearer ${configuration.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: configuration.model, ...request, n: 1, output_format: "png" }),
      })
      job.requestID = response.headers.get("x-request-id") ?? undefined
      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as { error?: { code?: string } }
        const code =
          response.status === 401
            ? "bb.error.imageCredential"
            : response.status === 403
              ? "bb.error.imageAccess"
              : response.status === 429
                ? "bb.error.imageQuota"
                : error.error?.code?.includes("moderation") || error.error?.code === "content_policy_violation"
                  ? "bb.error.imageRefused"
                  : "bb.error.imageRequest"
        if (
          [401, 403, 404].includes(response.status) &&
          fingerprint(this.options.configuration()) === fingerprint(configuration)
        ) {
          await this.options.saveConfiguration({ ...configuration, verified: undefined, error: code })
          this.changed()
        }
        throw new Error(code)
      }
      const chunks: Uint8Array[] = []
      let length = 0
      if (!response.body) throw new Error("bb.error.imageOutput")
      for await (const chunk of response.body) {
        length += chunk.length
        if (length > 32 * 1024 * 1024) throw new Error("bb.error.imageOutput")
        chunks.push(chunk)
      }
      let result: { data?: { b64_json?: string }[] }
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        if (!stateRecord(value)) throw new Error()
        result = value
      } catch {
        throw new Error("bb.error.imageOutput")
      }
      const encoded = result.data?.[0]?.b64_json
      if (typeof encoded !== "string" || !encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
        throw new Error("bb.error.imageOutput")
      const bytes = Buffer.from(encoded, "base64")
      const dimensions = pngDimensions(bytes)
      signal.throwIfAborted()
      const folder = join(this.root, "image-jobs", job.id)
      await mkdir(folder, { recursive: true })
      const path = join(folder, "image.png")
      await writeFile(path + ".tmp.png", bytes)
      await this.options.validate(path + ".tmp.png")
      signal.throwIfAborted()
      await rename(path + ".tmp.png", path)
      job.image = { ...dimensions, provider: "openai", model: configuration.model, jobID: job.id }
      await this.persist()
      if (!job.verification) job.artifact = await this.publish(job, path)
      if (job.verification && fingerprint(this.options.configuration()) === fingerprint(configuration)) {
        await this.options.saveConfiguration({
          ...configuration,
          verified: { fingerprint: fingerprint(configuration), at: Date.now() },
          error: undefined,
        })
        this.changed()
      }
      job.status = "ready"
    } catch (error) {
      job.status = signal.aborted
        ? "canceled"
        : error instanceof Error && error.message.startsWith("bb.error.")
          ? "error"
          : "uncertain"
      job.error = signal.aborted
        ? "bb.error.imageCanceled"
        : job.status === "uncertain"
          ? "bb.error.imageUncertain"
          : (error as Error).message
    }
    job.updated = Date.now()
    await this.persist()
    this.options.changed()
  }

  private async publish(job: Job, path: string) {
    const artifact = await this.options.publish(path, job.sessionID, job.image!, job.inputID)
    if (artifact.status !== "ready" || artifact.kind !== "image" || artifact.sessionID !== job.sessionID)
      throw new Error("bb.error.imageStorage")
    return artifact
  }

  private async recover(job: Job, signal?: AbortSignal) {
    const abort = new AbortController()
    const done = (async () => {
      const path = join(this.root, "image-jobs", job.id, "image.png")
      const bytes = await readFile(path).catch(() => undefined)
      if (!bytes) return
      try {
        const dimensions = pngDimensions(bytes)
        await this.options.validate(path)
        abort.signal.throwIfAborted()
        job.image = { ...dimensions, provider: "openai", model: job.model, jobID: job.id }
        job.artifact = await this.publish(job, path)
        job.status = "ready"
        job.error = undefined
      } catch (error) {
        job.status = abort.signal.aborted ? "canceled" : "error"
        job.error = abort.signal.aborted ? "bb.error.imageCanceled" : "bb.error.imageStorage"
      }
      job.updated = Date.now()
      await this.persist()
      this.options.changed()
    })()
      .catch(() => {
        job.status = "uncertain"
        job.error = "bb.error.imageStorage"
      })
      .finally(() => this.active.delete(job.id))
    this.active.set(job.id, { abort, done })
    await this.wait(job, signal)
  }

  private async wait(job: Job, signal?: AbortSignal) {
    const running = this.active.get(job.id)
    if (!running) return
    const cancel = () => running.abort.abort()
    if (signal?.aborted) cancel()
    signal?.addEventListener("abort", cancel, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        running.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.options.waitMs ?? 30000)
        }),
      ])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
    }
  }

  private result(job: Job) {
    return {
      job_id: job.id,
      status: job.status,
      image: job.image,
      artifact: job.artifact,
      error: job.error,
      requestID: job.requestID,
      ...(job.status === "preparing" ? { retryAfterMs: 1000 } : {}),
    }
  }
  private changed() {
    this.revision++
    for (const listener of [...this.listeners]) listener()
    this.options.changed()
  }
  private persist() {
    const operation = this.saving
      .catch(() => undefined)
      .then(async () => {
        const path = join(this.root, "image-jobs.json")
        await writeFile(path + ".tmp", JSON.stringify(this.jobs))
        await rename(path + ".tmp", path)
      })
    this.saving = operation
    return operation
  }
}

function fingerprint(configuration?: ImageConfiguration) {
  return createHash("sha256")
    .update(`${configuration?.key ?? ""}\0${configuration?.model ?? ""}`)
    .digest("hex")
}
function signature(request: ReturnType<typeof imageRequest>) {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex")
}
export function imageRequest(args: Record<string, unknown>) {
  if (typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 32000)
    throw new Error("bb.error.imagePrompt")
  const quality = String(args.quality ?? "medium"),
    size = String(args.size ?? "auto"),
    background = String(args.background ?? "opaque")
  if (
    !["low", "medium", "high", "auto"].includes(quality) ||
    !["auto", "1024x1024", "1536x1024", "1024x1536"].includes(size) ||
    !["opaque", "transparent"].includes(background)
  )
    throw new Error("bb.error.invalidRequest")
  return { prompt: args.prompt.trim(), quality, size, background }
}
export function pngDimensions(bytes: Buffer) {
  if (
    bytes.length < 33 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.subarray(12, 16).toString() !== "IHDR"
  )
    throw new Error("bb.error.imageOutput")
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20)
  if (!width || !height || width * height > 40_000_000) throw new Error("bb.error.imageOutput")
  return { width, height }
}
function validJob(value: unknown) {
  return (
    stateRecord(value) &&
    typeof value.id === "string" &&
    /^[a-zA-Z0-9-]{1,80}$/.test(value.id) &&
    typeof value.sessionID === "string" &&
    typeof value.signature === "string" &&
    typeof value.model === "string" &&
    (value.inputID === undefined || typeof value.inputID === "string") &&
    (value.verification === undefined || typeof value.verification === "boolean") &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.requestID === undefined || typeof value.requestID === "string") &&
    (value.image === undefined ||
      (stateRecord(value.image) &&
        Number.isSafeInteger(value.image.width) &&
        Number.isSafeInteger(value.image.height) &&
        Number(value.image.width) > 0 &&
        Number(value.image.height) > 0 &&
        value.image.provider === "openai" &&
        value.image.model === value.model &&
        value.image.jobID === value.id)) &&
    (value.artifact === undefined ||
      (stateRecord(value.artifact) &&
        typeof value.artifact.id === "string" &&
        value.artifact.sessionID === value.sessionID &&
        typeof value.artifact.filename === "string" &&
        typeof value.artifact.path === "string" &&
        typeof value.artifact.hash === "string" &&
        Number.isSafeInteger(value.artifact.revision) &&
        Number(value.artifact.revision) > 0 &&
        value.artifact.kind === "image" &&
        value.artifact.status === "ready")) &&
    (value.status !== "ready" || value.verification === true || value.artifact !== undefined) &&
    Number.isFinite(value.created) &&
    Number.isFinite(value.updated) &&
    typeof value.status === "string" &&
    ["preparing", "ready", "error", "canceled", "uncertain"].includes(value.status)
  )
}
