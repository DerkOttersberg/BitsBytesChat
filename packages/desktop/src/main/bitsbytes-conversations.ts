import type { ServerReadyData } from "../preload/types"
import type { BBRuns } from "./bitsbytes-runs"
import { EngineResponseError, engineRequest } from "./bitsbytes-engine"

type Conversation = { id: string; parentID?: string; directory?: string; location?: { directory?: string } }
type ConversationInput = { server: ServerReadyData; protocol: "v1" | "v2"; sessionID: string; directory: string }

export async function conversationProtocol(server: ServerReadyData, directory: string) {
  const legacy = await engineRequest<{ healthy?: boolean }>(server, "/global/health", {}, directory).catch(
    () => undefined,
  )
  if (legacy?.healthy === true) return "v1" as const
  const current = await engineRequest<{ pid?: number }>(server, "/api/health", {}, directory)
  if (typeof current.pid !== "number") throw new Error("organization.error.actionFailed")
  return "v2" as const
}

export async function ownedConversations(input: ConversationInput) {
  const prefix = input.protocol === "v2" ? "/api/session/" : "/session/"
  const root = await engineRequest<Conversation | { data: Conversation }>(
    input.server,
    prefix + encodeURIComponent(input.sessionID),
    {},
    input.directory,
  )
  const owner = "data" in root ? root.data : root
  if (owner.id !== input.sessionID) throw new Error("organization.error.actionFailed")
  const ids = [owner.id]
  const seen = new Set(ids)
  for (const id of ids) {
    const result = await engineRequest<Conversation[] | { data: Conversation[] }>(
      input.server,
      prefix + encodeURIComponent(id) + "/children",
      {},
      input.directory,
    )
    const children = "data" in result ? result.data : result
    for (const child of children) {
      if (child.parentID !== id || seen.has(child.id)) throw new Error("organization.error.actionFailed")
      seen.add(child.id)
      ids.push(child.id)
    }
  }
  return ids
}

export async function removeOwnedConversation(input: ConversationInput & { runs: BBRuns }) {
  const ids = await ownedConversations(input)
  return input.runs.disposeChats(ids, async () => {
    // Legacy deletion does not own an active provider fiber, so stop each owned
    // session first. The V2 removal endpoint owns its interruption lifecycle.
    if (input.protocol === "v1") {
      await Promise.all(
        ids.map((id) =>
          engineRequest(input.server, `/session/${encodeURIComponent(id)}/abort`, { method: "POST" }, input.directory),
        ),
      )
    }
    await engineRequest(
      input.server,
      `${input.protocol === "v2" ? "/api" : ""}/session/${encodeURIComponent(input.sessionID)}`,
      { method: "DELETE" },
      input.directory,
    )
    if (input.protocol === "v1") {
      // The retained legacy remover can swallow storage errors and still return
      // success. Require an authoritative not-found before discarding journals.
      await Promise.all(
        ids.map(async (id) => {
          const absent = await engineRequest(
            input.server,
            `/session/${encodeURIComponent(id)}`,
            {},
            input.directory,
          ).then(
            () => false,
            (error) => {
              if (error instanceof EngineResponseError && error.status === 404) return true
              throw error
            },
          )
          if (!absent) throw new Error("organization.error.actionFailed")
        }),
      )
    }
    return ids
  })
}
