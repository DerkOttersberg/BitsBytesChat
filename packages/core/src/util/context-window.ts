/** A context budget changes compaction, never the model's output allowance. */
export type ContextCapacity = { context: number; output: number }
export const CONTEXT_BUFFER = 20_000
export const CONTEXT_INPUT_ROOM = 16_000

export function contextWindowOptions(limit: ContextCapacity | undefined, buffer = CONTEXT_BUFFER): number[] {
  if (!limit || !Number.isSafeInteger(limit.context) || limit.context <= 0 || !Number.isFinite(limit.output)) return []
  const minimum = Math.max(limit.output, buffer) + CONTEXT_INPUT_ROOM
  return [...new Set([32_000, 64_000, 128_000, 256_000, 512_000, 1_000_000, limit.context])]
    .filter((value) => value >= minimum && value <= limit.context)
    .sort((a, b) => a - b)
}

export function validContextWindow(
  value: number | undefined,
  limit: ContextCapacity | undefined,
  buffer = CONTEXT_BUFFER,
) {
  return value === undefined || (Number.isSafeInteger(value) && contextWindowOptions(limit, buffer).includes(value))
}
