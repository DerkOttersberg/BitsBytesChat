import { describe, expect, test } from "bun:test"
import { revealSetting } from "../src/components/settings-v2/settings-search"

describe("settings search navigation", () => {
  test("waits for a lazy panel, focuses its control and removes the highlight on disposal", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const stop = revealSetting(root, "audio-microphone")
    const label = document.createElement("label")
    label.dataset.settingKey = "audio-microphone"
    const select = document.createElement("select")
    label.append(select)
    root.append(label)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(label.classList.contains("settings-v2-search-highlight")).toBe(true)
    expect(document.activeElement).toBe(select)
    stop()
    expect(label.classList.contains("settings-v2-search-highlight")).toBe(false)
    root.remove()
  })

  test("a cancelled navigation never steals focus when a late target appears", async () => {
    const root = document.createElement("div")
    const current = document.createElement("input")
    document.body.append(root, current)
    current.focus()
    const stop = revealSetting(root, "settings-theme")
    stop()
    const row = document.createElement("div")
    row.dataset.action = "settings-theme"
    row.append(document.createElement("button"))
    root.append(row)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(document.activeElement).toBe(current)
    expect(row.classList.contains("settings-v2-search-highlight")).toBe(false)
    root.remove()
    current.remove()
  })
})
