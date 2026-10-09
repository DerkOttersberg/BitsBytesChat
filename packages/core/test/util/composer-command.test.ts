import { describe, expect, test } from "bun:test"
import { composerCommand, removeComposerCommand } from "../../src/util/composer-command"

describe("mode commands inside a draft", () => {
  test("completes Plan and Goal after existing prose and at a middle caret", () => {
    expect(composerCommand("Build a game /pl")).toEqual({ start: 13, end: 16, query: "pl" })
    expect(composerCommand("Build /goal tomorrow", 11)).toEqual({ start: 6, end: 11, query: "goal" })
    expect(composerCommand("/custom/nested")).toEqual({ start: 0, end: 14, query: "custom/nested" })
  })
  test("keeps paths, URLs, code and ordinary commands literal in prose", () => {
    for (const value of [
      "read /tmp",
      "https://host/plan",
      "`do /plan",
      "```txt\n/goal",
      "~~~\n/plan",
      "build/plan",
      "show /custom",
    ])
      expect(composerCommand(value)).toBeUndefined()
    expect(composerCommand("```\n/plan\n```\nThen /goal")?.query).toBe("goal")
  })
  test("removes only the token while preserving suffix, mentions and image identity", () => {
    const parts = [
      { type: "file", content: "@file", start: 0, end: 5, path: "notes.md" },
      { type: "text", content: " do /plan next", start: 5, end: 19 },
      { type: "image", id: "snapshot", url: "recorded-image" },
    ]
    const next = removeComposerCommand(parts, { start: 9, end: 14 })
    expect(next.prompt.map((row) => row.content ?? "").join("")).toBe("@file do  next")
    expect(next.prompt[0]).toEqual(parts[0])
    expect(next.prompt[2]).toEqual(parts[2])
    expect(next.cursor).toBe(9)
    expect(next.prompt[1].end).toBe(14)
    expect(parts[1].content).toBe(" do /plan next")
  })
})
