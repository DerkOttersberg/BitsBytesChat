import { expect, test } from "bun:test"
import { planRequest, openrouterRequest } from "./bitsbytes-request"
import { catalogModels, modelConfiguration } from "./bitsbytes-models"

test("subscription requests retain complete history, namespace local tools and omit unsupported fields", () => {
  const result = planRequest({ model: "available-model", temperature: 0.7, max_output_tokens: 4000, previous_response_id: "old",
    input: [{ role: "system", content: "instructions" }, { role: "user", content: "source" }, { type: "function_call", name: "read", call_id: "call", arguments: "{}" }],
    tools: [{ type: "function", name: "read", parameters: { type: "object" } }, { type: "tool_search" }, { type: "computer_use" }], tool_choice: { type: "function", name: "read" },
  })
  expect(result.store).toBe(false)
  expect(result.stream).toBe(true)
  expect(result).not.toHaveProperty("temperature")
  expect(result).not.toHaveProperty("max_output_tokens")
  expect(result).not.toHaveProperty("previous_response_id")
  expect(result.input).toEqual([{ role: "developer", content: "instructions" }, { role: "user", content: "source" }, { type: "function_call", name: "read", namespace: "bitsbytes", call_id: "call", arguments: "{}" }])
  expect(result.tools).toEqual([{ type: "namespace", name: "bitsbytes", description: "Tools executed locally on the user's laptop", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] }])
})

test("ChatGPT model discovery retains public effort capabilities and ignores agent-only modes", () => {
  const models = catalogModels("chatgpt", { models: [
    { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
    { slug: "selected-model", display_name: "Selected model", visibility: "list", context_window: 200000,
      supported_reasoning_levels: [{ effort: "max" }, { effort: "ultra" }, { effort: "high" }, { effort: "low" }], default_reasoning_level: "high" },
  ] })
  expect(models).toEqual([{ id: "selected-model", name: "Selected model", context: 200000, efforts: ["low", "high", "max"], defaultEffort: "high" }])
  const config = modelConfiguration(models[0], "chatgpt")
  expect(config.reasoning).toBe(true)
  expect(config.options?.reasoningEffort).toBe("high")
  expect(config.variants.max).toEqual({ reasoningEffort: "max" })
  expect(config.variants.medium).toEqual({ disabled: true })
  expect(config.variants.none).toEqual({ disabled: true })
})

test("OpenRouter discovery respects mandatory reasoning and models without effort selection", () => {
  const models = catalogModels("openrouter", { data: [
    { id: "mandatory", name: "Mandatory", supported_parameters: ["tools", "reasoning"], reasoning: { mandatory: true, supported_efforts: ["high", "low", "none"], default_effort: "high" } },
    { id: "flexible", name: "Flexible", supported_parameters: ["tools"], reasoning: { supported_efforts: null } },
    { id: "fixed", name: "Fixed", supported_parameters: ["tools", "reasoning"], reasoning: { mandatory: true } },
    { id: "no-tools", name: "No tools", supported_parameters: ["reasoning"] },
  ] })
  expect(models.map((model) => model.id)).toEqual(["mandatory", "flexible", "fixed"])
  expect(models[0].efforts).toEqual(["low", "high"])
  expect(models[1].efforts).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
  expect(models[2].efforts).toEqual([])
  expect(modelConfiguration(models[2], "openrouter").variants.high).toEqual({ disabled: true })
})

test("selected effort survives subscription request conversion alongside tool calls", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const result = planRequest({ model: "selected-model", reasoning: { effort, summary: "auto" },
      input: [{ type: "function_call_output", call_id: "call", output: "local result" }],
      tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
    })
    expect(result.reasoning).toEqual({ effort, summary: "auto" })
    expect(result.input).toEqual([{ type: "function_call_output", call_id: "call", output: "local result" }])
    expect(result.tools).toHaveLength(1)
  }
})

test("OpenRouter SDK effort maps to the unified request field without changing model or tools", () => {
  const input = { model: "provider/model", stream: true, reasoning_effort: "xhigh",
    reasoning: { exclude: false }, messages: [{ role: "user", content: "Hello" }], tools: [{ type: "function", function: { name: "read" } }],
  }
  const result = openrouterRequest(input)
  expect(result).not.toHaveProperty("reasoning_effort")
  expect(result).toMatchObject({ model: input.model, messages: input.messages, tools: input.tools, reasoning: { effort: "xhigh", exclude: false } })
  expect(input.reasoning_effort).toBe("xhigh")
  expect(openrouterRequest({ model: "normal", messages: [] })).not.toHaveProperty("reasoning")
  expect(openrouterRequest({ reasoning_effort: "low", reasoning: { effort: "high" } }).reasoning).toEqual({ effort: "high" })
})
