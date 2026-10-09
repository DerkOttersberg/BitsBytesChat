import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Schema } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionBranch } from "@opencode-ai/core/session/branch"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessageTable, SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionID } from "@opencode-ai/schema/session-id"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { SessionDurable } from "@opencode-ai/schema/durable-event-manifest"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { ChatOrganization } from "@opencode-ai/core/chat-project"
import { ChatOrganizationTable } from "@opencode-ai/core/chat-project/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node, ChatOrganization.node])),
)
const model = Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test"), contextWindow: 65536 })
const seed = Effect.fn(function* () {
  const db = (yield* Database.Service).db
  const events = yield* EventV2.Service
  const sessionID = SessionID.create()
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("C:/work"), sandboxes: [] })
    .run()
  yield* events.publish(SessionV1.Event.Created, {
    sessionID,
    info: SessionV1.SessionInfo.make({
      id: sessionID,
      projectID: Project.ID.global,
      directory: "C:/work",
      slug: "test",
      title: "Completed conversation",
      agent: "build",
      model,
      permission: [{ permission: "*", pattern: "*", action: "ask" }],
      version: "test",
      time: { created: 1, updated: 1 },
    }),
  })
  return { sessionID, events, db }
})
const complete = Effect.fn(function* (sessionID: SessionID, events: EventV2.Interface) {
  const userID = SessionMessage.ID.create()
  const assistantID = SessionMessage.ID.create()
  const base = { sessionID, timestamp: DateTime.makeUnsafe(2) }
  const owned = { ...base, assistantMessageID: assistantID }
  yield* events.publish(SessionEvent.Prompted, {
    ...base,
    messageID: userID,
    prompt: { text: "Inspect the immutable image" },
    delivery: "steer",
  })
  yield* events.publish(SessionEvent.Step.Started, { ...owned, agent: "build", model })
  yield* events.publish(SessionEvent.Reasoning.Started, { ...owned, reasoningID: "reason" })
  yield* events.publish(SessionEvent.Reasoning.Ended, { ...owned, reasoningID: "reason", text: "Inspecting safely" })
  yield* events.publish(SessionEvent.Tool.Input.Started, { ...owned, callID: "tool", name: "read_image" })
  yield* events.publish(SessionEvent.Tool.Input.Ended, {
    ...owned,
    callID: "tool",
    text: '{"path":"C:/work/image.png"}',
  })
  yield* events.publish(SessionEvent.Tool.Called, {
    ...owned,
    callID: "tool",
    tool: "read_image",
    input: { path: "C:/work/image.png" },
    provider: { executed: false },
  })
  yield* events.publish(SessionEvent.Tool.Success, {
    ...owned,
    callID: "tool",
    content: [],
    structured: { immutableImageReference: "source-snapshot" },
    outputPaths: ["C:/work/image.png"],
    provider: { executed: false },
  })
  yield* events.publish(SessionEvent.Text.Started, { ...owned, textID: "text" })
  yield* events.publish(SessionEvent.Text.Ended, { ...owned, textID: "text", text: "An inspected image" })
  yield* events.publish(SessionEvent.Step.Ended, {
    ...owned,
    timestamp: DateTime.makeUnsafe(3),
    finish: "stop",
    cost: 0,
    tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 0, write: 0 } },
  })
  return { userID, assistantID }
})

describe("canonical conversation lifecycle", () => {
  it.effect("forks the completed prefix as an independent durable root without pending inputs or live parts", () =>
    Effect.gen(function* () {
      const source = yield* seed()
      const organization = yield* ChatOrganization.Service
      const project = yield* organization.create({ name: "Collected" })
      yield* organization.chat(source.sessionID, { projectID: project.id, unread: true, pinned: true })
      const completed = yield* complete(source.sessionID, source.events)
      const live = { sessionID: source.sessionID, timestamp: DateTime.makeUnsafe(4) }
      const activeID = SessionMessage.ID.create()
      yield* source.events.publish(SessionEvent.PromptAdmitted, {
        ...live,
        messageID: SessionMessage.ID.create(),
        prompt: { text: "Queued" },
        delivery: "queue",
      })
      yield* source.events.publish(SessionEvent.Prompted, {
        ...live,
        messageID: SessionMessage.ID.create(),
        prompt: { text: "Active request" },
        delivery: "steer",
      })
      yield* source.events.publish(SessionEvent.Step.Started, {
        ...live,
        assistantMessageID: activeID,
        agent: "build",
        model,
      })
      yield* source.events.publish(SessionEvent.Reasoning.Started, {
        ...live,
        assistantMessageID: activeID,
        reasoningID: "still-thinking",
      })
      yield* source.db
        .update(SessionTable)
        .set({ model: { id: "next-model", providerID: "test", variant: "high", contextWindow: 98304 } })
        .where(eq(SessionTable.id, source.sessionID))
        .run()
      const forked = yield* SessionBranch.fork({ sessionID: source.sessionID })
      expect(forked.parentID).toBeUndefined()
      expect(forked.model?.contextWindow).toBe(98304)
      expect(String(forked.model?.id)).toBe("next-model")
      expect(String(forked.model?.variant)).toBe("high")
      expect(String(forked.agent)).toBe("build")
      const saved = yield* source.db.select().from(SessionTable).where(eq(SessionTable.id, forked.id)).get()
      expect(saved?.permission).toEqual([{ permission: "*", pattern: "*", action: "ask" }])
      const copied = yield* source.db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, forked.id))
        .all()
      expect(copied.map((message) => message.type)).toEqual(["user", "assistant"])
      expect(copied.some((message) => message.id === completed.userID || message.id === completed.assistantID)).toBe(
        false,
      )
      const assistant = copied.find((message) => message.type === "assistant")
      const decoded = Schema.decodeUnknownSync(SessionMessage.Message)({
        ...assistant!.data,
        id: assistant!.id,
        type: assistant!.type,
      })
      expect(decoded.type).toBe("assistant")
      if (decoded.type !== "assistant") throw new Error("Expected assistant")
      expect(decoded.model.contextWindow).toBe(65536)
      expect(decoded.time.completed).toBeDefined()
      expect(decoded.content.map((part) => part.type)).toEqual(["reasoning", "tool", "text"])
      expect(decoded.content.find((part) => part.type === "tool")).toMatchObject({
        state: { status: "completed", structured: { immutableImageReference: "source-snapshot" } },
      })
      expect(
        (yield* source.db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, forked.id))
          .all()).every((input) => input.promoted_seq !== null),
      ).toBe(true)
      expect(
        yield* source.db
          .select()
          .from(ChatOrganizationTable)
          .where(eq(ChatOrganizationTable.session_id, forked.id))
          .get(),
      ).toMatchObject({ project_id: project.id, pinned: false, unread: false })
      expect((yield* organization.chats({ projectID: project.id })).data.map((chat) => chat.id)).toContain(forked.id)
      const history = yield* EventV2.readAggregate(source.db, {
        aggregateID: forked.id,
        limit: 100,
        manifest: SessionDurable,
      })
      expect(history.events.some((event) => event.type === "session.next.step.ended")).toBe(true)
    }),
  )
  it.effect("rejects active or unknown fork boundaries before creating a conversation", () =>
    Effect.gen(function* () {
      const source = yield* seed()
      const activeID = SessionMessage.ID.create()
      yield* source.events.publish(SessionEvent.Step.Started, {
        sessionID: source.sessionID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID: activeID,
        agent: "build",
        model,
      })
      for (const messageID of [undefined, activeID, SessionMessage.ID.create()])
        expect((yield* SessionBranch.fork({ sessionID: source.sessionID, messageID }).pipe(Effect.result))._tag).toBe(
          "Failure",
        )
      expect(yield* source.db.select().from(SessionTable).all()).toHaveLength(1)
    }),
  )
  it.effect("default forks stop at the previous final response when a newer turn only completed a tool step", () =>
    Effect.gen(function* () {
      const source = yield* seed()
      yield* complete(source.sessionID, source.events)
      const toolStepID = SessionMessage.ID.create()
      const activeID = SessionMessage.ID.create()
      const base = { sessionID: source.sessionID, timestamp: DateTime.makeUnsafe(4) }
      yield* source.events.publish(SessionEvent.Prompted, {
        ...base,
        messageID: SessionMessage.ID.create(),
        prompt: { text: "An interrupted follow-up" },
        delivery: "steer",
      })
      yield* source.events.publish(SessionEvent.Step.Started, {
        ...base,
        assistantMessageID: toolStepID,
        agent: "build",
        model,
      })
      yield* source.events.publish(SessionEvent.Step.Ended, {
        ...base,
        assistantMessageID: toolStepID,
        finish: "tool-calls",
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      yield* source.events.publish(SessionEvent.Step.Started, {
        ...base,
        assistantMessageID: activeID,
        agent: "build",
        model,
      })
      const forked = yield* SessionBranch.fork({ sessionID: source.sessionID })
      expect(
        (yield* source.db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, forked.id))
          .all()).map((message) => message.type),
      ).toEqual(["user", "assistant"])
      const explicit = yield* SessionBranch.fork({
        sessionID: source.sessionID,
        messageID: toolStepID,
        inclusive: true,
      })
      expect(
        yield* source.db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, explicit.id))
          .all(),
      ).toHaveLength(4)
    }),
  )
  it.effect("forking unreadable history leaves no partially created session", () =>
    Effect.gen(function* () {
      const source = yield* seed()
      yield* complete(source.sessionID, source.events)
      yield* source.db.run("UPDATE session_message SET data = '{}' WHERE type = 'assistant'")
      expect((yield* SessionBranch.fork({ sessionID: source.sessionID }).pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* source.db.select().from(SessionTable).all()).toHaveLength(1)
    }),
  )
  it.effect("a storage failure rolls descendant deletion back and permits an explicit retry", () =>
    Effect.gen(function* () {
      const source = yield* seed()
      yield* complete(source.sessionID, source.events)
      const childID = SessionID.create()
      yield* source.events.publish(SessionV1.Event.Created, {
        sessionID: childID,
        info: SessionV1.SessionInfo.make({
          id: childID,
          parentID: source.sessionID,
          projectID: Project.ID.global,
          directory: "C:/work",
          slug: "owned",
          title: "Owned child",
          version: "test",
          time: { created: 1, updated: 1 },
        }),
      })
      yield* source.db.run(`CREATE TRIGGER prevent_removal BEFORE DELETE ON session
        WHEN old.id = '${source.sessionID}' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`)
      const execution = {
        active: Effect.succeed(new Set<SessionID>()),
        resume: () => Effect.void,
        wake: () => Effect.void,
        interrupt: () => Effect.void,
      }
      const removed = yield* SessionBranch.remove(source.sessionID).pipe(
        Effect.provideService(SessionExecution.Service, execution),
        Effect.exit,
      )
      expect(removed._tag).toBe("Failure")
      expect(yield* source.db.select().from(SessionTable).all()).toHaveLength(2)
      expect(
        yield* source.db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, source.sessionID))
          .all(),
      ).toHaveLength(2)
      yield* source.db.run("DROP TRIGGER prevent_removal")
      yield* SessionBranch.remove(source.sessionID).pipe(Effect.provideService(SessionExecution.Service, execution))
      expect(yield* source.db.select().from(SessionTable).all()).toHaveLength(0)
    }),
  )
  it.effect("deletes parent-owned descendants after joining their interruption and preserves independent forks", () =>
    Effect.gen(function* () {
      const source = yield* seed()
      yield* complete(source.sessionID, source.events)
      const forked = yield* SessionBranch.fork({ sessionID: source.sessionID })
      const childID = SessionID.create()
      const grandchildID = SessionID.create()
      const lateChildID = SessionID.create()
      for (const entry of [
        { id: childID, parentID: source.sessionID },
        { id: grandchildID, parentID: childID },
      ])
        yield* source.events.publish(SessionV1.Event.Created, {
          sessionID: entry.id,
          info: SessionV1.SessionInfo.make({
            ...entry,
            projectID: Project.ID.global,
            directory: "C:/work",
            slug: "owned",
            title: "Owned child",
            version: "test",
            time: { created: 1, updated: 1 },
          }),
        })
      const started = yield* Deferred.make<void>()
      const coordinator = yield* SessionRunCoordinator.make<SessionID, never>({
        drain: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              source.events.publish(SessionV1.Event.Created, {
                sessionID: lateChildID,
                info: SessionV1.SessionInfo.make({
                  id: lateChildID,
                  parentID: grandchildID,
                  projectID: Project.ID.global,
                  directory: "C:/work",
                  slug: "late-owned",
                  title: "Child admitted during interruption",
                  version: "test",
                  time: { created: 1, updated: 1 },
                }),
              }),
            ),
          ),
      })
      yield* coordinator.run(grandchildID).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect((yield* coordinator.active).has(grandchildID)).toBe(true)
      yield* SessionBranch.remove(source.sessionID).pipe(
        Effect.provideService(SessionExecution.Service, {
          active: coordinator.active,
          resume: coordinator.run,
          wake: coordinator.wake,
          interrupt: coordinator.interrupt,
        }),
      )
      expect((yield* coordinator.active).has(grandchildID)).toBe(false)
      expect((yield* source.db.select().from(SessionTable).all()).map((row) => row.id)).toEqual([forked.id])
      for (const id of [source.sessionID, childID, grandchildID, lateChildID]) {
        expect(
          yield* source.db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, id)).all(),
        ).toEqual([])
        const history = yield* source.db.select().from(EventTable).where(eq(EventTable.aggregate_id, id)).all()
        expect(history).toHaveLength(1)
        expect(history[0].type).toContain("session.deleted")
      }
    }),
  )
})
