import { expect, test } from "bun:test"
import { readPanelState, savePanelState, type PanelTab } from "./chat-workspace-state"

const key = "bitsbytes.panels.v2:workspace:ses_test"
const tab: PanelTab = {
  id: "plan:ses_test",
  kind: "plan",
  title: "Saved plan",
  owner: "ses_test",
  revision: 3,
  previewRevision: 1,
  unread: true,
}

test("saved Goal panels are retired while the Plan tab remains available", () => {
  const f = fixture(JSON.stringify({ tabs: [tab, { ...tab, id: "goal:ses_test", kind: "goal", title: "Goal" }], active: "goal:ses_test", open: true }))
  const result = readPanelState(f.storage, key, 800)
  expect(result.value.tabs).toEqual([tab])
  expect(result.value.active).toBe(tab.id)
})
function fixture(raw: string | null) {
  const values = new Map<string, string>(raw === null ? [] : [[key, raw]])
  const faults = { read: false, write: false, recovery: false }
  const storage = {
    getItem(name: string) {
      if (faults.read) throw Error("Storage is unavailable")
      return values.get(name) ?? null
    },
    setItem(name: string, value: string) {
      if (faults.write || (faults.recovery && name.startsWith(key + ".recovery.")))
        throw Error("Storage quota exceeded")
      values.set(name, value)
    },
  }
  return {
    values,
    faults,
    storage,
    backups: () => [...values].filter(([name]) => name.startsWith(key + ".recovery.")).map(([, value]) => value),
  }
}

test("missing optional layout uses bounded defaults without a recovery copy", () => {
  const f = fixture(null)
  expect(readPanelState(f.storage, key, 400)).toEqual({
    value: { tabs: [], active: "", collapsed: true, width: 400 },
    writable: true,
  })
  expect(f.backups()).toEqual([])
})

test("valid panel state retains active tab, revisions, visibility and width", () => {
  const f = fixture(JSON.stringify({ tabs: [tab], active: tab.id, open: true, width: 640 }))
  expect(readPanelState(f.storage, key, 800)).toEqual({
    value: { tabs: [tab], active: tab.id, collapsed: false, width: 640 },
    writable: true,
  })
  expect(f.backups()).toEqual([])
})

test.each(["{", "[]", "null", "", '{"tabs":{}}'])(
  "damaged optional layout %j keeps its exact recovery source",
  (raw) => {
    const f = fixture(raw)
    const restored = readPanelState(f.storage, key, 800)
    expect(restored.value.tabs).toEqual([])
    expect(restored.writable).toBe(true)
    expect(f.backups()).toEqual([raw])
    expect(f.values.get(key)).toBe(raw)
  },
)

test("valid neighbors survive bad tab records, duplicate IDs and an ephemeral browser", () => {
  const source: PanelTab = {
    id: "source",
    kind: "source",
    title: "Frozen source",
    owner: "ses_test",
    uri: "bitsbytes://transcript/frozen?revision=2",
  }
  const raw = JSON.stringify({
    tabs: [
      tab,
      null,
      { ...tab, kind: "unknown" },
      { ...tab, id: "wrong-title", title: {} },
      { ...source, id: "missing-uri", uri: undefined },
      { ...tab, id: "bad-revision", revision: -1 },
      { ...tab, title: "Duplicate" },
      { ...tab, id: "browser", kind: "browser" },
      source,
    ],
    active: "removed",
    open: true,
  })
  const f = fixture(raw)
  const restored = readPanelState(f.storage, key, 800)
  expect(restored.value.tabs).toEqual([tab, source])
  expect(restored.value.active).toBe(source.id)
  expect(restored.value.collapsed).toBe(false)
  expect(f.backups()).toEqual([raw])
})

test("invalid layout field types cannot escape into the renderer", () => {
  const raw = JSON.stringify({ tabs: [tab], active: {}, open: "yes", collapsed: "no", width: "wide" })
  const f = fixture(raw)
  expect(readPanelState(f.storage, key, 800).value).toEqual({
    tabs: [tab],
    active: tab.id,
    collapsed: false,
    width: 520,
  })
  expect(f.backups()).toEqual([raw])
})

test("legacy collapsed state and explicit open state retain their precedence", () => {
  expect(
    readPanelState(fixture(JSON.stringify({ tabs: [tab], collapsed: true, width: 1200 })).storage, key, 800).value,
  ).toMatchObject({ collapsed: true, width: 800 })
  expect(
    readPanelState(fixture(JSON.stringify({ tabs: [tab], collapsed: true, open: true, width: 10 })).storage, key, 800)
      .value,
  ).toMatchObject({ collapsed: false, width: 340 })
})

test("an optional storage read failure leaves a usable default layout", () => {
  const f = fixture(null)
  f.faults.read = true
  expect(readPanelState(f.storage, key, 800)).toEqual({
    value: { tabs: [], active: "", collapsed: true, width: 520 },
    writable: false,
  })
  expect(f.values.size).toBe(0)
})

test("a failed recovery write retains the original while exposing valid neighbors", () => {
  const raw = JSON.stringify({ tabs: [tab, null], open: true })
  const f = fixture(raw)
  f.faults.recovery = true
  const restored = readPanelState(f.storage, key, 800)
  expect(restored.value.tabs).toEqual([tab])
  expect(restored.writable).toBe(false)
  expect(f.values.get(key)).toBe(raw)
  expect(f.backups()).toEqual([])
})

test("optional persistence failures are contained and later writes can recover", () => {
  const f = fixture("original")
  f.faults.write = true
  expect(() => savePanelState(f.storage, key, { tabs: [tab] })).not.toThrow()
  expect(f.values.get(key)).toBe("original")
  f.faults.write = false
  savePanelState(f.storage, key, { tabs: [tab] })
  expect(JSON.parse(f.values.get(key)!)).toEqual({ tabs: [tab] })
})

test("consecutive damaged states keep separate recovery copies", () => {
  const f = fixture("{")
  readPanelState(f.storage, key, 800)
  f.values.set(key, "[]")
  readPanelState(f.storage, key, 800)
  expect(f.backups()).toEqual(["{", "[]"])
})
