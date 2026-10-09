import { describe, expect, test } from "bun:test"
import { searchSettings } from "./settings-search"

describe("settings search", () => {
  const entries = [
    { id: "microphone", tab: "audio", title: "Microphone", description: "Choose an audio input device" },
    { id: "image", tab: "tools", title: "Image generation", description: "Connect an OpenAI API key" },
    { id: "theme", tab: "general", title: "Theme", description: "Customize your appearance" },
  ]

  test("finds titles, descriptions and small typing mistakes across categories", () => {
    expect(searchSettings(entries, "microphne")[0]?.id).toBe("microphone")
    expect(searchSettings(entries, "OpenAI")[0]?.id).toBe("image")
    expect(searchSettings(entries, "appearance")[0]?.id).toBe("theme")
    expect(searchSettings(entries, "  audio input  ")[0]?.tab).toBe("audio")
  })

  test("empty or unrelated input never suggests arbitrary settings", () => {
    expect(searchSettings(entries, " ")).toEqual([])
    expect(searchSettings(entries, "unrelated gibberish")).toEqual([])
    expect(entries.map((entry) => entry.id)).toEqual(["microphone", "image", "theme"])
  })

  test("rejects scattered description matches while retaining concise terms and typing mistakes", () => {
    const catalogue = [
      ...entries,
      { id: "key", tab: "tools", title: "OpenAI image API key" },
      {
        id: "timer",
        tab: "tools",
        title: "Optional question timer",
        description:
          "Optional questions can expire with empty answers. Foreground inactivity waits one minute, then counts down 90 seconds; background questions wait 90 seconds. Interacting with a question keeps it open. Required questions and approvals always wait.",
      },
    ]
    expect(searchSettings(catalogue, "OpenAI image API key").map((entry) => entry.id)).toEqual(["key", "image"])
    expect(searchSettings(catalogue, "key").map((entry) => entry.id)).toContain("key")
    expect(searchSettings(catalogue, "thme")[0]?.id).toBe("theme")
    expect(searchSettings(catalogue, "microphne")[0]?.id).toBe("microphone")
  })

  test("bounds results for a large extension catalogue", () => {
    const catalogue = Array.from({ length: 200 }, (_, index) => ({
      id: String(index),
      tab: "tools",
      title: `Image setting ${index}`,
    }))
    expect(searchSettings(catalogue, "image")).toHaveLength(50)
  })
})
