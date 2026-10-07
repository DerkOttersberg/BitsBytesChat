import { expect, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createQueuedEditGuard, queuedEditCancelAction, queuedEditSelection } from "../src/components/chat-run-controls"

test("reactive route changes reject a delayed Edit response after A to B to A navigation", async () => {
  await createRoot(async (dispose) => {
    try {
      const [store, setStore] = createStore({ identity: "chat-a", composer: "original" })
      const guard = createQueuedEditGuard()
      createEffect(() => guard.select(store.identity))
      await Promise.resolve()
      const request = guard.begin(store.identity)
      setStore("identity", "chat-b")
      await Promise.resolve()
      setStore({ identity: "chat-a", composer: "new independent draft" })
      await Promise.resolve()
      if (guard.current(request, store.identity)) setStore("composer", "stale copied edit")
      expect(guard.current(request, store.identity)).toBe(false)
      expect(store.composer).toBe("new independent draft")
    } finally {
      dispose()
    }
  })
})

test("catalog resolution changes do not disguise unchanged persisted selections as a new composer", async () => {
  await createRoot(async (dispose) => {
    try {
      const model = { providerID: "fixture", modelID: "fixture" }
      const [store, setStore] = createStore<{ selected: typeof model; resolved?: typeof model }>({ selected: model })
      const queued = {
        sessionID: "chat-a",
        sessionDirectory: "C:/fixture",
        prompt: [{ type: "text" as const, content: "queued source", start: 0, end: 13 }],
        context: [],
        agent: "build",
        model,
      }
      const capture = () => ({
        prompt: queued.prompt,
        context: queued.context,
        ...queuedEditSelection({
          selectedModel: store.selected,
          resolvedModel: store.resolved,
          selectedAgent: "build",
          selectedVariant: null,
        }),
      })
      const before = capture()
      expect(before.model).toEqual(model)
      setStore("resolved", model)
      await Promise.resolve()
      expect(queuedEditCancelAction({ sessionID: "chat-a", before, current: capture(), queued })).toBe("clear")
      setStore("selected", { providerID: "explicit-other", modelID: "explicit-other" })
      await Promise.resolve()
      expect(queuedEditCancelAction({ sessionID: "chat-a", before, current: capture(), queued })).toBe("preserve")
    } finally {
      dispose()
    }
  })
})
