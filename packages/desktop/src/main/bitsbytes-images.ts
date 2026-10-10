import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import type { DocumentArtifact, ImageJobState } from "../bitsbytes/types"
import { stateRecord } from "./bitsbytes-state"
import { imageCatalog, routerImageRequest, type ImageModel, type ImageProvider } from "./bitsbytes-image-catalog"

export const IMAGE_MODELS = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2"] as const
export type ImageConfiguration = {
  provider?: ImageProvider
  disabled?: boolean
  key?: string
  keySource?: "provider" | "separate"
  model: string
  verified?: { fingerprint: string; at: number }
  error?: string
  errorFingerprint?: string
}
export type ImageStatus = {
  provider: ImageProvider
  enabled: boolean
  openrouterConnected: boolean
  connections: Partial<Record<ImageProvider, { model: string; configured: boolean }>>
  configured: boolean
  available: boolean
  model: string
  models: readonly string[]
  supportsEditing: boolean
  editingModels: readonly string[]
  verifiedAt?: number
  error?: string
  revision: number
}
export type GeneratedImage = { width: number; height: number; provider: ImageProvider; model: string; jobID: string }
type Job = {
  id: string
  sessionID: string
  signature: string
  model: string
  provider?: ImageProvider
  created: number
  updated: number
  status: "preparing" | "ready" | "error" | "canceled" | "uncertain"
  verification?: boolean
  inputID?: string
  callID?: string
  image?: GeneratedImage
  artifact?: DocumentArtifact
  error?: string
  requestID?: string
  diagnostic?: { status: number; code?: string; message?: string }
}
type Options = {
  configuration: () => ImageConfiguration | undefined
  connection?: (provider: ImageProvider) => ImageConfiguration | undefined
  saveConfiguration: (value: ImageConfiguration) => Promise<void>
  validate: (path: string) => Promise<unknown>
  normalize?: (path: string, output: string) => Promise<unknown>
  publish: (path: string, sessionID: string, image: GeneratedImage, inputID?: string) => Promise<DocumentArtifact>
  changed: () => void
  progress?: (job: ImageJobState) => void
  endpoint?: string
  catalogueEndpoint?: string
  openrouterKey?: () => string | undefined
  openaiKey?: () => string | undefined
  waitMs?: number
}

// Image credentials and successful image inference are deliberately independent
// of the conversational provider catalogue and its OAuth credential.
export class BBImages {
  private jobs: Job[] = []
  private active = new Map<string, { abort: AbortController; done: Promise<void> }>()
  private preparing = new Set<{ sessionID: string; abort: AbortController }>()
  private saving = Promise.resolve()
  private configuring = Promise.resolve()
  private listeners = new Set<() => void>()
  private revision = 0
  private historyUncertain = false
  private routerModels: ImageModel[] = []
  private discovery?: Promise<ImageModel[]>
  private discoveryAt = 0
  constructor(
    private root: string,
    private options: Options,
  ) {}

  async start() {
    const configuration = this.configuration()
    if (configuration?.error && !configuration.errorFingerprint)
      await this.options.saveConfiguration({ ...configuration, errorFingerprint: fingerprint(configuration) })
    const catalogue = await readFile(join(this.root, "image-models.json"), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => [])
    if (Array.isArray(catalogue))
      this.routerModels = catalogue.filter(
        (row) =>
          stateRecord(row) && typeof row.id === "string" && typeof row.name === "string" && stateRecord(row.parameters) && (row.editing === undefined || typeof row.editing === "boolean"),
      )
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
    const configuration = this.configuration()
    const provider = configuration?.provider ?? (configuration ? "openai" : "openrouter")
    return {
      provider,
      enabled: Boolean(configuration && !configuration.disabled),
      openrouterConnected: Boolean(this.options.openrouterKey?.()),
      connections: Object.fromEntries(
        (["openai", "openrouter"] as const).flatMap((provider) => {
          const connection = this.configuration(provider)
          return connection ? [[provider, { model: connection.model, configured: Boolean(connection.key) }]] : []
        }),
      ),
      configured: Boolean(configuration?.key),
      available: Boolean(
        !this.historyUncertain && !configuration?.disabled &&
          configuration?.key &&
          (configuration.provider === "openrouter"
            ? this.routerModels.some((model) => model.id === configuration.model)
            : IMAGE_MODELS.includes(configuration.model as (typeof IMAGE_MODELS)[number])) &&
          !(configuration.error && (!configuration.errorFingerprint || configuration.errorFingerprint === fingerprint(configuration))),
      ),
      model: configuration?.model ?? "",
      models: provider === "openai" ? IMAGE_MODELS : this.routerModels.map((row) => row.id),
      supportsEditing: provider === "openai" || this.routerModels.some(row => row.id === configuration?.model && row.editing),
      editingModels: provider === "openai" ? IMAGE_MODELS : this.routerModels.filter(row => row.editing).map(row => row.id),
      verifiedAt: configuration?.verified?.fingerprint === fingerprint(configuration) ? configuration.verified.at : undefined,
      error: this.historyUncertain ? "bb.error.imageStorage" : configuration?.error && (!configuration.errorFingerprint || configuration.errorFingerprint === fingerprint(configuration)) ? configuration.error : undefined,
      revision: this.revision,
    }
  }

  async models(provider: ImageProvider) {
    if (provider === "openai") return IMAGE_MODELS.map((id) => ({ id, name: id, parameters: {}, editing: true }))
    if (this.routerModels.length && Date.now() - this.discoveryAt < 5 * 60_000) return this.routerModels
    if (this.discovery) return this.discovery
    const operation = (async () => {
      const response = await fetch(this.options.catalogueEndpoint ?? "https://openrouter.ai/api/v1/images/models", {
        signal: AbortSignal.timeout(20000),
      })
      if (!response.ok) throw new Error("bb.error.imageModels")
      const models = imageCatalog(await response.json())
      const temp = join(this.root, `image-models-${randomUUID()}.tmp`)
      await writeFile(temp, JSON.stringify(models))
      await rename(temp, join(this.root, "image-models.json"))
      this.routerModels = models
      this.discoveryAt = Date.now()
      this.changed()
      return models
    })()
    this.discovery = operation
    try {
      return await operation
    } finally {
      if (this.discovery === operation) this.discovery = undefined
    }
  }

  private configuration(provider?: ImageProvider) {
    const active = this.options.configuration()
    const value = provider
      ? (this.options.connection?.(provider) ?? ((active?.provider ?? "openai") === provider ? active : undefined))
      : active
    if (!value) return value
    if (value.provider === "openrouter") return { ...value, key: value.disabled ? undefined : this.options.openrouterKey?.() }
    const keySource = value.keySource ?? (value.key ? "separate" : "provider")
    return { ...value, keySource, key: value.disabled ? undefined : keySource === "provider" ? this.options.openaiKey?.() : value.key }
  }

  async configure(args: { provider?: ImageProvider | "none"; key?: string; model?: string; disconnect?: boolean }) {
    const operation = this.configuring.then(async () => {
      const previous = this.configuration()
      if (args.provider === "none" || args.disconnect) {
        await this.options.saveConfiguration({ ...(this.options.configuration() ?? { provider: "openrouter", model: "" }), disabled: true })
        for (const operation of this.preparing) operation.abort.abort()
        for (const operation of this.active.values()) operation.abort.abort()
        this.changed()
        return this.status()
      }
      const provider = args.provider ?? previous?.provider ?? "openai"
      const connection = this.configuration(provider)
      const saved = this.options.connection?.(provider) ?? ((previous?.provider ?? "openai") === provider ? this.options.configuration() : undefined)
      if (!["openai", "openrouter"].includes(provider)) throw new Error("bb.error.imageModel")
      const model = args.model || connection?.model || (provider === "openrouter" ? (await this.models(provider))[0]?.id : IMAGE_MODELS[0])
      if (provider === "openrouter" && !this.routerModels.some((row) => row.id === model)) await this.models(provider)
      if (
        provider === "openai"
          ? !IMAGE_MODELS.includes(model as (typeof IMAGE_MODELS)[number])
          : !this.routerModels.some((row) => row.id === model)
      )
        throw new Error("bb.error.imageModel")
      const keySource = provider === "openrouter" ? "provider" : args.key?.trim() ? "separate" : saved?.keySource ?? (saved?.key ? "separate" : "provider")
      const key = provider === "openrouter"
          ? this.options.openrouterKey?.()
          : keySource === "provider" ? this.options.openaiKey?.() : args.key?.trim() || saved?.key
      if (key && (key.length > 4096 || /[\r\n\0]/.test(key))) throw new Error("bb.error.imageCredential")
      const unchanged = key === connection?.key && model === connection?.model
      await this.options.saveConfiguration({
        provider,
        disabled: false,
        key,
        keySource,
        model,
        ...(unchanged ? { verified: connection?.verified, error: connection?.error, errorFingerprint: connection?.errorFingerprint } : {}),
      })
      if (fingerprint(previous) !== fingerprint(this.configuration())) {
        for (const operation of this.preparing) operation.abort.abort()
        for (const operation of this.active.values()) operation.abort.abort()
      }
      this.changed()
      return this.status()
    })
    this.configuring = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  credentialsChanged() {
    // Discovery clients must learn about reconnects even when the selected model did not change.
    this.changed()
  }

  async verify(signal?: AbortSignal) {
    if (this.historyUncertain) throw new Error("bb.error.imageStorage")
    const configuration = this.configuration()
    if (!configuration?.key) throw new Error("bb.error.imageCredential")
    const job = await this.begin(
      "",
      `verify-${randomUUID()}`,
      {
        prompt: "A simple blue circle on a white background.",
        quality: "low",
        size: configuration.provider === "openrouter" ? "auto" : "1024x1024",
        background: "opaque",
      },
      configuration,
      true,
      undefined,
      undefined,
      [],
      signal,
    )
    await this.wait(job, signal)
    return { ...this.result(job), capability: this.status() }
  }

  async generate(args: Record<string, unknown>, sessionID: string, inputID: string, signal?: AbortSignal, callID?: string) {
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
    const configuration = this.configuration()
    if (!configuration?.key || !this.status().available) throw new Error("bb.error.imageUnavailable")
    // Stop must also own preparation before a durable job exists.
    const preparation = { sessionID, abort: new AbortController() }
    this.preparing.add(preparation)
    const preparationSignal = signal ? AbortSignal.any([signal, preparation.abort.signal]) : preparation.abort.signal
    try {
      const references = await (async () => {
        try {
          preparationSignal.throwIfAborted()
          if (request.referenced_image_paths?.length && configuration.provider === "openrouter") {
            await this.models("openrouter")
            preparationSignal.throwIfAborted()
            if (!this.status().supportsEditing) throw new Error("bb.error.imageEditingUnsupported")
          }
          return await this.references(request.referenced_image_paths ?? [], preparationSignal)
        } catch (error) {
          if (preparationSignal.aborted) return []
          throw error
        }
      })()
      // Configuration saves can expose the new value before their cancellation
      // notification; settle that owner before checking preparation's state.
      await this.configuring
      if (!preparationSignal.aborted && (fingerprint(configuration) !== fingerprint(this.configuration()) || !this.status().available)) throw new Error("bb.error.imageUnavailable")
      // Reading reference files yields. Reconcile an admission made concurrently
      // before allowing another potentially billed HTTP request.
      const admitted = this.jobs.find(job => job.id === id || (!job.verification && job.sessionID === sessionID && job.inputID === inputID && job.signature === signature(request)))
      if (admitted) {
        if (admitted.sessionID !== sessionID || admitted.verification || admitted.signature !== signature(request)) throw new Error("bb.error.deliveryConflict")
        await this.wait(admitted, preparationSignal)
        return this.result(admitted)
      }
      if (this.jobs.some(job => job.sessionID === sessionID && job.inputID === inputID && ["uncertain", "canceled"].includes(job.status))) throw new Error("bb.error.imageUncertain")
      // A canceled preparation gets a durable tombstone, never a provider call.
      const job = await this.begin(sessionID, id, request, configuration, false, inputID, callID, references, preparationSignal)
      await this.wait(job, preparationSignal)
      return this.result(job)
    } finally {
      this.preparing.delete(preparation)
    }
  }

  async job(id: string, sessionID?: string, signal?: AbortSignal) {
    const job = this.jobs.find((row) => row.id === id && (sessionID === undefined || row.sessionID === sessionID))
    if (!job) throw new Error("bb.error.invalidRequest")
    await this.wait(job, signal)
    return { ...this.result(job), capability: this.status() }
  }

  cancel(sessionID: string) {
    for (const operation of this.preparing) if (operation.sessionID === sessionID) operation.abort.abort()
    for (const job of this.jobs) if (job.sessionID === sessionID) this.active.get(job.id)?.abort.abort()
  }

  list(sessionID: string) {
    return this.jobs.filter(job => !job.verification && job.sessionID === sessionID).map(job => this.publicJob(job))
  }

  private publicJob(job: Job): ImageJobState {
    return { ...this.result(job), sessionID: job.sessionID, inputID: job.inputID, callID: job.callID, created: job.created, updated: job.updated }
  }

  private async references(paths: readonly string[], signal?: AbortSignal) {
    const references: string[] = []
    let total = 0
    for (const path of paths) {
      signal?.throwIfAborted()
      const info = await stat(path).catch(() => { throw new Error("bb.error.imageReference") })
      if (!info.isFile() || !info.size || info.size > 14 * 1024 * 1024 || total + info.size > 64 * 1024 * 1024) throw new Error("bb.error.imageReference")
      const bytes = await readFile(path).catch(() => { throw new Error("bb.error.imageReference") })
      total += bytes.length
      if (!bytes.length || bytes.length > 14 * 1024 * 1024 || total > 64 * 1024 * 1024) throw new Error("bb.error.imageReference")
      const mime = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? "image/png"
        : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg"
        : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "image/webp" : undefined
      if (!mime) throw new Error("bb.error.imageReference")
      await this.options.validate(path).catch(() => { throw new Error("bb.error.imageReference") })
      references.push(`data:${mime};base64,${bytes.toString("base64")}`)
    }
    return references
  }

  async capabilities(revision?: number, signal?: AbortSignal) {
    // Old cached catalogues did not record input modalities. Refresh them before
    // advertising photo editing support to the model.
    if (this.configuration()?.provider === "openrouter" && this.routerModels.some(row => row.editing === undefined))
      await this.models("openrouter").catch(() => undefined)
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
    callID?: string,
    references: readonly string[] = [],
    signal?: AbortSignal,
  ) {
    const job: Job = {
      id,
      sessionID,
      signature: signature(request),
      model: configuration.model,
      provider: configuration.provider ?? "openai",
      created: Date.now(),
      updated: Date.now(),
      status: "preparing",
      verification,
      inputID,
      callID,
    }
    this.jobs.push(job)
    const abort = new AbortController()
    const cancel = () => abort.abort()
    if (signal?.aborted) cancel()
    signal?.addEventListener("abort", cancel, { once: true })
    const admission = Promise.withResolvers<boolean>()
    const done = admission.promise.then(accepted => accepted ? this.execute(job, request, { ...configuration }, abort.signal, references) : undefined)
      .catch(() => {
        job.status = "uncertain"
        job.error = "bb.error.imageStorage"
        this.options.changed()
      })
      .finally(() => { signal?.removeEventListener("abort", cancel); this.active.delete(id) })
    // Register ownership before journal I/O so Stop/Off can cancel an admission.
    this.active.set(id, { abort, done })
    // Commit the admission before making the first potentially billed request.
    try {
      await this.persist()
    } catch (error) {
      this.jobs = this.jobs.filter((row) => row !== job)
      job.status = "error"
      job.error = "bb.error.imageStorage"
      admission.resolve(false)
      await done
      throw error
    }
    admission.resolve(true)
    this.options.progress?.(this.publicJob(job))
    return job
  }

  private async execute(
    job: Job,
    request: ReturnType<typeof imageRequest>,
    configuration: ImageConfiguration,
    signal: AbortSignal,
    references: readonly string[],
  ) {
    try {
      signal.throwIfAborted()
      const model =
        configuration.provider === "openrouter"
          ? this.routerModels.find((row) => row.id === configuration.model)
          : undefined
      if (configuration.provider === "openrouter" && !model) throw new Error("bb.error.imageModel")
      const response = await fetch(
        this.options.endpoint ??
          (model ? "https://openrouter.ai/api/v1/images" : references.length ? "https://api.openai.com/v1/images/edits" : "https://api.openai.com/v1/images/generations"),
        {
          method: "POST",
          signal: AbortSignal.any([signal, AbortSignal.timeout(600000)]),
          headers: { Authorization: `Bearer ${configuration.key}`, "Content-Type": "application/json" },
          body: JSON.stringify(
            model
              ? routerImageRequest(model, request, references)
              : { model: configuration.model, prompt: request.prompt, quality: request.quality, size: request.size, background: request.background, n: 1, output_format: "png", ...(references.length ? { images: references.map(image_url => ({ image_url })) } : {}) },
          ),
        },
      )
      job.requestID = response.headers.get("x-request-id") ?? undefined
      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as { error?: { code?: string | number; message?: string } }
        const providerCode = String(error.error?.code ?? "")
        job.diagnostic = { status: response.status, code: redact(providerCode, configuration.key), message: redact(error.error?.message, configuration.key) }
        const code =
          response.status === 401
            ? "bb.error.imageCredential"
            : response.status === 403
              ? "bb.error.imageAccess"
              : response.status === 429 || response.status === 402
                ? "bb.error.imageQuota"
                : providerCode.includes("moderation") || providerCode === "content_policy_violation"
                  ? "bb.error.imageRefused"
                  : "bb.error.imageRequest"
        if (
          [401, 403, 404].includes(response.status) &&
          fingerprint(this.configuration()) === fingerprint(configuration)
        ) {
          await this.options.saveConfiguration({ ...configuration, verified: undefined, error: code, errorFingerprint: fingerprint(configuration) })
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
      signal.throwIfAborted()
      const folder = join(this.root, "image-jobs", job.id)
      await mkdir(folder, { recursive: true })
      const path = join(folder, "image.png")
      if (this.options.normalize) {
        const source = join(folder, "response-image")
        await writeFile(source, bytes)
        await this.options.normalize(source, path + ".tmp.png").catch((error) => {
          if (error instanceof Error && error.message.includes("bb.error.imageOutput")) throw new Error("bb.error.imageOutput")
          throw error
        })
      } else await writeFile(path + ".tmp.png", bytes)
      const dimensions = pngDimensions(await readFile(path + ".tmp.png"))
      await this.options.validate(path + ".tmp.png")
      signal.throwIfAborted()
      await rename(path + ".tmp.png", path)
      job.image = {
        ...dimensions,
        provider: configuration.provider ?? "openai",
        model: configuration.model,
        jobID: job.id,
      }
      await this.persist()
      signal.throwIfAborted()
      if (!job.verification) job.artifact = await this.publish(job, path)
      signal.throwIfAborted()
      if (fingerprint(this.configuration()) === fingerprint(configuration)) {
        await this.options.saveConfiguration({
          ...configuration,
          verified: { fingerprint: fingerprint(configuration), at: Date.now() },
          error: undefined,
          errorFingerprint: undefined,
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
    this.options.progress?.(this.publicJob(job))
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
        job.image = { ...dimensions, provider: job.provider ?? "openai", model: job.model, jobID: job.id }
        job.artifact = await this.publish(job, path)
        job.status = "ready"
        job.error = undefined
      } catch (error) {
        job.status = abort.signal.aborted ? "canceled" : "error"
        job.error = abort.signal.aborted ? "bb.error.imageCanceled" : "bb.error.imageStorage"
      }
      job.updated = Date.now()
      await this.persist()
      this.options.progress?.(this.publicJob(job))
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
      diagnostic: job.diagnostic,
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

function redact(value: unknown, key?: string) {
  if (typeof value !== "string") return undefined
  return (key ? value.split(key).join("[redacted]") : value).replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[redacted]").replace(/[\x00-\x1f]/g, " ").slice(0, 1000)
}

function fingerprint(configuration?: ImageConfiguration) {
  return createHash("sha256")
    .update(
      `${configuration?.provider === "openrouter" ? "openrouter\0" : ""}${configuration?.key ?? ""}\0${configuration?.model ?? ""}`,
    )
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
  const paths = args.referenced_image_paths
  if (paths !== undefined && (!Array.isArray(paths) || !paths.length || paths.length > 16 || paths.some(path => typeof path !== "string" || !isAbsolute(path) || path.length > 32768 || /[\r\n\0]/.test(path))))
    throw new Error("bb.error.imageReference")
  return { prompt: args.prompt.trim(), quality, size, background, ...(paths === undefined ? {} : { referenced_image_paths: paths as string[] }) }
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
    (value.provider === undefined || value.provider === "openai" || value.provider === "openrouter") &&
    (value.inputID === undefined || typeof value.inputID === "string") &&
    (value.callID === undefined || typeof value.callID === "string") &&
    (value.verification === undefined || typeof value.verification === "boolean") &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.requestID === undefined || typeof value.requestID === "string") &&
    (value.image === undefined ||
      (stateRecord(value.image) &&
        Number.isSafeInteger(value.image.width) &&
        Number.isSafeInteger(value.image.height) &&
        Number(value.image.width) > 0 &&
        Number(value.image.height) > 0 &&
        value.image.provider === (value.provider ?? "openai") &&
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
