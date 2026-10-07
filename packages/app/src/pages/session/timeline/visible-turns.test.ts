import { expect, test } from "bun:test"
import { visibleTurns } from "./visible-turns"

const messages = ["user-inherited", "assistant-inherited", "user-new", "assistant-new", "user-undone", "assistant-undone"].map(id => ({ id }))
const users = messages.filter(message => message.id.startsWith("user"))

test("inherited turns are hidden while the new answer remains visible", () => {
  expect(visibleTurns(messages, users, users.slice(1)).map(message => message.id)).toEqual(["user-new", "assistant-new", "user-undone", "assistant-undone"])
})
test("undo after inherited context preserves the selected turn and its answer", () => {
  expect(visibleTurns(messages, users, users.slice(1, 2)).map(message => message.id)).toEqual(["user-new", "assistant-new"])
  expect(visibleTurns(messages, users, users.slice(0, 1)).map(message => message.id)).toEqual(["user-inherited", "assistant-inherited"])
})
test("an untouched timeline retains its array and an empty fork hides all old rows", () => {
  expect(visibleTurns(messages, users, users)).toBe(messages)
  expect(visibleTurns(messages, users, [])).toEqual([])
})
