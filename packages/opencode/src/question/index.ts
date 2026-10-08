import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Clock, Deferred, Effect, Layer, Schema, Context, Scope } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import { QuestionID } from "./schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { QuestionV1 } from "@opencode-ai/schema/question-v1"
import { QuestionClock, type QuestionActivity } from "./clock"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"

export const Option = QuestionV1.Option
export type Option = typeof Option.Type
export const Info = QuestionV1.Info
export type Info = typeof Info.Type
export const Prompt = QuestionV1.Prompt
export type Prompt = typeof Prompt.Type
export const Tool = QuestionV1.Tool
export type Tool = typeof Tool.Type
export const Request = QuestionV1.Request
export type Request = typeof Request.Type
export const Answer = QuestionV1.Answer
export type Answer = typeof Answer.Type
export const Reply = QuestionV1.Reply
export type Reply = typeof Reply.Type
export const Replied = QuestionV1.Replied
export const Rejected = QuestionV1.Rejected
export const Event = QuestionV1.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionRejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Question.NotFoundError", {
  requestID: QuestionID,
}) {}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
  clock: QuestionClock
}

interface State {
  pending: Map<QuestionID, PendingEntry>
  location: Location.Info
}
const states = new Set<State>()
const settings = { enabled: true }

// Service

export interface Interface {
  readonly ask: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    tool?: Tool
    isBlocking?: boolean
  }) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: {
    requestID: QuestionID
    answers: ReadonlyArray<Answer>
  }) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: QuestionID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
  readonly activity: (input: {
    requestID: QuestionID
    sessionID: SessionID
    kind: QuestionActivity
  }) => Effect.Effect<void, NotFoundError>
  readonly configure: (enabled: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Question") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Question.state")(function* () {
        const context = yield* InstanceState.context
        const workspaceID = yield* InstanceState.workspaceID
        const state = {
          pending: new Map<QuestionID, PendingEntry>(),
          location: new Location.Info({
            directory: AbsolutePath.make(context.directory),
            ...(workspaceID ? { workspaceID } : {}),
            project: { id: Project.ID.make(context.project.id), directory: AbsolutePath.make(context.worktree) },
          }),
        }
        states.add(state)
        const scope = yield* Scope.Scope
        yield* Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep("1 second")
            const now = yield* Clock.currentTimeMillis
            for (const item of state.pending.values()) {
              const phase = item.clock.phase
              if (item.clock.tick(now)) {
                // Remove ownership synchronously before publishing. Reply,
                // cancellation and expiry can only resolve this request once.
                if (!state.pending.delete(item.info.id)) continue
                const answers = item.info.questions.map(() => [] as string[])
                yield* events
                  .publish(Event.Replied, { sessionID: item.info.sessionID, requestID: item.info.id, answers })
                  .pipe(Effect.andThen(Deferred.succeed(item.deferred, answers)), Effect.uninterruptible)
                continue
              }
              if (phase !== item.clock.phase) {
                item.info = { ...item.info, autoResolution: item.clock.snapshot() }
                yield* events.publish(Event.Asked, item.info)
              }
            }
          }
        }).pipe(Effect.forkIn(scope))

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
            states.delete(state)
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Question.ask")(function* (input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      tool?: Tool
      isBlocking?: boolean
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const id = QuestionID.ascending()
      yield* Effect.logInfo("asking", { id, questions: input.questions.length })

      const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
      const clock = new QuestionClock(input.isBlocking !== false, settings.enabled, yield* Clock.currentTimeMillis)
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
        isBlocking: input.isBlocking !== false,
        autoResolution: clock.snapshot(),
      }
      pending.set(id, { info, deferred, clock })
      return yield* Effect.ensuring(
        events.publish(Event.Asked, info).pipe(Effect.andThen(Deferred.await(deferred))),
        Effect.gen(function* () {
          if (!pending.delete(id)) return
          yield* events.publish(Event.Rejected, { sessionID: input.sessionID, requestID: id })
        }),
      )
    })

    const reply = Effect.fn("Question.reply")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(input.requestID)
      if (!existing) {
        yield* Effect.logWarning("reply for unknown request", { requestID: input.requestID })
        return yield* new NotFoundError({ requestID: input.requestID })
      }
      pending.delete(input.requestID)
      yield* Effect.logInfo("replied", { requestID: input.requestID, answers: input.answers })
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        answers: input.answers.map((a) => [...a]),
      })
      yield* Deferred.succeed(existing.deferred, input.answers)
    }, Effect.uninterruptible)

    const reject = Effect.fn("Question.reject")(function* (requestID: QuestionID) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(requestID)
      if (!existing) {
        yield* Effect.logWarning("reject for unknown request", { requestID })
        return yield* new NotFoundError({ requestID })
      }
      pending.delete(requestID)
      yield* Effect.logInfo("rejected", { requestID })
      yield* events.publish(Event.Rejected, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
      })
      yield* Deferred.fail(existing.deferred, new RejectedError())
    }, Effect.uninterruptible)

    const list = Effect.fn("Question.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (x) => x.info)
    })

    const activity = Effect.fn("Question.activity")(function* (input: {
      requestID: QuestionID
      sessionID: SessionID
      kind: QuestionActivity
    }) {
      const item = (yield* InstanceState.get(state)).pending.get(input.requestID)
      if (!item || item.info.sessionID !== input.sessionID)
        return yield* new NotFoundError({ requestID: input.requestID })
      const previous = item.clock.snapshot()
      item.clock.activity(input.kind, settings.enabled, yield* Clock.currentTimeMillis)
      if (previous.phase === item.clock.phase && previous.expiresAt === item.clock.expiresAt) return
      item.info = { ...item.info, autoResolution: item.clock.snapshot() }
      yield* events.publish(Event.Asked, item.info)
    })
    const configure = Effect.fn("Question.configure")(function* (enabled: boolean) {
      settings.enabled = enabled
      const now = yield* Clock.currentTimeMillis
      for (const state of states)
        for (const item of state.pending.values()) {
          item.clock.activity(item.clock.foreground ? "foreground" : "background", enabled, now)
          item.info = { ...item.info, autoResolution: item.clock.snapshot() }
          // Settings are global, but request updates stay routed to the
          // instance that owns them, rather than the Settings caller's folder.
          yield* events.publish(Event.Asked, item.info, { location: state.location })
        }
    })
    return Service.of({ ask, reply, reject, list, activity, configure })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as Question from "."
