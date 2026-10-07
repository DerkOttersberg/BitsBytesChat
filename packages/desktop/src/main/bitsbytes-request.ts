const UNSUPPORTED = ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"]

export function openrouterRequest(input: Record<string, unknown>) {
  const { reasoning_effort, ...body } = input
  if (typeof reasoning_effort !== "string") return body
  const reasoning = body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {}
  return { ...body, reasoning: { effort: reasoning_effort, ...reasoning } }
}

export function planRequest(input: Record<string, unknown>) {
  const body = Object.fromEntries(Object.entries(input).filter(([key]) => !UNSUPPORTED.includes(key)))
  body.store = false
  body.stream = true
  body.input = (Array.isArray(input.input) ? input.input : [{ role: "user", content: input.input ?? "" }]).map((item) => {
    if (!item || typeof item !== "object") return item
    const row = { ...item } as Record<string, unknown>
    if (row.role === "system") row.role = "developer"
    if (row.type === "function_call") row.namespace = "bitsbytes"
    return row
  })
  if (Array.isArray(body.tools)) {
    const local = body.tools.filter((item) => item.type === "function" || item.type === "custom")
    const hosted = body.tools.filter((item) => item.type === "web_search")
    body.tools = [...hosted, ...(local.length ? [{ type: "namespace", name: "bitsbytes", description: "Tools executed locally on the user's laptop", tools: local }] : [])]
  }
  if (body.tool_choice && typeof body.tool_choice === "object") {
    const choice = body.tool_choice as Record<string, unknown>
    if (choice.type === "function") body.tool_choice = { ...choice, namespace: "bitsbytes" }
  }
  return body
}
