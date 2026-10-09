import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { ServerSDK } from "../context/server-sdk"
import type { Platform } from "../context/platform"
import { ServerConnection } from "../context/server"
import { notifySessionTabsRemoved } from "../components/titlebar-session-events"
import { authTokenFromCredentials } from "./server"
import type { ChatProject } from "@opencode-ai/schema/chat-project"

export type ConversationActionChat = { id: string; title: string; directory: string; projectID?: string }
export type ConversationCopyLabels = { user: string; assistant: string }
type CanonicalMessage = {
  id: string
  type: string
  text?: string
  files?: readonly { name?: string; uri: string }[]
  content?: readonly { type: string; text?: string }[]
  time: { created: number; completed?: number }
  finish?: string
  error?: unknown
}
type LegacyMessage = { info: Message; parts: Part[] }
type CopyMessage = { role: "user" | "assistant"; text: string; files: { name?: string; uri: string }[] }

class ConversationResponseError extends Error {
  constructor(readonly status: number) {
    super("organization.error.actionFailed")
  }
}

export function conversationMarkdown(title: string, messages: readonly CopyMessage[], labels: ConversationCopyLabels) {
  return (
    [
      `# ${title.replace(/[\r\n]+/g, " ")}`,
      ...messages.flatMap((message) => {
        const files = message.files.map((file) => {
          const name = (file.name ?? file.uri).replace(/[\r\n]+/g, " ").replace(/[\[\]\\]/g, "\\$&")
          if (/^(?:data|blob):/i.test(file.uri)) return name
          return `[${name}](<${file.uri.replace(/[<>\r\n]/g, (value) => encodeURIComponent(value))}>)`
        })
        const text = [message.text.trim(), ...files].filter(Boolean).join("\n\n")
        return text ? [`## ${labels[message.role]}\n\n${text}`] : []
      }),
    ].join("\n\n") + "\n"
  )
}

/** Protocol-aware sidebar actions never depend on whichever conversation is mounted. */
export function createConversationActions(input: {
  sdk: Pick<ServerSDK, "server" | "protocol">
  platform: Pick<Platform, "bitsbytes" | "fetch" | "writeClipboardText">
  organization: { chat: (id: string, value: Pick<ChatProject.ChatUpdate, "projectID">) => Promise<unknown> }
  labels: ConversationCopyLabels
  onRemoved?: (ids: string[]) => void
}) {
  const transport = input.platform.fetch ?? fetch
  const native = ServerConnection.builtin(input.sdk.server) ? input.platform.bitsbytes : undefined
  const branching = new Map<string, Promise<{ id: string; directory: string }>>()
  const created = new Map<string, { id: string; directory: string }>()
  const removing = new Map<string, Promise<string[]>>()
  const request = async <T>(path: string, directory: string, method = "GET", body?: unknown) => {
    const response = await transport(input.sdk.server.http.url.replace(/\/$/, "") + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
        ...(input.sdk.server.http.password
          ? {
              Authorization:
                "Basic " +
                authTokenFromCredentials({
                  username: input.sdk.server.http.username,
                  password: input.sdk.server.http.password,
                }),
            }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    })
    if (!response.ok) throw new ConversationResponseError(response.status)
    return {
      data: response.status === 204 ? (undefined as T) : ((await response.json()) as T),
      headers: response.headers,
    }
  }
  const legacyMessages = async (chat: ConversationActionChat, latest = false) => {
    const messages: LegacyMessage[] = []
    const seen = new Set<string>()
    let before: string | undefined
    while (true) {
      const query = new URLSearchParams({ limit: "200", ...(before ? { before } : {}) })
      const page = await request<LegacyMessage[]>(
        `/session/${encodeURIComponent(chat.id)}/message?${query}`,
        chat.directory,
      )
      messages.push(...page.data.filter((message) => !seen.has(message.info.id)))
      page.data.forEach((message) => seen.add(message.info.id))
      if (latest && latestCompletedLegacy(messages)) break
      const next = page.headers.get("x-next-cursor")
      if (!page.data.length || !next || next === before) break
      before = next
    }
    return messages.sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))
  }
  const canonicalMessages = async (chat: ConversationActionChat) => {
    const messages: CanonicalMessage[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    while (true) {
      const query = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : { order: "asc" }) })
      const page = await request<{ data: CanonicalMessage[]; cursor?: { next?: string } }>(
        `/api/session/${encodeURIComponent(chat.id)}/message?${query}`,
        chat.directory,
      )
      const fresh = page.data.data.filter((message) => !seen.has(message.id))
      messages.push(...fresh)
      fresh.forEach((message) => seen.add(message.id))
      const next = page.data.cursor?.next
      if (!fresh.length || !next || next === cursor) break
      cursor = next
    }
    return messages
  }
  const copy = async (text: string) => {
    if (input.platform.writeClipboardText) return input.platform.writeClipboardText(text)
    return navigator.clipboard.writeText(text)
  }
  const markdown = async (chat: ConversationActionChat) => {
    if ((await input.sdk.protocol) === "v2") {
      return conversationMarkdown(
        chat.title,
        (await canonicalMessages(chat)).flatMap((message) => {
          if (message.type !== "user" && message.type !== "assistant") return []
          return [
            {
              role: message.type,
              text:
                message.type === "user"
                  ? (message.text ?? "")
                  : (message.content ?? [])
                      .filter((part) => part.type === "text")
                      .map((part) => part.text ?? "")
                      .join("\n\n"),
              files: [...(message.files ?? [])],
            },
          ]
        }),
        input.labels,
      )
    }
    return conversationMarkdown(
      chat.title,
      (await legacyMessages(chat)).map((message) => ({
        role: message.info.role,
        text: message.parts
          .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
          .join("\n\n"),
        files: message.parts.flatMap((part) => (part.type === "file" ? [{ name: part.filename, uri: part.url }] : [])),
      })),
      input.labels,
    )
  }
  const fork = (chat: ConversationActionChat) => {
    const existing = branching.get(chat.id)
    if (existing) return existing
    const operation = (async () => {
      const protocol = await input.sdk.protocol
      const previous = created.get(chat.id)
      const child =
        previous ??
        (await (async () => {
          const messageID =
            protocol === "v1" ? latestCompletedLegacy(await legacyMessages(chat, true))?.info.id : undefined
          if (protocol === "v1" && !messageID) throw new Error("organization.error.noCompletedTurn")
          const result = native
            ? await native.call<{ id: string }>("branch.open", {
                sessionID: chat.id,
                directory: chat.directory,
                messageID,
                protocol,
              })
            : (
                await request<{ id: string } | { data: { id: string } }>(
                  `${protocol === "v2" ? "/api" : ""}/session/${encodeURIComponent(chat.id)}/fork`,
                  chat.directory,
                  "POST",
                  { messageID, inclusive: true },
                )
              ).data
          const session = "data" in result ? result.data : result
          if (!session?.id) throw new Error("organization.error.actionFailed")
          return { id: session.id, directory: chat.directory }
        })())
      created.set(chat.id, child)
      // Retain the created branch if this assignment fails, so retrying the
      // menu action completes the same branch instead of duplicating it.
      await input.organization.chat(child.id, { projectID: chat.projectID ?? null })
      created.delete(chat.id)
      return child
    })().finally(() => branching.delete(chat.id))
    branching.set(chat.id, operation)
    return operation
  }
  const remove = (chat: ConversationActionChat) => {
    const existing = removing.get(chat.id)
    if (existing) return existing
    const operation = (async () => {
      const protocol = await input.sdk.protocol
      const prefix = protocol === "v2" ? "/api/session/" : "/session/"
      const ids = native
        ? await native.call<string[]>("conversation.remove", {
            sessionID: chat.id,
            directory: chat.directory,
            protocol,
          })
        : await (async () => {
            const owned = [chat.id]
            const seen = new Set(owned)
            for (const id of owned) {
              const response = (
                await request<{ id: string; parentID?: string }[] | { data: { id: string; parentID?: string }[] }>(
                  prefix + encodeURIComponent(id) + "/children",
                  chat.directory,
                )
              ).data
              const children = "data" in response ? response.data : response
              children.forEach((child) => {
                if (child.parentID !== id || seen.has(child.id)) throw new Error("organization.error.actionFailed")
                seen.add(child.id)
                owned.push(child.id)
              })
            }
            if (protocol === "v1")
              await Promise.all(
                owned.map((id) => request(prefix + encodeURIComponent(id) + "/abort", chat.directory, "POST")),
              )
            await request(prefix + encodeURIComponent(chat.id), chat.directory, "DELETE")
            if (protocol === "v1") {
              // Legacy removal can swallow storage failures. A success response
              // alone must not discard tabs while durable history still exists.
              const absent = await Promise.all(
                owned.map((id) =>
                  request(prefix + encodeURIComponent(id), chat.directory).then(
                    () => false,
                    (error) => {
                      if (error instanceof ConversationResponseError && error.status === 404) return true
                      throw error
                    },
                  ),
                ),
              )
              if (absent.some((value) => !value)) throw new Error("organization.error.actionFailed")
            }
            return owned
          })()
      input.onRemoved?.(ids)
      notifySessionTabsRemoved({
        server: ServerConnection.key(input.sdk.server),
        directory: chat.directory,
        sessionIDs: ids,
      })
      return ids
    })().finally(() => removing.delete(chat.id))
    removing.set(chat.id, operation)
    return operation
  }
  return {
    fork,
    markdown,
    copyTitle: (chat: ConversationActionChat) => copy(chat.title),
    copyConversation: async (chat: ConversationActionChat) => copy(await markdown(chat)),
    remove,
  }
}

function latestCompletedLegacy(messages: readonly LegacyMessage[]) {
  return messages
    .filter(
      (message) =>
        message.info.role === "assistant" &&
        message.info.time.completed !== undefined &&
        !message.info.error &&
        message.info.finish !== "tool-calls" &&
        message.info.finish !== "unknown",
    )
    .sort((a, b) => b.info.time.created - a.info.time.created || b.info.id.localeCompare(a.info.id))[0]
}
