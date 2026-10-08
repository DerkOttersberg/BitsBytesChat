import { expect, test } from "bun:test"
import { LLM, LLMEvent, type LLMError, type LLMRequest } from "@opencode-ai/llm"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Stream } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Token } from "@opencode-ai/core/util/token"

const catalog = ModelV2.Info.make({
  id: ModelV2.ID.make("fixture-model"),
  providerID: ProviderV2.ID.make("fixture-provider"),
  name: "Fixture model",
  api: { id: ModelV2.ID.make("fixture-model"), type: "aisdk", package: "@ai-sdk/openai" },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: { headers: {}, body: {} },
  variants: [],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 128_000, output: 8192 },
})
const session = (contextWindow?: number) =>
  SessionSchema.Info.make({
    id: SessionSchema.ID.make("ses_context_compaction"),
    projectID: ProjectV2.ID.global,
    title: "fixture",
    model: { id: catalog.id, providerID: catalog.providerID, ...(contextWindow ? { contextWindow } : {}) },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make("/fixture") },
  })
const history = "Keep exact decisions and constraints. ".repeat(5500)
const entries = [
  {
    seq: 1,
    message: SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: history,
      time: { created: DateTime.makeUnsafe(0) },
    }),
  },
]

function fixture(stream?: (request: LLMRequest, index: number) => Stream.Stream<LLMEvent, LLMError>) {
  const published: { type: string; data: unknown }[] = []
  const requests: LLMRequest[] = []
  const events = EventV2.Service.of({
    publish: (definition, data) =>
      Effect.sync(() => {
        published.push({ type: definition.type, data })
        return { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
      }),
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    durable: () => Stream.empty,
    listen: () => Effect.succeed(Effect.void),
    project: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  })
  return {
    published,
    requests,
    compaction: SessionCompaction.make({
      events,
      config: [],
      llm: {
        stream: (request) => {
          requests.push(request)
          return (
            stream?.(request, requests.length - 1) ??
            Stream.succeed(LLMEvent.textDelta({ id: "summary", text: "## Objective\n- Retain the decisions." }))
          )
        },
      },
    }),
  }
}

test("V2 compaction uses the resolved selected context budget and retains the model output allowance", async () => {
  const recommended = await Effect.runPromise(SessionRunnerModel.resolve(session(), catalog))
  const selected = await Effect.runPromise(SessionRunnerModel.resolve(session(64_000), catalog))
  expect(selected.route.defaults.limits).toEqual({ context: 64_000, output: 8192 })
  expect(recommended.route.defaults.limits).toEqual({ context: 128_000, output: 8192 })
  const normal = fixture(),
    reduced = fixture()
  expect(
    await Effect.runPromise(
      normal.compaction.compactIfNeeded({
        sessionID: session().id,
        entries,
        model: recommended,
        request: LLM.request({ model: recommended, prompt: history }),
      }),
    ),
  ).toBe(false)
  expect(normal.requests).toEqual([])
  expect(
    await Effect.runPromise(
      reduced.compaction.compactIfNeeded({
        sessionID: session().id,
        entries,
        model: selected,
        request: LLM.request({ model: selected, prompt: history }),
      }),
    ),
  ).toBe(true)
  expect(reduced.requests).toHaveLength(1)
  expect(reduced.requests[0].model.route.defaults.limits).toEqual({ context: 64_000, output: 8192 })
  expect(reduced.requests[0].generation?.maxTokens).toBe(4096)
  expect(reduced.published.map((event) => event.type)).toEqual([
    SessionEvent.Compaction.Started.type,
    SessionEvent.Compaction.Ended.type,
  ])
})

test("Recommended preserves the catalog route and the same explicit summary output reserve", async () => {
  const recommended = await Effect.runPromise(SessionRunnerModel.resolve(session(), catalog))
  const catalogRoute = await Effect.runPromise(SessionRunnerModel.fromCatalogModel(catalog))
  expect(recommended.route.defaults).toEqual(catalogRoute.route.defaults)
  const selected = await Effect.runPromise(SessionRunnerModel.resolve(session(64_000), catalog))
  const normal = fixture(),
    reduced = fixture()
  for (const [model, f] of [
    [recommended, normal],
    [selected, reduced],
  ] as const)
    expect(
      await Effect.runPromise(
        f.compaction.compactAfterOverflow({
          sessionID: session().id,
          entries,
          model,
          request: LLM.request({ model, prompt: history, generation: { maxTokens: 2048 } }),
        }),
      ),
    ).toBe(true)
  expect(normal.requests[0].generation?.maxTokens).toBe(2048)
  expect(reduced.requests[0].generation?.maxTokens).toBe(2048)
  expect(normal.requests[0].messages).toEqual(reduced.requests[0].messages)
})

function oversizedHistory() {
  const prior = SessionMessage.Compaction.make({
    id: SessionMessage.ID.create(),
    type: "compaction",
    reason: "auto",
    summary: "Prior decision: retain the original requirement and its constraints.",
    recent: "[User]: Prior conversation that was retained verbatim. ".repeat(2400),
    time: { created: DateTime.makeUnsafe(0) },
  })
  const older = SessionMessage.User.make({
    id: SessionMessage.ID.create(),
    type: "user",
    text: "A recorded decision with exact source and recovery evidence. ".repeat(9000),
    time: { created: DateTime.makeUnsafe(1) },
  })
  const latest = SessionMessage.User.make({
    id: SessionMessage.ID.create(),
    type: "user",
    text: "Continue with the selected smaller context budget.",
    time: { created: DateTime.makeUnsafe(2) },
  })
  return {
    entries: [
      { seq: 1, message: prior },
      { seq: 2, message: older },
      { seq: 3, message: latest },
    ],
    summarized: `${prior.recent}\n\n[User]: ${older.text}`,
    summary: prior.summary,
    recent: `[User]: ${latest.text}`,
  }
}

function promptText(request: LLMRequest) {
  return request.messages
    .flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .join("\n")
}

test("lowering the context budget folds every prior-history slice in order and preserves the recent tail", async () => {
  const selected = await Effect.runPromise(SessionRunnerModel.resolve(session(64_000), catalog))
  const source = oversizedHistory()
  const before = JSON.stringify(source.entries)
  const f = fixture((_, index) =>
    Stream.succeed(
      LLMEvent.textDelta({
        id: "summary",
        text: `## Objective\n- Combined constraints through slice ${index + 1}.`,
      }),
    ),
  )
  expect(
    await Effect.runPromise(
      f.compaction.compactAfterOverflow({
        sessionID: session().id,
        entries: source.entries,
        model: selected,
        request: LLM.request({ model: selected, prompt: source.summarized }),
      }),
    ),
  ).toBe(true)
  expect(f.requests.length).toBeGreaterThan(2)
  expect(f.requests.length).toBeLessThanOrEqual(64)
  const prompts = f.requests.map(promptText)
  const slices = prompts.map((prompt) =>
    prompt.slice(prompt.indexOf("<conversation>\n") + "<conversation>\n".length, prompt.indexOf("\n</conversation>")),
  )
  expect(slices.join("")).toBe(source.summarized)
  expect(prompts[0]).toContain(`<prior-summary>\n${source.summary}\n</prior-summary>`)
  for (const [index, request] of f.requests.entries()) {
    expect(request.model.route.defaults.limits).toEqual({ context: 64_000, output: 8192 })
    expect(request.generation?.maxTokens).toBe(4096)
    expect(Token.estimate(prompts[index])).toBeLessThanOrEqual(64_000 - 4096)
    if (index > 0)
      expect(prompts[index]).toContain(
        `<prior-summary>\n## Objective\n- Combined constraints through slice ${index}.\n</prior-summary>`,
      )
  }
  expect(f.published.map((event) => event.type)).toEqual([
    SessionEvent.Compaction.Started.type,
    SessionEvent.Compaction.Ended.type,
  ])
  expect(f.published[1].data).toMatchObject({
    recent: source.recent,
    text: `## Objective\n- Combined constraints through slice ${f.requests.length}.`,
  })
  expect(JSON.stringify(source.entries)).toBe(before)
})

test("a failed later summary slice never replaces durable prior history with a partial summary", async () => {
  const selected = await Effect.runPromise(SessionRunnerModel.resolve(session(64_000), catalog))
  const source = oversizedHistory()
  const f = fixture((_, index) =>
    index === 0
      ? Stream.succeed(LLMEvent.textDelta({ id: "summary", text: "Partial summary from the first slice." }))
      : Stream.succeed(LLMEvent.providerError({ message: "Summary provider unavailable" })),
  )
  expect(
    await Effect.runPromise(
      f.compaction.compactAfterOverflow({
        sessionID: session().id,
        entries: source.entries,
        model: selected,
        request: LLM.request({ model: selected, prompt: source.summarized }),
      }),
    ),
  ).toBe(false)
  expect(f.requests).toHaveLength(2)
  expect(f.published.map((event) => event.type)).toEqual([SessionEvent.Compaction.Started.type])
})

test("canceling a pending summary leaves the old compaction and recent history authoritative", async () => {
  const selected = await Effect.runPromise(SessionRunnerModel.resolve(session(64_000), catalog))
  const source = oversizedHistory()
  const gate = await Effect.runPromise(Deferred.make<void>())
  const f = fixture(() => Stream.unwrap(Deferred.succeed(gate, undefined).pipe(Effect.as(Stream.never))))
  const exit = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const run = yield* f.compaction
          .compactAfterOverflow({
            sessionID: session().id,
            entries: source.entries,
            model: selected,
            request: LLM.request({ model: selected, prompt: source.summarized }),
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(gate)
        yield* Fiber.interrupt(run)
        return yield* Fiber.await(run)
      }),
    ),
  )
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  expect(f.requests).toHaveLength(1)
  expect(f.published.map((event) => event.type)).toEqual([SessionEvent.Compaction.Started.type])
})
