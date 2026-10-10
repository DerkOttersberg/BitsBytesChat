import { afterEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createImageContent } from "./image-content"

type Request = { id: string; sessionID: string; revision: number; receive: (value: undefined) => void }
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((dispose) => dispose()))

function fixture(visible = true) {
  const requests: Request[] = []
  const receive = (event: Event) => requests.push((event as CustomEvent<Request>).detail)
  window.addEventListener("bitsbytes:image-content", receive)
  cleanups.push(() => window.removeEventListener("bitsbytes:image-content", receive))
  return createRoot((dispose) => {
    cleanups.push(dispose)
    const [view, setView] = createStore({
      visible,
      refresh: 0,
      artifact: { id: "image-1", sessionID: "chat-1", revision: 1 },
    })
    return {
      requests,
      view,
      setView,
      state: createImageContent(
        () => {
          view.refresh
          return { ...view.artifact }
        },
        () => view.visible,
      ),
      dispose,
    }
  })
}

describe("saved image content lifecycle", () => {
  test("hydrates visible images once", () => {
    const value = fixture()
    expect(value.requests).toHaveLength(1)
    expect(value.state.src).toBe("")
    expect(value.state.loaded).toBe(false)
  })

  test("fresh metadata objects with the same identity never reload", () => {
    const value = fixture()
    for (let index = 0; index < 12; index++) value.setView("refresh", index + 1)
    expect(value.requests).toHaveLength(1)
  })

  test("a new revision loads once", () => {
    const value = fixture()
    value.setView("artifact", "revision", 2)
    value.setView("artifact", { ...value.view.artifact })
    expect(value.requests.map((request) => request.revision)).toEqual([1, 2])
  })

  test("session and artifact ownership both participate in identity", () => {
    const value = fixture()
    value.setView("artifact", "id", "image-2")
    value.setView("artifact", "sessionID", "chat-2")
    expect(value.requests.map(({ id, sessionID }) => [id, sessionID])).toEqual([
      ["image-1", "chat-1"],
      ["image-2", "chat-1"],
      ["image-2", "chat-2"],
    ])
  })

  test("offscreen cards defer byte loading", () => {
    const value = fixture(false)
    value.setView("artifact", "revision", 3)
    expect(value.requests).toHaveLength(0)
    value.setView("visible", true)
    expect(value.requests.map((request) => request.revision)).toEqual([3])
  })

  test("late replies from a previous revision are ignored", () => {
    const value = fixture()
    value.setView("artifact", "revision", 2)
    value.requests[0].receive(undefined)
    expect(value.state.failed).toBe(false)
    value.requests[1].receive(undefined)
    expect(value.state.failed).toBe(true)
  })

  test("a newer revision can recover after a failed load", () => {
    const value = fixture()
    value.requests[0].receive(undefined)
    expect(value.state.failed).toBe(true)
    value.setView("artifact", "revision", 2)
    expect(value.state.failed).toBe(false)
  })

  test("failure recovery accepts the current reply after discarding a held revision", () => {
    const value = fixture()
    value.requests[0].receive(undefined)
    value.setView("artifact", "revision", 2)
    value.setView("artifact", "revision", 3)
    value.requests[1].receive(undefined)
    expect(value.state.failed).toBe(false)
    value.requests[2].receive(undefined)
    expect(value.state.failed).toBe(true)
  })

  test("disposal invalidates outstanding replies", () => {
    const value = fixture()
    value.dispose()
    value.requests[0].receive(undefined)
    expect(value.state.failed).toBe(false)
  })
})
