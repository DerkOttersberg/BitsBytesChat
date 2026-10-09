export * as SessionBranch from "./branch"

import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { and, asc, eq, ne, sql } from "drizzle-orm"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { ChatProject } from "@opencode-ai/schema/chat-project"
import { ChatOrganizationTable } from "../chat-project/sql"
import { SessionV1 } from "../v1/session"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionEvent } from "./event"
import { SessionMessageTable, SessionTable } from "./sql"
import { SessionExecution } from "./execution"
import { Slug } from "../util/slug"
import { fromRow } from "./info"
import { EventTable } from "../event/sql"

export class BoundaryError extends Schema.TaggedErrorClass<BoundaryError>()("Session.ForkBoundaryError", {
  message: Schema.String,
}) {}

const info = (row: typeof SessionTable.$inferSelect, id = row.id): SessionV1.SessionInfo =>
  SessionV1.SessionInfo.make({
    id,
    slug: id === row.id ? row.slug : Slug.create(),
    projectID: row.project_id,
    directory: row.directory,
    path: row.path ?? undefined,
    workspaceID: row.workspace_id ?? undefined,
    parentID: id === row.id ? (row.parent_id ?? undefined) : undefined,
    title: id === row.id ? row.title : row.title + " (fork)",
    agent: row.agent ?? undefined,
    model: fromRow(row).model,
    permission: row.permission ?? undefined,
    version: row.version,
    time: { created: id === row.id ? row.time_created : Date.now(), updated: Date.now() },
  })

export const fork = Effect.fn("SessionBranch.fork")(function* (input: {
  sessionID: SessionSchema.ID
  messageID?: SessionMessage.ID
  inclusive?: boolean
}) {
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const db = database.db
  const source = (yield* db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID))
    .get()
    .pipe(Effect.orDie))!
  if (!source) return yield* new BoundaryError({ message: "The conversation no longer exists." })
  const decode = Schema.decodeUnknownEffect(SessionMessage.Message)
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, input.sessionID))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const messages = yield* Effect.forEach(rows, (row) =>
    decode({ ...row.data, id: row.id, type: row.type }).pipe(
      Effect.mapError(() => new BoundaryError({ message: "Cannot fork a conversation with unreadable messages." })),
    ),
  )
  const settled = (message: SessionMessage.Message) =>
    message.type === "assistant" &&
    message.time.completed !== undefined &&
    message.finish !== undefined &&
    message.content.every(
      (part) => part.type !== "tool" || part.state.status === "completed" || part.state.status === "error",
    )
  const completedTurn = (message: SessionMessage.Message) =>
    settled(message) &&
    message.type === "assistant" &&
    !message.error &&
    message.finish !== "error" &&
    message.finish !== "tool-calls" &&
    message.finish !== "unknown"
  const boundary = input.messageID
    ? messages.findIndex((message) => message.id === input.messageID)
    : messages.findLastIndex(completedTurn)
  if (boundary < 0 || !settled(messages[boundary]))
    return yield* new BoundaryError({ message: "Choose a completed response before forking this conversation." })
  const sessionID = SessionSchema.ID.create()
  const created = info(source, sessionID)
  const copied = messages
    .slice(0, boundary + (input.inclusive === false ? 0 : 1))
    .filter((message) => message.type !== "assistant" || settled(message))
    .filter((message) => message.type !== "shell" || message.time.completed !== undefined)
  const organization = yield* db
    .select()
    .from(ChatOrganizationTable)
    .where(eq(ChatOrganizationTable.session_id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  // The new root and its complete transcript become visible together. No runner is woken.
  yield* db
    .transaction(() =>
      Effect.gen(function* () {
        yield* events.publish(SessionV1.Event.Created, { sessionID, info: created })
        for (const message of copied) yield* copyMessage(events, sessionID, message)
        if (organization?.project_id)
          yield* events.publish(
            ChatProject.ChatChanged,
            {
              sessionID,
              projectID: organization.project_id,
              timestamp: Date.now(),
            },
            {
              commit: () =>
                db
                  .insert(ChatOrganizationTable)
                  .values({
                    session_id: sessionID,
                    project_id: organization.project_id,
                  })
                  .onConflictDoNothing()
                  .run()
                  .pipe(Effect.orDie),
            },
          )
        // Switches in the copied history must not override the user's current selection.
        yield* events.publish(SessionV1.Event.Updated, {
          sessionID,
          info: { ...created, time: { ...created.time, updated: Date.now() } },
        })
      }),
    )
    .pipe(Effect.orDie)
  yield* events.publish(ChatProject.Changed, { timestamp: Date.now() })
  return fromRow(
    (yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie))!,
  )
})

function copyMessage(events: EventV2.Interface, sessionID: SessionSchema.ID, message: SessionMessage.Message) {
  return Effect.gen(function* () {
    const messageID = SessionMessage.ID.create()
    const base = { sessionID, timestamp: message.time.created }
    switch (message.type) {
      case "user":
        yield* events.publish(SessionEvent.Prompted, {
          ...base,
          messageID,
          prompt: { text: message.text, files: message.files, agents: message.agents },
          delivery: "steer",
        })
        return
      case "system":
        yield* events.publish(SessionEvent.ContextUpdated, { ...base, messageID, text: message.text })
        return
      case "synthetic":
        yield* events.publish(SessionEvent.Synthetic, { ...base, messageID, text: message.text })
        return
      case "agent-switched":
        yield* events.publish(SessionEvent.AgentSwitched, { ...base, messageID, agent: message.agent })
        return
      case "model-switched":
        yield* events.publish(SessionEvent.ModelSwitched, { ...base, messageID, model: message.model })
        return
      case "compaction":
        yield* events.publish(SessionEvent.Compaction.Ended, {
          ...base,
          messageID,
          reason: message.reason,
          text: message.summary,
          recent: message.recent,
        })
        return
      case "shell": {
        const callID = randomUUID()
        yield* events.publish(SessionEvent.Shell.Started, { ...base, messageID, callID, command: message.command })
        yield* events.publish(SessionEvent.Shell.Ended, {
          sessionID,
          callID,
          timestamp: message.time.completed!,
          output: message.output,
        })
        return
      }
      case "assistant": {
        const owned = { ...base, assistantMessageID: messageID }
        yield* events.publish(SessionEvent.Step.Started, {
          ...owned,
          agent: message.agent,
          model: message.model,
          snapshot: message.snapshot?.start,
        })
        for (const part of message.content) {
          if (part.type === "text") {
            const textID = randomUUID()
            yield* events.publish(SessionEvent.Text.Started, { ...owned, textID })
            yield* events.publish(SessionEvent.Text.Ended, { ...owned, textID, text: part.text })
            continue
          }
          if (part.type === "reasoning") {
            if (part.time && !part.time.completed) continue
            const reasoningID = randomUUID()
            yield* events.publish(SessionEvent.Reasoning.Started, {
              ...owned,
              reasoningID,
              timestamp: part.time?.created ?? base.timestamp,
              providerMetadata: part.providerMetadata,
            })
            yield* events.publish(SessionEvent.Reasoning.Ended, {
              ...owned,
              reasoningID,
              text: part.text,
              timestamp: part.time?.completed ?? message.time.completed!,
              providerMetadata: part.providerMetadata,
            })
            continue
          }
          if (part.state.status !== "completed" && part.state.status !== "error") continue
          const tool = { ...owned, callID: randomUUID(), timestamp: part.time.created }
          yield* events.publish(SessionEvent.Tool.Input.Started, { ...tool, name: part.name })
          yield* events.publish(SessionEvent.Tool.Input.Ended, { ...tool, text: JSON.stringify(part.state.input) })
          yield* events.publish(SessionEvent.Tool.Called, {
            ...tool,
            tool: part.name,
            input: part.state.input,
            timestamp: part.time.ran ?? part.time.created,
            provider: { executed: part.provider?.executed ?? false, metadata: part.provider?.metadata },
          })
          const settled = {
            ...tool,
            timestamp: part.time.completed ?? message.time.completed!,
            provider: { executed: part.provider?.executed ?? false, metadata: part.provider?.resultMetadata },
          }
          if (part.state.status === "completed") {
            yield* events.publish(SessionEvent.Tool.Success, {
              ...settled,
              content: part.state.content,
              structured: part.state.structured,
              outputPaths: part.state.outputPaths,
              result: part.state.result,
            })
            continue
          }
          yield* events.publish(SessionEvent.Tool.Progress, {
            ...tool,
            content: part.state.content,
            structured: part.state.structured,
          })
          yield* events.publish(SessionEvent.Tool.Failed, {
            ...settled,
            error: part.state.error,
            result: part.state.result,
          })
        }
        if (message.error) {
          yield* events.publish(SessionEvent.Step.Failed, {
            ...owned,
            timestamp: message.time.completed!,
            error: message.error,
          })
          return
        }
        yield* events.publish(SessionEvent.Step.Ended, {
          ...owned,
          timestamp: message.time.completed!,
          finish: message.finish ?? "stop",
          cost: message.cost ?? 0,
          tokens: message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          snapshot: message.snapshot?.end,
          files: message.snapshot?.files,
        })
      }
    }
  })
}

export const remove = Effect.fn("SessionBranch.remove")(function* (sessionID: SessionSchema.ID) {
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const execution = yield* SessionExecution.Service
  const db = database.db
  const owned = () =>
    db
      .all<{ id: SessionSchema.ID }>(
        sql`
    WITH RECURSIVE owned(id) AS (
      SELECT id FROM session WHERE id = ${sessionID}
      UNION SELECT session.id FROM session JOIN owned ON session.parent_id = owned.id
    ) SELECT id FROM owned
  `,
      )
      .pipe(Effect.orDie)
  // Join interruption before removal so an owned drain cannot recreate projections afterwards.
  const interrupted = new Set<SessionSchema.ID>()
  let descendants = yield* owned()
  while (descendants.some((entry) => !interrupted.has(entry.id))) {
    for (const entry of descendants.filter((entry) => !interrupted.has(entry.id))) {
      interrupted.add(entry.id)
      yield* execution.interrupt(entry.id)
    }
    // An in-flight owned tool may have created a child while cancellation was joining.
    descendants = yield* owned()
  }
  yield* db
    .transaction(() =>
      Effect.gen(function* () {
        for (const entry of descendants.toReversed()) {
          const row = yield* db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, entry.id))
            .get()
            .pipe(Effect.orDie)
          if (!row) continue
          const deleted = yield* events.publish(SessionV1.Event.Deleted, { sessionID: entry.id, info: info(row) })
          // Keep the durable tombstone sequence for subscribers, discard the deleted transcript history.
          yield* db
            .delete(EventTable)
            .where(and(eq(EventTable.aggregate_id, entry.id), ne(EventTable.id, deleted.id)))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )
    .pipe(Effect.orDie)
  yield* events.publish(ChatProject.Changed, { timestamp: Date.now() })
})
