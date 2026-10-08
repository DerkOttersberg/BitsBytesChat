export * as ToolOperation from "./tool-operation"

/** Safe, durable lineage for an explicitly retried local tool operation. */
export interface Info {
  readonly operationID: string
  readonly attemptID: string
  readonly sessionID: string
  readonly tool: string
  readonly outputKey: string
  readonly retryOf?: string
  readonly artifacts?: readonly { readonly id: string; readonly revision: number; readonly hash: string }[]
}

export const key = "bitsbytes.operation"

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value)

/** Narrow untrusted MCP/recovered metadata and strip unrelated or sensitive fields. */
export function read(value: unknown): Info | undefined {
  if (!record(value)) return
  if (![value.operationID, value.attemptID, value.sessionID, value.tool, value.outputKey].every(identifier)) return
  if (value.retryOf !== undefined && !identifier(value.retryOf)) return
  if (value.artifacts !== undefined && (!Array.isArray(value.artifacts) || value.artifacts.length > 100)) return
  const artifacts = value.artifacts as unknown[] | undefined
  if (
    artifacts?.some(
      (item) =>
        !record(item) ||
        !identifier(item.id) ||
        !identifier(item.hash) ||
        !Number.isInteger(item.revision) ||
        Number(item.revision) < 1,
    )
  )
    return
  return {
    operationID: String(value.operationID),
    attemptID: String(value.attemptID),
    sessionID: String(value.sessionID),
    tool: String(value.tool),
    outputKey: String(value.outputKey),
    ...(value.retryOf === undefined ? {} : { retryOf: String(value.retryOf) }),
    ...(artifacts === undefined
      ? {}
      : {
          artifacts: artifacts.map((item) => {
            const artifact = item as Record<string, unknown>
            return { id: String(artifact.id), revision: Number(artifact.revision), hash: String(artifact.hash) }
          }),
        }),
  }
}

export function metadata(value: unknown): Info | undefined {
  return record(value) ? read(value[key]) : undefined
}
