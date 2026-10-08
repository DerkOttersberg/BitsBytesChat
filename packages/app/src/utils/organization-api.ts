import type { ChatProject } from "@opencode-ai/schema/chat-project"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

/** Typed boundary for endpoints newer than the retained desktop compatibility SDK. */
export function createOrganizationClient(server: ServerConnection.HttpBase, transport: typeof fetch = fetch) {
  const call = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await transport(server.url.replace(/\/$/, "") + "/api/organization" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(server.password
          ? {
              Authorization:
                "Basic " + authTokenFromCredentials({ username: server.username, password: server.password }),
            }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { message?: string }
      throw new Error(error.message ?? "organization.error.request")
    }
    return response.status === 204 ? (undefined as T) : response.json()
  }
  return {
    projects: () => call<ChatProject.Info[]>("/projects"),
    create: (input: ChatProject.Create) => call<ChatProject.Info>("/projects", "POST", input),
    update: (id: string, input: ChatProject.Update) =>
      call<ChatProject.Info>("/projects/" + encodeURIComponent(id), "PATCH", input),
    remove: (id: string) => call<void>("/projects/" + encodeURIComponent(id), "DELETE"),
    chats: (input: ChatProject.ListInput = {}) => call<ChatProject.Page>("/chats/query", "POST", input),
    chat: (id: string, input: ChatProject.ChatUpdate) =>
      call<ChatProject.Chat>("/chats/" + encodeURIComponent(id), "PATCH", input),
    migrate: (input: ChatProject.Migration) => call<void>("/migrate", "POST", input),
  }
}
