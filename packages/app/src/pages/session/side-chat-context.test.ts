import { expect, test } from "bun:test"
import { afterInheritedContext } from "./side-chat-context"

test("a side chat hides inherited turns without removing engine context or newer turns", () => {
  const messages = [
    { id: "inherited", time: { created: 100 } },
    { id: "first-side-turn", time: { created: 200 } },
    { id: "later-side-turn", time: { created: 300 } },
  ]
  expect(afterInheritedContext(messages, 200).map(message => message.id)).toEqual(["first-side-turn", "later-side-turn"])
  expect(messages.map(message => message.id)).toEqual(["inherited", "first-side-turn", "later-side-turn"])
  expect(afterInheritedContext(messages)).toBe(messages)
  expect(afterInheritedContext(messages.slice(0, 1), 200)).toEqual([])
})
