import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { bbt } from "../bitsbytes/copy"
import {
  UnsentError,
  type DispatchResult,
  type Inspection,
  type InspectionOptions,
  type RunPrompt,
} from "./bitsbytes-runs"
import type { ServerReadyData } from "../preload/types"

export class EngineResponseError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`${bbt("brand")} ${status}: ${body.slice(0, 500)}`)
  }
}

// Metadata is safe to poll again after a stalled read. Mutations can already
// have been admitted, so they retain the caller's explicit cancellation policy.
export async function engineRequest<T = unknown>(
  server: ServerReadyData,
  path: string,
  options: RequestInit,
  directory: string,
): Promise<T> {
  const headers = new Headers(options.headers)
  headers.set("content-type", "application/json")
  headers.set("x-opencode-directory", encodeURIComponent(directory))
  if (server.password)
    headers.set(
      "authorization",
      "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64"),
    )
  const deadline = ["GET", "HEAD"].includes((options.method ?? "GET").toUpperCase())
    ? AbortSignal.timeout(15000)
    : undefined
  const signal = deadline && options.signal ? AbortSignal.any([deadline, options.signal]) : (deadline ?? options.signal)
  return fetch(server.url + path, { ...options, headers, signal })
    .then(async (response) => {
      if (!response.ok) throw new EngineResponseError(response.status, await response.text())
      return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
    })
    .catch((error) => {
      if (deadline?.aborted && !options.signal?.aborted) throw new Error("bb.error.engineTimeout")
      throw error
    })
}

export async function inspectEngine(
  server: ServerReadyData,
  prompt: RunPrompt,
  protocols: Map<string, "v1" | "v2">,
  options: InspectionOptions = {},
): Promise<Inspection> {
  const read = <T>(path: string) => engineRequest<T>(server, path, {}, prompt.directory)
  // Both route generations can expose the same session metadata. Use the caller's
  // negotiated protocol, or the server health identity for older journal entries.
  const legacy =
    prompt.protocol || protocols.has(prompt.sessionID)
      ? undefined
      : await read<{ healthy?: boolean }>("/global/health").catch(() => undefined)
  const protocol = prompt.protocol ?? protocols.get(prompt.sessionID) ?? (legacy?.healthy === true ? "v1" : "v2")
  protocols.set(prompt.sessionID, protocol)
  if (protocol === "v1") {
    const waiting = options.readWaitingState
      ? await Promise.all([
          read<{ sessionID: string }[]>("/question"),
          read<{ sessionID: string }[]>("/permission"),
        ]).then(
          (groups) => groups.some((rows) => rows.some((row) => row.sessionID === prompt.sessionID)),
          () => true,
        )
      : undefined
    const summary =
      options.readBusyMessages === false ? await read<Record<string, { type: string }>>("/session/status") : undefined
    if (summary?.[prompt.sessionID] && summary[prompt.sessionID].type !== "idle")
      return { busy: true, waiting, messages: [] }
    const state = await Promise.all([
      summary ?? read<Record<string, { type: string }>>("/session/status"),
      read<
        {
          info: {
            id: string
            role: string
            parentID?: string
            time?: { created?: number }
            tokens?: { input?: number; output?: number; reasoning?: number }
            error?: unknown
            execution?: Inspection["messages"][number]["receipt"]
          }
          parts: {
            type: string
            text?: string
            tool?: string
            state?: { input?: unknown; output?: unknown; content?: unknown }
          }[]
        }[]
      >(`/session/${encodeURIComponent(prompt.sessionID)}/message`),
    ])
    return {
      busy: Boolean(state[0][prompt.sessionID] && state[0][prompt.sessionID].type !== "idle"),
      waiting,
      messages: state[1].map((row) => ({
        id: row.info.id,
        receipt: row.info.execution,
        assistant: row.info.role === "assistant",
        parentID: typeof row.info.parentID === "string" ? row.info.parentID : undefined,
        created:
          typeof row.info.time?.created === "number" &&
          Number.isFinite(row.info.time.created) &&
          row.info.time.created >= 0
            ? row.info.time.created
            : undefined,
        aborted: Boolean(
          row.info.error &&
            typeof row.info.error === "object" &&
            "name" in row.info.error &&
            row.info.error.name === "MessageAbortedError",
        ),
        text: row.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n"),
        tokens: (row.info.tokens?.input ?? 0) + (row.info.tokens?.output ?? 0),
        tools: row.parts.filter((part) => part.type === "tool" && !/(?:goal_progress|get_goal)$/.test(part.tool ?? ""))
          .length,
        progress: row.parts.some((part) => part.type === "tool" && !/(?:goal_progress|get_goal)$/.test(part.tool ?? ""))
          ? createHash("sha256")
              .update(
                JSON.stringify(
                  row.parts
                    .filter((part) => part.type === "tool" && !/(?:goal_progress|get_goal)$/.test(part.tool ?? ""))
                    .map((part) => ({
                      tool: part.tool,
                      input: part.state?.input,
                      output: part.state?.output,
                      content: part.state?.content,
                    })),
                ),
              )
              .digest("hex")
          : undefined,
        error: row.info.error ? JSON.stringify(row.info.error) : undefined,
      })),
    }
  }
  const waiting = options.readWaitingState
    ? await Promise.all([
        read<{ data: unknown[] }>(`/api/session/${encodeURIComponent(prompt.sessionID)}/question`),
        read<{ data: unknown[] }>(`/api/session/${encodeURIComponent(prompt.sessionID)}/permission`),
      ]).then(
        (groups) => groups.some((group) => group.data.length > 0),
        () => true,
      )
    : undefined
  const summary =
    options.readBusyMessages === false
      ? await read<{ data: Record<string, unknown> }>("/api/session/active")
      : undefined
  if (summary?.data[prompt.sessionID]) return { busy: true, waiting, messages: [] }
  const [active, context] = await Promise.all([
    summary ?? read<{ data: Record<string, unknown> }>("/api/session/active"),
    read<{
      data: {
        id: string
        type: string
        text?: string
        tokens?: { input?: number; output?: number }
        content?: {
          type: string
          text?: string
          name?: string
          state?: { input?: unknown; output?: unknown; content?: unknown }
        }[]
        error?: unknown
      }[]
    }>(`/api/session/${encodeURIComponent(prompt.sessionID)}/context`),
  ])
  return {
    busy: Boolean(active.data[prompt.sessionID]),
    waiting,
    messages: context.data.map((row) => ({
      id: row.id,
      assistant: row.type === "assistant",
      text:
        row.text ??
        row.content
          ?.filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n") ??
        "",
      tokens: (row.tokens?.input ?? 0) + (row.tokens?.output ?? 0),
      tools:
        row.content?.filter((part) => part.type === "tool" && !/(?:goal_progress|get_goal)$/.test(part.name ?? ""))
          .length ?? 0,
      progress: row.content?.some(
        (part) => part.type === "tool" && !/(?:goal_progress|get_goal)$/.test(part.name ?? ""),
      )
        ? createHash("sha256")
            .update(
              JSON.stringify(
                row.content
                  .filter((part) => part.type === "tool" && !/(?:goal_progress|get_goal)$/.test(part.name ?? ""))
                  .map((part) => ({
                    tool: part.name,
                    input: part.state?.input,
                    output: part.state?.output,
                    content: part.state?.content,
                  })),
              ),
            )
            .digest("hex")
        : undefined,
      error: row.error ? JSON.stringify(row.error) : undefined,
    })),
  }
}

export async function dispatchEngine(
  server: ServerReadyData,
  prompt: RunPrompt,
  options: {
    protocol?: "v1" | "v2"
    contextRoot: string
    resolveAttachment: (uri: string) => Promise<unknown>
    signal?: AbortSignal
  },
): Promise<DispatchResult> {
  let attempted = false
  try {
    if (options.signal?.aborted) return "not-sent"
    if (options.protocol === "v2" && prompt.resume) {
      attempted = true
      await engineRequest(
        server,
        `/api/session/${encodeURIComponent(prompt.sessionID)}/resume`,
        { method: "POST", signal: options.signal },
        prompt.directory,
      )
      return
    }
    // Source preparation can outlast Stop. Check the same cancellation signal
    // before admission, then preserve uncertainty if its POST has begun.
    const attachments = (prompt.legacyParts ?? []) as { type: string; url?: string }[]
    const sources = [
      ...attachments.filter((part) => part.type === "file").map((part) => part.url),
      ...(prompt.files ?? []).map((file) => file.uri),
    ]
    for (const uri of new Set(sources)) {
      if (options.signal?.aborted) return "not-sent"
      if (uri?.startsWith("bitsbytes://")) await options.resolveAttachment(uri)
    }
    if (options.signal?.aborted) return "not-sent"
    if (options.protocol !== "v2") {
      attempted = true
      await engineRequest(
        server,
        `/session/${encodeURIComponent(prompt.sessionID)}/prompt_async`,
        {
          method: "POST",
          signal: options.signal,
          body: JSON.stringify({
            messageID: prompt.id,
            agent: prompt.agent,
            model: prompt.model,
            variant: prompt.variant,
            revision: prompt.revision,
            resume: prompt.resume,
            parts: prompt.legacyParts ?? [{ type: "text", text: prompt.text }],
          }),
        },
        prompt.directory,
      )
      return
    }
    const path = `/api/session/${encodeURIComponent(prompt.sessionID)}`
    if (prompt.agent)
      await engineRequest(
        server,
        path + "/agent",
        { method: "POST", signal: options.signal, body: JSON.stringify({ agent: prompt.agent }) },
        prompt.directory,
      )
    if (options.signal?.aborted) return "not-sent"
    if (prompt.model)
      await engineRequest(
        server,
        path + "/model",
        {
          method: "POST",
          signal: options.signal,
          body: JSON.stringify({
            model: {
              id: prompt.model.modelID,
              providerID: prompt.model.providerID,
              variant: prompt.variant,
              contextWindow: prompt.model.contextWindow,
            },
          }),
        },
        prompt.directory,
      )
    if (options.signal?.aborted) return "not-sent"
    const parts = (prompt.legacyParts ?? []) as { type: string; text?: string; synthetic?: boolean }[]
    const context = parts
      .filter((part) => part.type === "text" && part.synthetic)
      .map((part) => part.text ?? "")
      .join("\n")
    const files = [...(prompt.files ?? [])]
    if (context) {
      if (!/^[a-zA-Z0-9_-]+$/.test(prompt.id)) throw new Error("bb.error.invalidRequest")
      await mkdir(options.contextRoot, { recursive: true })
      if (options.signal?.aborted) return "not-sent"
      await writeFile(join(options.contextRoot, prompt.id + ".txt"), context)
      files.push({
        uri: "bitsbytes://run/" + encodeURIComponent(prompt.id),
        name: bbt(prompt.mode === "plan" ? "plan" : "runContext"),
      })
    }
    if (options.signal?.aborted) return "not-sent"
    const visible = context
      ? parts
          .filter((part) => part.type === "text" && !part.synthetic)
          .map((part) => part.text ?? "")
          .join("\n")
      : prompt.text
    attempted = true
    await engineRequest(
      server,
      path + "/prompt",
      {
        method: "POST",
        signal: options.signal,
        body: JSON.stringify({
          id: prompt.id,
          prompt: { text: visible, files, agents: prompt.agents },
          delivery: prompt.delivery ?? "queue",
        }),
      },
      prompt.directory,
    )
  } catch (error) {
    if (options.signal?.aborted && !attempted) return "not-sent"
    if (!attempted) throw new UnsentError(error)
    throw error
  }
}
