import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Clock, Effect, Fiber, Layer, Queue } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Question } from "../../src/question"
import { SessionID } from "../../src/session/schema"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceState } from "../../src/effect/instance-state"
import { join } from "node:path"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const time = { now: Date.now() }
const clock = Effect.runSync(Clock.Clock)
const controlled: Clock.Clock = {
  currentTimeMillis: Effect.sync(() => time.now),
  currentTimeMillisUnsafe: () => time.now,
  currentTimeNanos: Effect.sync(() => clock.currentTimeNanosUnsafe()),
  currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
  sleep: (duration) => clock.sleep(duration),
}
const it = testEffect(
  LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, CrossSpawnSpawner.node])).pipe(
    Layer.provideMerge(Layer.succeed(Clock.Clock, controlled)),
  ),
)
const advance = (milliseconds: number) =>
  Effect.sync(() => {
    time.now += milliseconds
  }).pipe(Effect.andThen(Effect.sleep("1100 millis")))
const questions = ["Choose a layout", "Choose a color"].map((question) => ({
  question,
  header: "Preference",
  options: [
    { label: "Default (Recommended)", description: "Optional preference" },
    { label: "Alternative", description: "Another preference" },
  ],
}))

afterEach(disposeAllInstances)

it.instance(
  "global timer settings publish each pending request in its owning directory",
  () =>
    Effect.gen(function* () {
      const question = yield* Question.Service,
        events = yield* EventV2Bridge.Service,
        instance = yield* InstanceState.context
      const other = { ...instance, directory: join(instance.directory, "other-workspace") }
      const locations: { sessionID: string; directory?: string }[] = []
      const off = yield* events.listen((event) => {
        if (event.type === Question.Event.Asked.type)
          locations.push({
            sessionID: (event.data as Question.Request).sessionID,
            directory: event.location?.directory,
          })
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)
      const first = yield* question
        .ask({ sessionID: SessionID.make("ses_first"), questions, isBlocking: false })
        .pipe(Effect.forkScoped)
      yield* pending()
      const second = yield* question
        .ask({ sessionID: SessionID.make("ses_second"), questions, isBlocking: false })
        .pipe(Effect.provideService(InstanceRef, other), Effect.forkScoped)
      yield* pending().pipe(Effect.provideService(InstanceRef, other))
      try {
        locations.length = 0
        yield* question.configure(false)
        expect(locations).toEqual([
          { sessionID: "ses_first", directory: instance.directory },
          { sessionID: "ses_second", directory: other.directory },
        ])
        expect((yield* question.list())[0].autoResolution?.phase).toBe("disabled")
        expect((yield* question.list().pipe(Effect.provideService(InstanceRef, other)))[0].autoResolution?.phase).toBe(
          "disabled",
        )
        locations.length = 0
        yield* question.configure(true)
        expect(locations).toEqual([
          { sessionID: "ses_first", directory: instance.directory },
          { sessionID: "ses_second", directory: other.directory },
        ])
      } finally {
        yield* question.configure(true)
        yield* Fiber.interrupt(first)
        yield* Fiber.interrupt(second)
      }
    }),
  { git: true },
  30000,
)

const pending = Effect.fn("AutoResolutionTest.pending")(function* () {
  const question = yield* Question.Service,
    events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)
  while (true) {
    const list = yield* question.list()
    if (list.length) return list[0]
    yield* Queue.take(asked)
  }
})

it.instance(
  "optional expiry resolves once with empty answers and never selects Recommended",
  () =>
    Effect.gen(function* () {
      const question = yield* Question.Service,
        events = yield* EventV2Bridge.Service
      const replies: string[] = []
      const off = yield* events.listen((event) => {
        if (event.type === Question.Event.Replied.type) replies.push((event.data as { requestID: string }).requestID)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)
      const task = yield* question
        .ask({ sessionID: SessionID.make("ses_optional"), questions, isBlocking: false })
        .pipe(Effect.forkScoped)
      const request = yield* pending()
      expect(request.autoResolution?.phase).toBe("countdown")
      expect(request.autoResolution?.expiresAt).toBe(time.now + 90000)
      yield* advance(89000)
      expect(yield* question.list()).toHaveLength(1)
      yield* advance(1000)
      expect(yield* Fiber.join(task).pipe(Effect.timeout("2 seconds"))).toEqual([[], []])
      expect(yield* question.list()).toEqual([])
      expect(
        (yield* question.reply({ requestID: request.id, answers: [["Default (Recommended)"]] }).pipe(Effect.flip))._tag,
      ).toBe("Question.NotFoundError")
      yield* advance(10000)
      expect(replies).toEqual([request.id])
    }),
  { git: true },
  30000,
)

it.instance(
  "required questions wait; optional card interaction snoozes until an explicit reply",
  () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const required = yield* question
        .ask({ sessionID: SessionID.make("ses_required"), questions })
        .pipe(Effect.forkScoped)
      const first = yield* pending()
      expect(first.autoResolution?.phase).toBe("disabled")
      yield* advance(600000)
      expect(yield* question.list()).toHaveLength(1)
      yield* Fiber.interrupt(required)
      expect(yield* question.list()).toEqual([])
      const optional = yield* question
        .ask({ sessionID: SessionID.make("ses_snooze"), questions, isBlocking: false })
        .pipe(Effect.forkScoped)
      const next = yield* pending()
      expect(
        (yield* question
          .activity({ requestID: next.id, sessionID: SessionID.make("ses_other"), kind: "snooze" })
          .pipe(Effect.flip))._tag,
      ).toBe("Question.NotFoundError")
      yield* question.activity({ requestID: next.id, sessionID: next.sessionID, kind: "snooze" })
      yield* advance(600000)
      expect((yield* question.list())[0].autoResolution?.phase).toBe("snoozed")
      yield* question.reply({ requestID: next.id, answers: [["Alternative"], []] })
      expect(yield* Fiber.join(optional)).toEqual([["Alternative"], []])
    }),
  { git: true },
  30000,
)
