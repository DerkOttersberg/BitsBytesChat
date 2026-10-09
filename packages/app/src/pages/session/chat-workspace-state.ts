export type PanelTab = {
  id: string
  kind: "chat" | "browser" | "terminal" | "review" | "file" | "code" | "document" | "source" | "plan" | "goal" | "image"
  title: string
  owner: string
  path?: string
  uri?: string
  unread?: boolean
  revision?: number
  previewRevision?: number
}

export function workspacePanelLayout(workspaceWidth: number, preferredWidth: number, focused = false) {
  const available = Math.max(0, workspaceWidth - 16)
  const maximum = Math.max(0, available - 280 - 8)
  const overlay = !focused && maximum < 340
  return { width: focused || overlay ? available : Math.min(Math.max(340, preferredWidth), maximum), maximum, overlay }
}

export function readPanelState(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  maximumWidth = Number.POSITIVE_INFINITY,
) {
  const empty = {
    tabs: [] as PanelTab[],
    active: "",
    collapsed: true,
    focused: false,
    width: Math.min(520, maximumWidth),
  }
  const raw = (() => {
    try {
      return storage.getItem(key)
    } catch {
      return undefined
    }
  })()
  if (raw === null || raw === undefined) return { value: empty, writable: raw !== undefined }
  const parsed: unknown = (() => {
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  })()
  const previous = record(parsed) ? parsed : undefined
  const rows = Array.isArray(previous?.tabs) ? previous.tabs : []
  const valid = rows.filter(panelTab)
  const portable = valid.filter((row) => row.kind !== "browser" && row.kind !== "goal")
  const seen = new Set<string>()
  const tabs = portable.filter((row) => {
    if (seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
  const damaged =
    !previous ||
    (previous.tabs !== undefined && !Array.isArray(previous.tabs)) ||
    valid.length !== rows.length ||
    tabs.length !== portable.length ||
    (previous.active !== undefined && typeof previous.active !== "string") ||
    (previous.open !== undefined && typeof previous.open !== "boolean") ||
    (previous.collapsed !== undefined && typeof previous.collapsed !== "boolean") ||
    (previous.focused !== undefined && typeof previous.focused !== "boolean") ||
    (previous.width !== undefined &&
      (typeof previous.width !== "number" || !Number.isFinite(previous.width) || previous.width <= 0))
  const value = {
    tabs,
    active:
      typeof previous?.active === "string" && tabs.some((tab) => tab.id === previous.active)
        ? previous.active
        : (tabs.at(-1)?.id ?? ""),
    collapsed: !tabs.length
      ? true
      : typeof previous?.open === "boolean"
        ? !previous.open
        : !tabs.length || (typeof previous?.collapsed === "boolean" ? previous.collapsed : false),
    focused: Boolean(tabs.length && previous?.focused === true),
    width:
      typeof previous?.width === "number" && Number.isFinite(previous.width) && previous.width > 0
        ? Math.min(maximumWidth, Math.max(340, previous.width))
        : empty.width,
  }
  if (!damaged) return { value, writable: true }
  try {
    storage.setItem(`${key}.recovery.${Date.now()}.${crypto.randomUUID()}`, raw)
    return { value, writable: true }
  } catch {
    // Do not replace the original when a recovery copy cannot be saved.
    return { value, writable: false }
  }
}

export function savePanelState(storage: Pick<Storage, "setItem">, key: string, value: unknown) {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    /* Optional panel layout cannot prevent chat from opening. */
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function panelTab(value: unknown): value is PanelTab {
  return (
    record(value) &&
    typeof value.id === "string" &&
    Boolean(value.id) &&
    typeof value.title === "string" &&
    typeof value.owner === "string" &&
    Boolean(value.owner) &&
    typeof value.kind === "string" &&
    ["chat", "browser", "terminal", "review", "file", "code", "document", "source", "plan", "goal", "image"].includes(
      value.kind,
    ) &&
    (value.path === undefined || typeof value.path === "string") &&
    (value.uri === undefined || typeof value.uri === "string") &&
    (value.kind !== "source" || (typeof value.uri === "string" && Boolean(value.uri))) &&
    (value.kind !== "image" || (typeof value.uri === "string" && /^[a-f0-9]{64}$/.test(value.uri))) &&
    (value.unread === undefined || typeof value.unread === "boolean") &&
    (value.revision === undefined ||
      (typeof value.revision === "number" && Number.isInteger(value.revision) && value.revision >= 0)) &&
    (value.previewRevision === undefined ||
      (typeof value.previewRevision === "number" &&
        Number.isInteger(value.previewRevision) &&
        value.previewRevision >= 0))
  )
}
