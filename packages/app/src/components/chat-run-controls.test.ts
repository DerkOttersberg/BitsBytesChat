import { expect, test } from "bun:test"
import {
  createQueuedEditGuard,
  moveQueuedInput,
  reorderQueuedInput,
  queuedEditCancelAction,
  queuedEditSelection,
  type QueuedEditComposer,
} from "./chat-run-controls"
import type { FollowupDraft } from "./prompt-input/submit"

test("moving visible queued inputs retains the hidden edit reservation and every durable identity", () => {
  const queue = [{ id: "first" }, { id: "editing", editing: true }, { id: "last" }]
  const source = JSON.stringify(queue)
  expect(moveQueuedInput(queue, "last", -1)).toEqual(["last", "editing", "first"])
  expect(moveQueuedInput(queue, "first", 1)).toEqual(["last", "editing", "first"])
  expect(JSON.stringify(queue)).toBe(source)
})

test("hidden, missing and boundary rows cannot move an unrelated durable input", () => {
  const queue = [{ id: "editing", editing: true }, { id: "first" }, { id: "last" }]
  expect(moveQueuedInput(queue, "editing", 1)).toBeUndefined()
  expect(moveQueuedInput(queue, "missing", 1)).toBeUndefined()
  expect(moveQueuedInput(queue, "first", -1)).toBeUndefined()
  expect(moveQueuedInput(queue, "last", 1)).toBeUndefined()
  expect(moveQueuedInput([{ id: "editing", editing: true }], "editing", -1)).toBeUndefined()
})

test("drag reordering preserves hidden edit and sending slots and refuses stale targets", () => {
  const queue = [{ id: "first" }, { id: "editing", editing: true }, { id: "second" }, { id: "sending", status: "sending" }, { id: "third" }]
  expect(reorderQueuedInput(queue, "third", "first")).toEqual(["third", "editing", "first", "sending", "second"])
  expect(reorderQueuedInput(queue, "editing", "first")).toBeUndefined()
  expect(reorderQueuedInput(queue, "first", "sending")).toBeUndefined()
  expect(reorderQueuedInput(queue, "first", "deleted")).toBeUndefined()
  expect(queue.map(row => row.id)).toEqual(["first", "editing", "second", "sending", "third"])
})

test("keyboard reordering uses the same visible neighbors while preserving sending and transcript slots", () => {
  const queue = [{ id: "first" }, { id: "sending", status: "sending" }, { id: "in-chat", presentation: "transcript" }, { id: "last" }]
  expect(moveQueuedInput(queue, "last", -1)).toEqual(["last", "sending", "in-chat", "first"])
  expect(moveQueuedInput(queue, "first", 1)).toEqual(["last", "sending", "in-chat", "first"])
  expect(moveQueuedInput(queue, "sending", 1)).toBeUndefined()
  expect(moveQueuedInput(queue, "in-chat", -1)).toBeUndefined()
})

const draft: FollowupDraft = {
  sessionID: "chat-a",
  sessionDirectory: "C:/fixture",
  prompt: [{ type: "text", content: "queued source", start: 0, end: 13 }],
  context: [{ key: "file:C:/source", type: "file", path: "C:/source", comment: "saved source" }],
  agent: "build",
  model: { providerID: "fixture", modelID: "fixture" },
}

test("recovered Cancel clears only the unchanged copied queued draft and context", () => {
  const source = JSON.stringify(draft)
  const current = {
    ...draft,
    context: [{ comment: "saved source", path: "C:/source", type: "file" as const, key: "file:C:/source" }],
  }
  expect(queuedEditCancelAction({ sessionID: draft.sessionID, before: current, current, queued: draft })).toBe("clear")
  expect(JSON.stringify(draft)).toBe(source)
})

test("normal Cancel restores a prior draft only from the same chat", () => {
  const prior = { ...draft, prompt: [{ type: "text" as const, content: "pre-edit draft", start: 0, end: 14 }] }
  expect(
    queuedEditCancelAction({ sessionID: draft.sessionID, before: draft, current: draft, queued: draft, prior }),
  ).toBe("restore")
  expect(
    queuedEditCancelAction({
      sessionID: draft.sessionID,
      before: draft,
      current: draft,
      queued: draft,
      prior: { ...prior, sessionID: "chat-b" },
    }),
  ).toBe("clear")
})

test.each([
  { ...draft, prompt: [{ type: "text" as const, content: "new independent text", start: 0, end: 20 }] },
  { ...draft, context: [] },
  { ...draft, agent: "plan" },
  { ...draft, model: { providerID: "other", modelID: "other" } },
  { ...draft, variant: "high" },
])("Cancel preserves composer changes made while its acknowledgement was pending (%#)", (current) => {
  expect(
    queuedEditCancelAction({ sessionID: draft.sessionID, before: draft, current, queued: draft, prior: draft }),
  ).toBe("preserve")
  expect(queuedEditCancelAction({ sessionID: draft.sessionID, before: draft, current, queued: draft })).toBe("preserve")
})

test("recovered Cancel preserves independent text already present before clicking Cancel", () => {
  const current = { ...draft, prompt: [{ type: "text" as const, content: "new independent draft", start: 0, end: 21 }] }
  expect(queuedEditCancelAction({ sessionID: draft.sessionID, before: current, current, queued: draft })).toBe(
    "preserve",
  )
  expect(queuedEditCancelAction({ sessionID: "chat-b", before: draft, current: draft, queued: draft })).toBe("preserve")
  expect(queuedEditCancelAction({ sessionID: draft.sessionID, before: draft, current: draft })).toBe("preserve")
})

test("recovered image copies match by durable attachment ID across recreated blob URLs", () => {
  const image = {
    type: "image" as const,
    id: "image-a",
    mime: "image/png",
    filename: "source.png",
    dataUrl: "data:image/png;base64,Zmlyc3Q=",
  }
  const queued = { ...draft, prompt: [image] }
  const current: QueuedEditComposer = {
    ...draft,
    prompt: [{ ...image, blob: { id: "hash", url: "blob:restored-fixture" } }],
  }
  expect(queuedEditCancelAction({ sessionID: draft.sessionID, before: current, current, queued })).toBe("clear")
  expect(
    queuedEditCancelAction({
      sessionID: draft.sessionID,
      before: current,
      current,
      queued: { ...queued, prompt: [{ ...image, id: undefined }] },
    }),
  ).toBe("preserve")
})

test("identity changes invalidate a delayed Edit even after returning to the same chat", () => {
  const guard = createQueuedEditGuard()
  const request = guard.begin("chat-a")
  expect(guard.current(request, "chat-a")).toBe(true)
  guard.select("chat-b")
  guard.select("chat-a")
  expect(guard.current(request, "chat-a")).toBe(false)
})

test("new edit/cancel requests and disposal invalidate earlier asynchronous operations", () => {
  const guard = createQueuedEditGuard()
  const first = guard.begin("chat-a")
  const next = guard.begin("chat-a")
  expect(guard.current(first, "chat-a")).toBe(false)
  expect(guard.current(next, "chat-a")).toBe(true)
  guard.invalidate()
  expect(guard.current(next, "chat-a")).toBe(false)
})

test("recovered Cancel uses unchanged saved selections when catalog model and agent are unresolved", () => {
  const queued = { ...draft, variant: "high" }
  const selection = queuedEditSelection({
    selectedModel: draft.model,
    selectedAgent: draft.agent,
    selectedVariant: "high",
    resolvedModel: undefined,
    resolvedAgent: undefined,
    resolvedVariant: undefined,
  })
  const current = { prompt: draft.prompt, context: draft.context, ...selection }
  expect(selection).toEqual({ model: draft.model, agent: draft.agent, variant: "high" })
  expect(queuedEditCancelAction({ sessionID: draft.sessionID, before: current, current, queued })).toBe("clear")
})

test.each([
  {
    selectedModel: { providerID: "different-provider", modelID: "different-model" },
    selectedAgent: draft.agent,
    selectedVariant: null,
  },
  { selectedModel: draft.model, selectedAgent: "plan", selectedVariant: null },
  { selectedModel: draft.model, selectedAgent: draft.agent, selectedVariant: "high" },
])("recovered Cancel protects explicit saved selection changes despite unresolved/fallback catalogs (%#)", (saved) => {
  const selection = queuedEditSelection({ ...saved, resolvedModel: draft.model, resolvedAgent: draft.agent })
  const current = { prompt: draft.prompt, context: draft.context, ...selection }
  expect(queuedEditCancelAction({ sessionID: draft.sessionID, before: current, current, queued: draft })).toBe(
    "preserve",
  )
})

test("saved selection IDs remain authoritative over a different resolved fallback model", () => {
  const selection = queuedEditSelection({
    selectedModel: draft.model,
    selectedAgent: draft.agent,
    selectedVariant: null,
    resolvedModel: { providerID: "fallback", modelID: "fallback" },
    resolvedVariant: "configured-high",
  })
  const current = { prompt: draft.prompt, context: draft.context, ...selection }
  expect(selection).toEqual({ model: draft.model, agent: draft.agent, variant: undefined })
  expect(queuedEditCancelAction({ sessionID: draft.sessionID, before: current, current, queued: draft })).toBe("clear")
})

test("unsaved default selections use resolved IDs without dropping explicit variant changes", () => {
  expect(
    queuedEditSelection({ resolvedModel: draft.model, resolvedAgent: draft.agent, resolvedVariant: "configured-high" }),
  ).toEqual({ model: draft.model, agent: draft.agent, variant: "configured-high" })
  expect(queuedEditSelection({ selectedVariant: null, resolvedVariant: "configured-high" }).variant).toBeUndefined()
})

test("normal Cancel can restore pre-edit text even when no model is currently available", () => {
  const prior = {
    sessionID: draft.sessionID,
    prompt: [{ type: "text" as const, content: "pre-edit source", start: 0, end: 15 }],
    context: [],
    agent: undefined,
    model: undefined,
  }
  expect(
    queuedEditCancelAction({ sessionID: draft.sessionID, before: draft, current: draft, queued: draft, prior }),
  ).toBe("restore")
})
