import { describe, expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { todoDockAtBoundary, todoState } from "./session-composer-state"
import { sessionPermissionRequest, sessionQuestionRequest } from "./session-request-tree"

const session = (input: { id: string; parentID?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
  }) as Session

const permission = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
  }) as PermissionRequest

const question = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    questions: [],
  }) as QuestionRequest

describe("sessionPermissionRequest", () => {
  test("prefers the current session permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-root")
  })

  test("returns a nested child permission", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
      session({ id: "other" }),
    ]
    const permissions = {
      grand: [permission("perm-grand", "grand")],
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-grand")
  })

  test("returns undefined without a matching tree permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")).toBeUndefined()
  })

  test("skips filtered permissions in the current tree", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", (item) => item.id !== "perm-root"))?.toMatchObject({
      id: "perm-child",
    })
  })

  test("returns undefined when all tree permissions are filtered out", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", () => false)).toBeUndefined()
  })
})

describe("sessionQuestionRequest", () => {
  test("prefers the current session question", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const questions = {
      root: [question("q-root", "root")],
      child: [question("q-child", "child")],
    }

    expect(sessionQuestionRequest(sessions, questions, "root")?.id).toBe("q-root")
  })

  test("returns a nested child question", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
    ]
    const questions = {
      grand: [question("q-grand", "grand")],
    }

    expect(sessionQuestionRequest(sessions, questions, "root")?.id).toBe("q-grand")
  })
})

describe("todoState", () => {
  test("hides when there are no todos", () => {
    expect(todoState({ count: 0, done: false, live: true })).toBe("hide")
  })

  test("opens while the session is still working", () => {
    expect(todoState({ count: 2, done: false, live: true })).toBe("open")
  })

  test("closes completed todos after a running turn", () => {
    expect(todoState({ count: 2, done: true, live: true })).toBe("close")
  })

  test("clears stale todos when the turn ends", () => {
    expect(todoState({ count: 2, done: false, live: false })).toBe("clear")
  })

  test("clears completed todos when the session is no longer live", () => {
    expect(todoState({ count: 2, done: true, live: false })).toBe("clear")
  })

  test("desktop keeps unfinished todos available through Stop, idle and Resume", () => {
    const states = [true, false, false, true].map((live) =>
      todoState({ count: 2, done: false, live, retainIncomplete: true }),
    )
    expect(states).toEqual(["open", "open", "open", "open"])
    expect(states.map(todoDockAtBoundary)).toEqual([true, true, true, true])
  })

  test("desktop entry and route boundaries expose unfinished idle todos", () => {
    expect(todoDockAtBoundary(todoState({ count: 2, done: false, live: false, retainIncomplete: true }))).toBe(true)
  })

  test("desktop still closes finished active todos and clears finished idle todos", () => {
    expect(todoState({ count: 2, done: true, live: true, retainIncomplete: true })).toBe("close")
    expect(todoState({ count: 2, done: true, live: false, retainIncomplete: true })).toBe("clear")
    expect(todoDockAtBoundary(todoState({ count: 2, done: true, live: false, retainIncomplete: true }))).toBe(false)
  })

  test("retaining unfinished desktop work does not create an empty dock or alter upstream clearing", () => {
    expect(todoState({ count: 0, done: false, live: false, retainIncomplete: true })).toBe("hide")
    expect(todoState({ count: 2, done: false, live: false, retainIncomplete: false })).toBe("clear")
    expect(todoState({ count: 2, done: false, live: false })).toBe("clear")
  })

  test("desktop widget retains completed and cancelled progress after completion and reload", () => {
    for (const live of [true, false]) {
      expect(todoState({ count: 32, done: true, live, retainIncomplete: true, retainCompleted: true })).toBe("close")
    }
    expect(todoState({ count: 0, done: true, live: false, retainCompleted: true })).toBe("hide")
  })
})

describe("todoDockAtBoundary", () => {
  test("shows active todos when entering a session", () => {
    expect(todoDockAtBoundary("open")).toBe(true)
  })

  test("hides completed todos when entering a session", () => {
    expect(todoDockAtBoundary("close")).toBe(false)
  })
})
