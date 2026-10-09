import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq, sql } from "drizzle-orm"
import { ChatOrganization } from "@opencode-ai/core/chat-project"
import { ChatTitleSearch } from "@opencode-ai/core/chat-project/search"
import { ChatEligibility } from "@opencode-ai/core/chat-project/eligibility"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Event } from "@opencode-ai/schema/event"
import { ChatProject } from "@opencode-ai/schema/chat-project"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionID } from "@opencode-ai/schema/session-id"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, ChatOrganization.node])))
const seed = Effect.fn(function* (count = 3, global = false, populated = true) {
  const db = (yield* Database.Service).db
  const projectID = global ? Project.ID.global : Project.ID.make("organization_repo")
  yield* db
    .insert(ProjectTable)
    .values({
      id: projectID,
      worktree: AbsolutePath.make("C:/work/project"),
      name: "Existing project",
      sandboxes: [AbsolutePath.make("C:/work/branch")],
    })
    .run()
  const rows = Array.from({ length: count }, (_, index) => ({
    id: SessionID.make("ses_organization_" + String(index).padStart(6, "0")),
    project_id: projectID,
    slug: "test",
    directory: "C:/work/project",
    title: "Chat " + index,
    version: "test",
    time_created: index + 1,
    time_updated: index + 1,
  }))
  for (let offset = 0; offset < rows.length; offset += 100)
    yield* db
      .insert(SessionTable)
      .values(rows.slice(offset, offset + 100))
      .run()
  if (populated)
    for (let offset = 0; offset < rows.length; offset += 100)
      yield* db
        .insert(SessionInputTable)
        .values(
          rows.slice(offset, offset + 100).map((row) => ({
            id: SessionMessage.ID.make("msg_" + row.id),
            session_id: row.id,
            prompt: { text: row.title },
            delivery: "steer" as const,
            admitted_seq: 0,
          })),
        )
        .run()
  return rows
})

describe("chat organization", () => {
  it.effect("only durable user inputs become visible in lists and project counts across both protocols", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const service = yield* ChatOrganization.Service
      const rows = yield* seed(7, false, false)
      const project = yield* service.create({ name: "Eligible chats" })
      for (const row of rows) yield* service.chat(row.id, { projectID: project.id })
      expect((yield* service.chats({})).data).toEqual([])
      expect((yield* service.projects)[0].count).toBe(0)
      yield* db
        .insert(SessionInputTable)
        .values({
          id: SessionMessage.ID.make("msg_admitted"),
          session_id: rows[0].id,
          prompt: { text: "Queued before execution" },
          delivery: "queue",
          admitted_seq: 1,
        })
        .run()
      yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('msg_v1_user', ${rows[1].id}, 1, 1, '{"role":"user"}')`)
      yield* db.run(sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES ('msg_v2_user', ${rows[2].id}, 'user', 1, 1, 1, '{}'),
          ('msg_v2_shell', ${rows[3].id}, 'shell', 1, 1, 1, '{}'),
          ('msg_v2_assistant', ${rows[4].id}, 'assistant', 1, 1, 1, '{}')`)
      yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('msg_v1_assistant', ${rows[5].id}, 1, 1, '{"role":"assistant"}'),
          ('msg_v1_damaged', ${rows[6].id}, 1, 1, 'damaged optional history')`)
      expect((yield* service.chats({})).data.map((chat) => chat.id)).toEqual(
        rows
          .slice(0, 4)
          .toReversed()
          .map((row) => row.id),
      )
      expect((yield* service.projects)[0].count).toBe(4)
      yield* db.update(SessionTable).set({ parent_id: rows[0].id }).where(eq(SessionTable.id, rows[3].id)).run()
      expect((yield* service.projects)[0].count).toBe(3)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, rows[0].id)).run()
      expect((yield* service.chats({})).data).toHaveLength(2)
    }),
  )
  it.effect("manual unread defaults false, persists durably, and survives unrelated metadata updates", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const service = yield* ChatOrganization.Service
      const rows = yield* seed()
      expect((yield* service.chats({})).data.every((chat) => chat.unread === false)).toBe(true)
      expect((yield* service.chat(rows[0].id, { unread: true })).unread).toBe(true)
      const project = yield* service.create({ name: "Reading" })
      yield* service.chat(rows[0].id, { pinned: true, projectID: project.id, title: "Unread renamed" })
      expect((yield* service.chats({ projectID: project.id })).data[0].unread).toBe(true)
      yield* service.remove(project.id)
      expect((yield* service.chats({ pinned: true })).data[0].unread).toBe(true)
      expect((yield* service.chat(rows[0].id, { unread: false })).unread).toBe(false)
      const events = (yield* db.select().from(EventTable).all()).filter(
        (event) =>
          event.type === Event.versionedType(ChatProject.ChatChanged.type, 1) && event.data.unread !== undefined,
      )
      expect(events.map((event) => event.data.unread)).toEqual([true, false])
    }),
  )
  it.effect("moving and removing a project preserve execution directories and conversation rows", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db,
        service = yield* ChatOrganization.Service
      const rows = yield* seed()
      const before = yield* db.select().from(SessionTable).where(eq(SessionTable.id, rows[0].id)).get()
      const project = yield* service.create({ name: "Research", directory: AbsolutePath.make("D:/new/default") })
      yield* service.chat(rows[0].id, { projectID: project.id, pinned: true })
      expect((yield* service.chats({ projectID: project.id })).data.map((chat) => chat.id)).toEqual([rows[0].id])
      yield* service.update(project.id, { name: "Reading", directory: AbsolutePath.make("D:/other/default") })
      expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, rows[0].id)).get())?.directory).toBe(
        before?.directory,
      )
      yield* service.remove(project.id)
      expect((yield* service.chats({ projectID: null })).data).toHaveLength(3)
      expect((yield* service.chats({ pinned: true })).data[0].id).toBe(rows[0].id)
      expect(yield* db.select().from(SessionTable).all()).toHaveLength(3)
    }),
  )
  it.effect("rename, archive and restore are durable metadata changes without transcript mutations", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db,
        service = yield* ChatOrganization.Service
      const rows = yield* seed()
      yield* service.chat(rows[0].id, { title: "Saved title", archived: true })
      expect((yield* service.chats({})).data).toHaveLength(2)
      expect((yield* service.chats({ archived: true })).data[0].title).toBe("Saved title")
      yield* service.chat(rows[0].id, { archived: false })
      expect((yield* service.chats({})).data).toHaveLength(3)
      expect(
        (yield* db.select().from(EventTable).all()).filter(
          (event) => event.type === Event.versionedType(ChatProject.ChatChanged.type, 1),
        ),
      ).toHaveLength(2)
      expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, rows[0].id)).get())?.project_id).toBe(
        rows[0].project_id,
      )
    }),
  )
  it.effect("migration groups root and worktree once and does not reassign explicitly moved chats", () =>
    Effect.gen(function* () {
      const service = yield* ChatOrganization.Service,
        rows = yield* seed()
      const migration = {
        projects: [
          { directory: AbsolutePath.make("c:/WORK/project"), name: "Imported name" },
          { directory: AbsolutePath.make("C:/work/branch") },
        ],
        defaultDirectory: AbsolutePath.make("C:/default/workspace"),
      }
      yield* service.migrate(migration)
      const projects = yield* service.projects
      expect(projects).toHaveLength(1)
      expect(projects[0].name).toBe("Imported name")
      expect(projects[0].count).toBe(3)
      yield* service.chat(rows[0].id, { projectID: null })
      yield* service.migrate(migration)
      expect((yield* service.chats({ projectID: projects[0].id })).data).toHaveLength(2)
      expect((yield* service.chats({ projectID: null })).data[0].id).toBe(rows[0].id)
    }),
  )
  it.effect("non-repository folders stay separate and the default workspace remains unassigned", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const service = yield* ChatOrganization.Service
      const rows = yield* seed(3, true)
      yield* db.update(SessionTable).set({ directory: "C:/work/other" }).where(eq(SessionTable.id, rows[1].id)).run()
      yield* db
        .update(SessionTable)
        .set({ directory: "C:/default/workspace" })
        .where(eq(SessionTable.id, rows[2].id))
        .run()
      yield* service.migrate({
        projects: [
          { directory: AbsolutePath.make("C:/work/project"), name: "First" },
          { directory: AbsolutePath.make("C:/work/other"), name: "Second" },
          { directory: AbsolutePath.make("C:/default/workspace") },
        ],
        defaultDirectory: AbsolutePath.make("C:/default/workspace"),
      })
      const projects = yield* service.projects
      expect(projects.map((project) => [project.name, project.count])).toEqual([
        ["First", 1],
        ["Second", 1],
      ])
      expect((yield* service.chats({ projectID: null })).data.map((chat) => chat.id)).toEqual([rows[2].id])
    }),
  )
  it.effect("project counts exclude archived and child chats while tied timestamps page without duplication", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const service = yield* ChatOrganization.Service
      const rows = yield* seed(5)
      const project = yield* service.create({ name: "Organized" })
      for (const row of rows) yield* service.chat(row.id, { projectID: project.id })
      yield* db.update(SessionTable).set({ parent_id: rows[0].id }).where(eq(SessionTable.id, rows[1].id)).run()
      yield* service.chat(rows[2].id, { archived: true })
      expect((yield* service.projects)[0].count).toBe(3)
      yield* db.update(SessionTable).set({ time_updated: 10 }).run()
      const first = yield* service.chats({ projectID: project.id, limit: 2 })
      const second = yield* service.chats({ projectID: project.id, limit: 2, cursor: first.next })
      expect([...first.data, ...second.data].map((chat) => chat.id)).toEqual([rows[4].id, rows[3].id, rows[0].id])
      expect(second.next).toBeUndefined()
    }),
  )
  it.effect("updated-time paging includes old active chats and rejects cursor reuse across filters", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db,
        service = yield* ChatOrganization.Service,
        rows = yield* seed(5201)
      yield* db.update(SessionTable).set({ time_updated: 9000 }).where(eq(SessionTable.id, rows[0].id)).run()
      const first = yield* service.chats({ limit: 50 })
      expect(first.data[0].id).toBe(rows[0].id)
      expect(first.data).toHaveLength(50)
      const second = yield* service.chats({ limit: 50, cursor: first.next })
      expect(second.data.some((chat) => first.data.some((old) => old.id === chat.id))).toBe(false)
      expect((yield* service.chats({ search: "Chat 1", cursor: first.next }).pipe(Effect.result))._tag).toBe("Failure")
      expect(
        (yield* service.chats({ search: "Chat 1", limit: 100 })).data.every((chat) => chat.title.includes("Chat 1")),
      ).toBe(true)
      const plan = yield* db.all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN SELECT id FROM session WHERE parent_id IS NULL AND time_archived IS NULL AND ${ChatEligibility.condition()} ORDER BY time_updated DESC, id DESC LIMIT 51`,
      )
      expect(plan.some((row) => row.detail.includes("session_sidebar_updated_idx"))).toBe(true)
      for (const table of ["session_input", "message", "session_message"])
        expect(plan.some((row) => row.detail.includes("SEARCH " + table) && row.detail.includes("INDEX"))).toBe(true)
      expect(plan.some((row) => /SCAN (session|session_input|message|session_message)\b/.test(row.detail))).toBe(false)
      const searchPlan = yield* db.all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN SELECT id FROM session WHERE ${ChatTitleSearch.condition("Chat 19")}`,
      )
      expect(
        searchPlan.some(
          (row) => row.detail.includes("chat_title_search VIRTUAL TABLE INDEX") && row.detail.includes("M"),
        ),
      ).toBe(true)
      expect(searchPlan.some((row) => /SCAN session\b/.test(row.detail))).toBe(false)
      const shortPlan = yield* db.all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN SELECT id FROM session WHERE ${ChatTitleSearch.condition("19")}`,
      )
      expect(shortPlan.some((row) => row.detail.includes("SEARCH chat_title_short USING PRIMARY KEY"))).toBe(true)
    }),
  )
  it.effect(
    "indexed search treats wildcard characters literally and tracks title updates, deletion and project matches",
    () =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const service = yield* ChatOrganization.Service
        const rows = yield* seed()
        yield* service.chat(rows[0].id, { title: '100%_ complete \\ Élan "quoted"' })
        yield* service.chat(rows[1].id, { title: "10000 complete elan unquoted" })
        for (const search of ["%", "_", "%_", "100%_", "\\", "É", "Él", "Élan", '"quoted"', "COMPLETE \\"]) {
          expect((yield* service.chats({ search })).data.map((row) => row.id)).toEqual([rows[0].id])
        }
        expect((yield* service.chats({ search: "é" })).data).toHaveLength(0)
        yield* service.chat(rows[0].id, { title: "Renamed special document" })
        expect((yield* service.chats({ search: "100%_" })).data).toHaveLength(0)
        expect((yield* service.chats({ search: "special" })).data[0].id).toBe(rows[0].id)
        const project = yield* service.create({ name: "Project 100%_" })
        yield* service.chat(rows[2].id, { projectID: project.id })
        expect((yield* service.chats({ search: "100%_" })).data[0].id).toBe(rows[2].id)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, rows[0].id)).run()
        yield* db.run("VACUUM")
        expect((yield* service.chats({ search: "special" })).data).toHaveLength(0)
        expect((yield* service.chats({ search: "complete" })).data.map((row) => row.id)).toEqual([rows[1].id])
      }),
  )
  it.effect("the additive search extension backfills old sessions and can be safely reapplied", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const service = yield* ChatOrganization.Service
      const rows = yield* seed()
      for (const name of [
        "chat_title_session_insert",
        "chat_title_session_update",
        "chat_title_content_insert",
        "chat_title_content_update",
        "chat_title_content_delete",
      ])
        yield* db.run(sql`DROP TRIGGER ${sql.identifier(name)}`)
      for (const name of ["chat_title_short", "chat_title_search", "chat_title_content"])
        yield* db.run(sql`DROP TABLE ${sql.identifier(name)}`)
      yield* service.chat(rows[0].id, { title: "Legacy searchable title" })
      yield* db.transaction(ChatTitleSearch.up)
      yield* db.transaction(ChatTitleSearch.up)
      expect((yield* service.chats({ search: "searchable" })).data.map((row) => row.id)).toEqual([rows[0].id])
      expect(yield* db.get(sql`SELECT count(*) as count FROM chat_title_content`)).toEqual({ count: 3 })
      expect((yield* service.chats({ search: "Le" })).data[0].id).toBe(rows[0].id)
    }),
  )
})
