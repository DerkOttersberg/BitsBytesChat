export * as ChatOrganization from "./chat-project"

import { randomUUID } from "node:crypto"
import { and, asc, count, desc, eq, isNotNull, isNull, lt, or, type SQL } from "drizzle-orm"
import { Context, Effect, Encoding, Layer, Result, Schema } from "effect"
import { ChatProject } from "@opencode-ai/schema/chat-project"
import { SessionID } from "@opencode-ai/schema/session-id"
import { ProjectID } from "@opencode-ai/schema/project-id"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { SessionTable } from "./session/sql"
import { ProjectTable } from "./project/sql"
import { ChatOrganizationStateTable, ChatOrganizationTable, ChatProjectTable } from "./chat-project/sql"
import { ChatTitleSearch } from "./chat-project/search"
import { ChatEligibility } from "./chat-project/eligibility"

export class Invalid extends Schema.TaggedErrorClass<Invalid>()("ChatOrganization.Invalid", {
  message: Schema.String,
}) {}
export class Missing extends Schema.TaggedErrorClass<Missing>()("ChatOrganization.Missing", { sessionID: SessionID }) {}

export interface Interface {
  projects: Effect.Effect<ChatProject.Info[]>
  create: (input: ChatProject.Create) => Effect.Effect<ChatProject.Info, Invalid>
  update: (id: string, input: ChatProject.Update) => Effect.Effect<ChatProject.Info, Invalid>
  remove: (id: string) => Effect.Effect<void>
  chats: (input: ChatProject.ListInput) => Effect.Effect<ChatProject.Page, Invalid>
  chat: (id: SessionID, input: ChatProject.ChatUpdate) => Effect.Effect<ChatProject.Chat, Invalid | Missing>
  migrate: (input: ChatProject.Migration) => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@bitsbytes/ChatOrganization") {}

const Cursor = Schema.Struct({ id: Schema.String, time: Schema.Number, filter: Schema.String })
const cursorDecode = Schema.decodeUnknownOption(Schema.fromJsonString(Cursor))
const pathKey = (path: string) => {
  const value = path.replaceAll("\\", "/").replace(/\/+$/, "")
  return /^[a-z]:/i.test(value) ? value.toLowerCase() : value
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const changed = () => events.publish(ChatProject.Changed, { timestamp: Date.now() }).pipe(Effect.asVoid)
    const projectInfo = (row: typeof ChatProjectTable.$inferSelect, total = 0): ChatProject.Info => ({
      id: row.id,
      name: row.name,
      directory: row.directory ? AbsolutePath.make(row.directory) : undefined,
      pinned: row.pinned,
      order: row.position,
      created: row.time_created,
      updated: row.time_updated,
      count: total,
    })
    const readProject = (id: string) =>
      db.select().from(ChatProjectTable).where(eq(ChatProjectTable.id, id)).get().pipe(Effect.orDie)
    const selection = {
      id: SessionTable.id,
      title: SessionTable.title,
      directory: SessionTable.directory,
      projectID: ChatOrganizationTable.project_id,
      projectName: ChatProjectTable.name,
      pinned: ChatOrganizationTable.pinned,
      unread: ChatOrganizationTable.unread,
      order: ChatOrganizationTable.position,
      created: SessionTable.time_created,
      updated: SessionTable.time_updated,
      archived: SessionTable.time_archived,
    }
    const query = () =>
      db
        .select(selection)
        .from(SessionTable)
        .leftJoin(ChatOrganizationTable, eq(ChatOrganizationTable.session_id, SessionTable.id))
        .leftJoin(ChatProjectTable, eq(ChatProjectTable.id, ChatOrganizationTable.project_id))
    // Rows remain summaries: no message, tool, draft or attachment bodies are loaded for navigation.
    const encodeChat = (row: {
      id: SessionID
      title: string
      directory: string
      projectID: string | null
      projectName: string | null
      pinned: boolean | null
      unread: boolean | null
      order: number | null
      created: number
      updated: number
      archived: number | null
    }): ChatProject.Chat => ({
      ...row,
      directory: AbsolutePath.make(row.directory),
      projectID: row.projectID ?? undefined,
      projectName: row.projectName ?? undefined,
      pinned: row.pinned ?? false,
      unread: row.unread ?? false,
      order: row.order ?? 0,
      archived: row.archived ?? undefined,
    })

    yield* events.project(ChatProject.ChatChanged, (event) =>
      Effect.gen(function* () {
        const input = event.data
        if (input.title !== undefined || input.archived !== undefined) {
          yield* db
            .update(SessionTable)
            .set({
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.archived !== undefined ? { time_archived: input.archived ? input.timestamp : null } : {}),
              time_updated: input.timestamp,
            })
            .where(eq(SessionTable.id, input.sessionID))
            .run()
            .pipe(Effect.orDie)
        }
        if (
          input.projectID !== undefined ||
          input.pinned !== undefined ||
          input.unread !== undefined ||
          input.order !== undefined
        ) {
          yield* db
            .insert(ChatOrganizationTable)
            .values({
              session_id: input.sessionID,
              project_id: input.projectID,
              pinned: input.pinned,
              unread: input.unread,
              position: input.order,
            })
            .onConflictDoUpdate({
              target: ChatOrganizationTable.session_id,
              set: {
                ...(input.projectID !== undefined ? { project_id: input.projectID } : {}),
                ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
                ...(input.unread !== undefined ? { unread: input.unread } : {}),
                ...(input.order !== undefined ? { position: input.order } : {}),
              },
            })
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )

    const result: Interface = {
      projects: Effect.gen(function* () {
        const rows = yield* db
          .select({ project: ChatProjectTable, count: count(SessionTable.id) })
          .from(ChatProjectTable)
          .leftJoin(ChatOrganizationTable, eq(ChatOrganizationTable.project_id, ChatProjectTable.id))
          .leftJoin(
            SessionTable,
            and(
              eq(SessionTable.id, ChatOrganizationTable.session_id),
              isNull(SessionTable.time_archived),
              isNull(SessionTable.parent_id),
              ChatEligibility.condition(),
            ),
          )
          .groupBy(ChatProjectTable.id)
          .orderBy(asc(ChatProjectTable.position), asc(ChatProjectTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map((row) => projectInfo(row.project, row.count))
      }),
      create: Effect.fn("ChatOrganization.create")(function* (input) {
        const name = input.name.trim()
        if (!name || name.length > 120) return yield* new Invalid({ message: "organization.error.name" })
        const now = Date.now()
        const row = {
          id: "cpr_" + randomUUID(),
          name,
          directory: input.directory ?? null,
          pinned: true,
          position: 0,
          time_created: now,
          time_updated: now,
        }
        yield* db.insert(ChatProjectTable).values(row).run().pipe(Effect.orDie)
        yield* changed()
        return projectInfo(row)
      }),
      update: Effect.fn("ChatOrganization.update")(function* (id, input) {
        const row = yield* readProject(id)
        if (!row) return yield* new Invalid({ message: "organization.error.projectMissing" })
        const name = input.name?.trim() ?? row.name
        if (!name || name.length > 120) return yield* new Invalid({ message: "organization.error.name" })
        const next = {
          ...row,
          name,
          directory: input.directory !== undefined ? input.directory : row.directory,
          pinned: input.pinned ?? row.pinned,
          position: input.order ?? row.position,
          time_updated: Date.now(),
        }
        yield* db.update(ChatProjectTable).set(next).where(eq(ChatProjectTable.id, id)).run().pipe(Effect.orDie)
        yield* changed()
        return projectInfo(next)
      }),
      remove: Effect.fn("ChatOrganization.remove")(function* (id) {
        // ON DELETE SET NULL retains every chat and its execution location.
        yield* db.delete(ChatProjectTable).where(eq(ChatProjectTable.id, id)).run().pipe(Effect.orDie)
        yield* changed()
      }),
      chats: Effect.fn("ChatOrganization.chats")(function* (input) {
        const filter = JSON.stringify([
          input.projectID,
          input.archived ?? false,
          input.pinned,
          input.search?.trim() ?? "",
          input.sort ?? "updated",
        ])
        const cursor = input.cursor ? Encoding.decodeBase64UrlString(input.cursor) : undefined
        const decoded = cursor && Result.isSuccess(cursor) ? cursorDecode(cursor.success) : undefined
        if (input.cursor && (!decoded || decoded._tag === "None" || decoded.value.filter !== filter))
          return yield* new Invalid({ message: "organization.error.cursor" })
        const anchor = decoded?._tag === "Some" ? decoded.value : undefined
        const column = input.sort === "created" ? SessionTable.time_created : SessionTable.time_updated
        const conditions: SQL[] = [
          isNull(SessionTable.parent_id),
          ChatEligibility.condition(),
          input.archived ? isNotNull(SessionTable.time_archived) : isNull(SessionTable.time_archived),
        ]
        if (input.projectID !== undefined)
          conditions.push(
            input.projectID === null
              ? isNull(ChatOrganizationTable.project_id)
              : eq(ChatOrganizationTable.project_id, input.projectID),
          )
        if (input.pinned !== undefined)
          conditions.push(
            input.pinned
              ? eq(ChatOrganizationTable.pinned, true)
              : or(isNull(ChatOrganizationTable.pinned), eq(ChatOrganizationTable.pinned, false))!,
          )
        if (input.search?.trim()) conditions.push(ChatTitleSearch.condition(input.search))
        if (anchor)
          conditions.push(
            or(lt(column, anchor.time), and(eq(column, anchor.time), lt(SessionTable.id, SessionID.make(anchor.id))))!,
          )
        const limit = Math.min(100, Math.max(1, input.limit ?? 50))
        const rows = yield* query()
          .where(and(...conditions))
          .orderBy(desc(column), desc(SessionTable.id))
          .limit(limit + 1)
          .all()
          .pipe(Effect.orDie)
        const page = rows.slice(0, limit)
        const last = page.at(-1)
        return {
          data: page.map(encodeChat),
          next:
            rows.length > limit && last
              ? Encoding.encodeBase64Url(
                  JSON.stringify({ id: last.id, time: input.sort === "created" ? last.created : last.updated, filter }),
                )
              : undefined,
        }
      }),
      chat: Effect.fn("ChatOrganization.chat")(function* (id, input) {
        const current = yield* query().where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
        if (!current) return yield* new Missing({ sessionID: id })
        if (input.title !== undefined && (!input.title.trim() || input.title.trim().length > 300))
          return yield* new Invalid({ message: "organization.error.title" })
        if (input.projectID && !(yield* readProject(input.projectID)))
          return yield* new Invalid({ message: "organization.error.projectMissing" })
        yield* events.publish(ChatProject.ChatChanged, {
          ...input,
          title: input.title?.trim(),
          sessionID: id,
          timestamp: Date.now(),
        })
        yield* changed()
        return encodeChat((yield* query().where(eq(SessionTable.id, id)).get().pipe(Effect.orDie))!)
      }),
      migrate: Effect.fn("ChatOrganization.migrate")(function* (input) {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              if (
                yield* tx
                  .select()
                  .from(ChatOrganizationStateTable)
                  .where(eq(ChatOrganizationStateTable.key, "workspace-import-v1"))
                  .get()
              )
                return
              const roots = yield* tx.select().from(ProjectTable).all()
              const done = new Set<string>()
              for (const entry of input.projects) {
                if (input.defaultDirectory && pathKey(entry.directory) === pathKey(input.defaultDirectory)) continue
                const root = roots.find(
                  (row) =>
                    pathKey(row.worktree) === pathKey(entry.directory) ||
                    row.sandboxes.some((path) => pathKey(path) === pathKey(entry.directory)),
                )
                const repository = root && root.id !== ProjectID.global ? root : undefined
                const key = repository?.id ?? pathKey(entry.directory)
                if (done.has(key)) continue
                done.add(key)
                const now = Date.now(),
                  id = "cpr_" + randomUUID()
                yield* tx
                  .insert(ChatProjectTable)
                  .values({
                    id,
                    name: (
                      entry.name ||
                      root?.name ||
                      entry.directory.split(/[\\/]/).filter(Boolean).at(-1) ||
                      entry.directory
                    ).slice(0, 120),
                    directory: repository?.worktree ?? entry.directory,
                    pinned: true,
                    position: done.size - 1,
                    time_created: now,
                    time_updated: now,
                  })
                  .run()
                const sessions = yield* tx
                  .select({ id: SessionTable.id, directory: SessionTable.directory })
                  .from(SessionTable)
                  .where(
                    and(
                      isNull(SessionTable.parent_id),
                      repository ? eq(SessionTable.project_id, repository.id) : undefined,
                    ),
                  )
                  .all()
                for (const chat of sessions.filter(
                  (chat) => repository || pathKey(chat.directory) === pathKey(entry.directory),
                ))
                  yield* tx
                    .insert(ChatOrganizationTable)
                    .values({ session_id: chat.id, project_id: id })
                    .onConflictDoNothing()
                    .run()
              }
              yield* tx
                .insert(ChatOrganizationStateTable)
                .values({ key: "workspace-import-v1", value: "complete" })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        yield* changed()
      }),
    }
    return result
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node] })
