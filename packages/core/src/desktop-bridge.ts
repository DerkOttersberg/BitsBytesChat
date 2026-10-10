export * as DesktopBridge from "./desktop-bridge"
import { reviewLocalApproval, type ApprovalDetails } from "./util/approval-review"

export function enabled() { return Boolean(process.env.BITSBYTES_ENGINE_BRIDGE_URL) }

export async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const url = process.env.BITSBYTES_ENGINE_BRIDGE_URL
  if (!url) throw new Error("Desktop bridge is unavailable")
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.BITSBYTES_ENGINE_BRIDGE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Desktop bridge failed (${response.status})`)
  return await response.json() as T
}

// Read-only tools are safe in Ask mode. Unknown tools require approval.
export async function permission(sessionID: string, action: string, details?: ApprovalDetails): Promise<"ask" | "allow" | "deny" | undefined> {
  if (!enabled()) return
  const readonly = /^(read|glob|grep|ls|list|search|skill|question|todowrite|todoread|webfetch|websearch|codesearch|bitsbytes.local.(read_transcript|list_skills|inspect_template|inspect_artifact|get_goal|read_artifact_pages|browser_inspect|browser_screenshot|image_capabilities))$/.test(action)
  const run = await call<{ plan: boolean; diagnostic?: boolean }>("runs.permission", { sessionID }).catch(() => ({ plan: true, diagnostic: false }))
  if (run.diagnostic) return /^(read|glob|grep|parent_progress)$/.test(action) ? "allow" : "deny"
  if (run.plan) return readonly ? "allow" : "deny"
  const mode = await call<{ mode: string }>("access.get", { sessionID }).catch(() => ({ mode: "ask" }))
  if (mode.mode === "full") return "allow"
  if (mode.mode === "auto" && !readonly && !/bitsbytes.local.goal_progress$/.test(action)) return reviewLocalApproval(action, details)
  return readonly || /bitsbytes.local.goal_progress$/.test(action) ? "allow" : "ask"
}
