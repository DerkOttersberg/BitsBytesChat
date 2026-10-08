import { expect, test } from "bun:test"
import { QuestionClock } from "../../src/question/clock"

test("an optional background question expires at 90 seconds, never by selecting an option", () => {
  const clock = new QuestionClock(false, true, 1000)
  expect(clock.snapshot()).toEqual({ phase: "countdown", expiresAt: 91000 })
  expect(clock.tick(90999)).toBe(false)
  expect(clock.tick(91000)).toBe(true)
})

test("foreground inactivity starts a fresh 90 second countdown after 60 seconds", () => {
  const clock = new QuestionClock(false, true, 0)
  clock.activity("foreground", true, 1000)
  expect(clock.tick(60999)).toBe(false)
  expect(clock.tick(61000)).toBe(false)
  expect(clock.snapshot()).toEqual({ phase: "countdown", expiresAt: 151000 })
  expect(clock.tick(150999)).toBe(false)
  expect(clock.tick(151000)).toBe(true)
})

test("conversation activity resets foreground inactivity; background activity does not postpone expiry", () => {
  const clock = new QuestionClock(false, true, 0)
  clock.activity("conversation", true, 60000)
  expect(clock.snapshot().expiresAt).toBe(90000)
  clock.activity("foreground", true, 1000)
  clock.activity("conversation", true, 59999)
  expect(clock.snapshot().expiresAt).toBe(119999)
  clock.activity("background", true, 70000)
  expect(clock.snapshot().expiresAt).toBe(160000)
})

test("card interaction permanently snoozes its request across focus and settings changes", () => {
  const clock = new QuestionClock(false, true, 0)
  clock.activity("snooze", true, 10)
  for (const kind of ["foreground", "background", "conversation"] as const) clock.activity(kind, true, 20000)
  clock.activity("background", false, 30000)
  clock.activity("foreground", true, 40000)
  expect(clock.snapshot()).toEqual({ phase: "snoozed", expiresAt: undefined })
  expect(clock.tick(100000000)).toBe(false)
})

test("blocking and disabled questions never expire", () => {
  for (const clock of [new QuestionClock(true, true, 0), new QuestionClock(false, false, 0)]) {
    clock.activity("foreground", false, 0)
    expect(clock.snapshot()).toEqual({ phase: "disabled", expiresAt: undefined })
    expect(clock.tick(100000000)).toBe(false)
  }
  const blocking = new QuestionClock(true, true, 0)
  blocking.activity("background", true, 0)
  expect(blocking.tick(100000000)).toBe(false)
})

test("a delayed engine tick preserves the original deadline", () => {
  const clock = new QuestionClock(false, true, 0)
  clock.activity("foreground", true, 0)
  expect(clock.tick(150001)).toBe(true)
  expect(clock.snapshot().expiresAt).toBe(150000)
})
