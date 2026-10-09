/** A context budget changes compaction, never the model's output allowance. */
export type ContextCapacity = { context: number; output: number }
export const CONTEXT_BUFFER = 20_000
export const CONTEXT_INPUT_ROOM = 16_000
export const ECONOMICAL_CONTEXT_WINDOW = 250_000

type ContextRate = {
  input: number
  output: number
  cache?: { read: number; write: number }
  tier?: { type: string; size: number }
}
type ContextPricing = ContextRate & {
  tiers?: readonly ContextRate[]
  experimentalOver200K?: ContextRate
}
export type ContextModel = {
  id: string
  providerID?: string
  provider?: { id?: string }
  limit: { context: number; output?: number }
  cost?: ContextPricing | readonly ContextRate[]
}

function contextRates(cost: ContextModel["cost"]): readonly ContextRate[] {
  if (!cost) return []
  if (Array.isArray(cost)) return cost
  const pricing = cost as ContextPricing
  return [pricing, ...(pricing.tiers ?? []), ...(pricing.experimentalOver200K ? [pricing.experimentalOver200K] : [])]
}

/** Zero-dollar subscription metadata does not establish a free model. */
export function freeContextModel(model: ContextModel) {
  const provider = model.providerID ?? model.provider?.id ?? ""
  if (["ollama", "lmstudio", "local"].includes(provider)) return true
  if (model.id.endsWith(":free")) return true
  if (provider !== "opencode") return false
  const rates = contextRates(model.cost)
  return (
    rates.length > 0 &&
    rates.every(
      (rate) =>
        rate.input === 0 && rate.output === 0 && (!rate.cache || (rate.cache.read === 0 && rate.cache.write === 0)),
    )
  )
}

/** A conservative total budget also leaves headroom below input-price breakpoints. */
export function recommendedContextWindow(model: ContextModel, buffer = CONTEXT_BUFFER) {
  const capacity = model.limit.context
  if (!Number.isSafeInteger(capacity) || capacity <= 0) return undefined
  if (freeContextModel(model)) return capacity
  const rates = contextRates(model.cost)
  const base = rates.find((rate) => !rate.tier) ?? rates[0]
  const increased = (rate: ContextRate) =>
    base &&
    (rate.input > base.input ||
      rate.output > base.output ||
      (rate.cache?.read ?? 0) > (base.cache?.read ?? 0) ||
      (rate.cache?.write ?? 0) > (base.cache?.write ?? 0))
  const legacy = !Array.isArray(model.cost)
    ? (model.cost as ContextPricing | undefined)?.experimentalOver200K
    : undefined
  const ceiling = Math.min(
    capacity,
    ECONOMICAL_CONTEXT_WINDOW,
    ...rates
      .filter(
        (rate) =>
          rate.tier?.type === "context" &&
          Number.isSafeInteger(rate.tier.size) &&
          rate.tier.size > 0 &&
          increased(rate),
      )
      .map((rate) => rate.tier!.size),
    ...(legacy && increased(legacy) ? [200_000] : []),
  )
  const minimum = Math.max(model.limit.output ?? 0, buffer) + CONTEXT_INPUT_ROOM
  // A large output allowance must remain intact even if it exceeds the cheap tier.
  return Math.min(capacity, Math.max(ceiling, minimum))
}

export function contextWindowOptions(limit: ContextCapacity | undefined, buffer = CONTEXT_BUFFER): number[] {
  if (!limit || !Number.isSafeInteger(limit.context) || limit.context <= 0 || !Number.isFinite(limit.output)) return []
  const minimum = Math.max(limit.output, buffer) + CONTEXT_INPUT_ROOM
  return [...new Set([32_000, 64_000, 128_000, 250_000, 256_000, 512_000, 1_000_000, limit.context])]
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

/** A saved Recommended ceiling may originate at an arbitrary catalog price tier. */
export function validRecommendedContextWindow(
  value: number | undefined,
  limit: ContextCapacity | undefined,
  buffer = CONTEXT_BUFFER,
) {
  return (
    value === undefined ||
    (Boolean(limit) &&
      Number.isSafeInteger(value) &&
      value! > 0 &&
      value! <= limit!.context &&
      // Recommended at actual capacity retains the catalog default even when
      // this small model cannot support any safe manual reduction.
      (value === limit!.context || value! >= Math.max(limit!.output, buffer) + CONTEXT_INPUT_ROOM))
  )
}
