import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ToolOperation } from "@opencode-ai/core/tool-operation"

type Entry = {
  info: ToolOperation.Info
  jobID: string
  status: "running" | "preparing" | "failed" | "completed" | "succeeded"
}
type Input = { sessionID: string; tool: string; jobID: string; outputKey?: string; retryOf?: string }

/** Only already-sanitized public job details may be attached to a tool failure. */
export class BBToolResultError extends Error {
  constructor(message: string, readonly details: Record<string, unknown>) {
    super(message)
  }
}

export class BBToolOperationError extends Error {
  constructor(
    error: unknown,
    readonly info: ToolOperation.Info,
  ) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
  }
}

export function toolOperationMetadata(error: unknown) {
  return error instanceof BBToolOperationError ? { [ToolOperation.key]: error.info } : undefined
}

export function toolFailureResult(error: Error) {
  const source = error instanceof BBToolOperationError ? error.cause : error
  return {
    ...(source instanceof BBToolResultError ? source.details : {}),
    error: error.message,
    _meta: toolOperationMetadata(error),
  }
}

/** No prompts, credentials, source code, or raw arguments belong in this journal. */
export class BBToolOperations {
  private entries: Entry[] = []
  private loaded?: Promise<void>
  private saving = Promise.resolve()
  constructor(private root: string) {}

  private load() {
    return (this.loaded ??= (async () => {
      await mkdir(this.root, { recursive: true })
      const source = await readFile(join(this.root, "operations.json"), "utf8").catch((error) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "[]"
        throw error
      })
      let stored: unknown
      try {
        stored = JSON.parse(source)
      } catch {}
      const recovered = (Array.isArray(stored) ? stored : []).flatMap((value): Entry[] => {
        if (!value || typeof value !== "object") return []
        const info = ToolOperation.read(value.info)
        if (
          !info ||
          typeof value.jobID !== "string" ||
          !value.jobID ||
          value.jobID.length > 256 ||
          !["running", "preparing", "failed", "completed", "succeeded"].includes(value.status)
        )
          return []
        // A process restart cannot prove completion of a previously running attempt.
        return [{ info, jobID: value.jobID, status: value.status === "running" ? "failed" : value.status }]
      })
      if (!Array.isArray(stored) || recovered.length !== stored.length)
        await writeFile(join(this.root, `operations-recovery-${randomUUID()}.json`), source)
      this.entries = recovered
    })())
  }

  private persist() {
    this.saving = this.saving
      .catch(() => undefined)
      .then(async () => {
        await writeFile(join(this.root, "operations.json.tmp"), JSON.stringify(this.entries))
        await rename(join(this.root, "operations.json.tmp"), join(this.root, "operations.json"))
      })
    return this.saving
  }

  async run<T extends Record<string, unknown>>(input: Input, execute: () => Promise<T>) {
    // An absent/invalid target must retain ordinary business validation and cannot
    // acquire speculative retry lineage merely because another call later succeeds.
    if (!input.outputKey || !input.sessionID) return execute()
    await this.load()
    const previous = input.retryOf ? this.entries.find((entry) => entry.info.attemptID === input.retryOf) : undefined
    if (
      input.retryOf &&
      (!previous ||
        previous.status !== "failed" ||
        previous.info.sessionID !== input.sessionID ||
        previous.info.tool !== input.tool ||
        previous.info.outputKey !== input.outputKey)
    )
      throw new Error("bb.error.invalidDocument")
    const existing = !input.retryOf
      ? this.entries.findLast(
          (entry) =>
            entry.jobID === input.jobID &&
            entry.info.sessionID === input.sessionID &&
            entry.info.tool === input.tool &&
            entry.info.outputKey === input.outputKey &&
            ["running", "preparing", "succeeded"].includes(entry.status),
        )
      : undefined
    const info = existing
      ? ToolOperation.read({ ...existing.info, artifacts: undefined })
      : ToolOperation.read({
          operationID: previous?.info.operationID ?? randomUUID(),
          attemptID: randomUUID(),
          sessionID: input.sessionID,
          tool: input.tool,
          outputKey: input.outputKey,
          ...(previous ? { retryOf: previous.info.attemptID } : {}),
        })
    if (!info) throw new Error("bb.error.invalidDocument")
    const entry: Entry = existing ?? { info, jobID: input.jobID || info.attemptID, status: "running" }
    if (!existing) this.entries.push(entry)
    await this.persist()
    try {
      const result = await execute()
      const returnedJob =
        typeof result.job_id === "string" &&
        result.job_id &&
        result.job_id.length <= 256 &&
        !/[\r\n\0]/.test(result.job_id)
          ? result.job_id
          : undefined
      if (returnedJob) entry.jobID = returnedJob
      const candidates = Array.isArray(result.artifacts) ? result.artifacts : result.artifact ? [result.artifact] : []
      const artifacts = candidates.flatMap((value) => {
        if (!value || typeof value !== "object") return []
        const artifact = value as Record<string, unknown>
        if (typeof artifact.sessionID === "string" && artifact.sessionID !== input.sessionID) return []
        const valid = ToolOperation.read({
          ...info,
          artifacts: [{ id: artifact.id, revision: artifact.revision, hash: artifact.hash }],
        })
        return valid?.artifacts ?? []
      })
      entry.info = { ...info, ...(artifacts.length ? { artifacts } : {}) }
      entry.status = artifacts.length ? "succeeded" : result.status === "preparing" ? "preparing" : "completed"
      const save = await this.persist().then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      )
      // The artifact/job has already durably succeeded. Optional presentation
      // bookkeeping must not turn that result into a failure or a billed retry.
      if (!save.ok) {
        if (artifacts.length || (input.tool === "generate_image" && result.status === "preparing" && returnedJob))
          return result
        throw save.error
      }
      return {
        ...result,
        _meta: {
          ...(typeof result._meta === "object" && result._meta ? result._meta : {}),
          [ToolOperation.key]: entry.info,
        },
      }
    } catch (error) {
      entry.status = "failed"
      await this.persist().catch(() => undefined)
      throw new BBToolOperationError(error, entry.info)
    }
  }
}
