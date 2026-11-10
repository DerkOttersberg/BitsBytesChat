import { copy, AppError } from "../copy.js"
import type { Recording, Snapshot } from "../shared.js"
import { Recorder, unwrap } from "./recorder.js"
import { Waveform } from "./waveform.js"
import { speakerName, supportsSpeakers } from "../speakers.js"

const root = document.querySelector<HTMLDivElement>("#app")!
let snapshot: Snapshot
let selected: string | undefined
let view: "recordings" | "settings" | "ready" = "recordings"
let starting = false
let refreshing = false
let refreshAgain = false
let settingsDirty = false
let player: HTMLAudioElement | undefined
let playerId: string | undefined
const waveform = new Waveform()
const recorder = new Recorder(peak => waveform.update(peak), seconds => {
  const row = snapshot?.recordings.find(row => row.id === snapshot.activeId)
  if (seconds === undefined || !row) { void refresh(); return }
  row.duration = seconds
  const detail = document.querySelector(`[data-recording-id="${row.id}"] .item-detail`)
  if (detail) detail.textContent = `${duration(seconds)} · ${copy.recording}`
  const status = document.querySelector(".status.recording .status-text")
  if (status) status.textContent = `${copy.recording} · ${duration(seconds)}`
  const cost = document.querySelector<HTMLElement>(`.cost-summary[data-recording-id="${row.id}"]`)
  if (cost) { const info = costInfo(row); cost.textContent = info.text; cost.title = info.title }
}, showError)

const icons = {
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  import: '<svg viewBox="0 0 24 24"><path d="M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 6h7l2 2h9v12H3z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg>',
  speakers: '<svg viewBox="0 0 24 24"><circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v3"/></svg>'
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag); node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
function icon(name: keyof typeof icons) { const node = el("span", "icon"); node.innerHTML = icons[name]; node.setAttribute("aria-hidden", "true"); return node }
function button(text: string, action: () => unknown, className = "", symbol?: keyof typeof icons) {
  const node = el("button", `ci-button ${className}`)
  node.type = "button"
  node.dataset.ciSurface = className.includes("primary") ? "primary" : className.includes("subtle") || className.includes("recording-item") ? "nav" : "control"
  if (node.dataset.ciSurface === "nav") node.dataset.ciBorder = "none"
  if (symbol) node.append(icon(symbol))
  node.append(el("span", "", text))
  node.addEventListener("click", () => {
    node.disabled = true
    void Promise.resolve().then(action).catch(showError).finally(() => { if (node.isConnected) node.disabled = false })
  })
  return node
}
function iconButton(label: string, action: () => unknown, className: string, symbol: keyof typeof icons) {
  const node = button("", action, className, symbol)
  node.setAttribute("aria-label", label); node.title = label
  return node
}
function speakerSwitch(enabled: boolean, disabled: boolean, action: () => unknown) {
  const node = iconButton(copy.speakers, action, `speaker-toggle ${enabled ? "primary" : "secondary"}`, "speakers")
  node.setAttribute("role", "switch"); node.setAttribute("aria-checked", String(enabled)); node.disabled = disabled
  node.title = disabled ? copy.speakerModelHint : enabled ? copy.speakersOn : copy.speakersOff
  return node
}
function renderDictation() {
  const current = document.querySelector<HTMLDivElement>(".dictation-bar")
  if (!snapshot.activeId) { current?.remove(); return }
  if (current) return
  const bar = el("div", "dictation-bar")
  bar.setAttribute("role", "group"); bar.setAttribute("aria-label", copy.recording)
  const canvas = el("canvas", "waveform"); canvas.setAttribute("aria-hidden", "true")
  const stop = iconButton(copy.stop, async () => { await recorder.finish(); await refresh() }, "dictation-stop", "stop")
  const close = iconButton(copy.dismiss, async () => { await recorder.finish(); await refresh() }, "dictation-close", "close")
  // The waveform's dark instrument strip follows the supplied compact reference.
  stop.removeAttribute("data-ci-surface"); close.removeAttribute("data-ci-surface")
  stop.classList.remove("ci-button"); close.classList.remove("ci-button")
  bar.append(canvas, stop, close); root.append(bar); waveform.attach(canvas)
}
function duration(seconds: number) { const value = Math.floor(seconds); return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}` }
function money(value: number) {
  return value > 0 && value < .0001 ? "<$0.0001" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)
}
function costInfo(row?: Recording) {
  if (row?.costUSD !== undefined) return { text: `${row.status === "complete" && row.costComplete ? money(row.costUSD) : copy.costSoFar.replace("{amount}", money(row.costUSD))} USD`, title: copy.costReported }
  const rate = snapshot.rates[row?.preferences.model ?? snapshot.settings.model]
  if (rate && row?.status !== "complete") return { text: row && row.duration > 0 ? `≈ ${money(row.duration * rate.perSecond)} USD` : `≈ ${money(rate.perSecond * 60)}/min`, title: copy.costEstimate }
  return { text: row ? copy.costUnavailable : copy.costAfter, title: copy.costReported }
}
function costBadge(row?: Recording) {
  const info = costInfo(row)
  const node = el("span", "cost-summary", info.text); node.title = info.title; node.setAttribute("aria-label", `${copy.cost}: ${info.text}`)
  if (row) node.dataset.recordingId = row.id
  return node
}
async function startRecording() {
  document.querySelector<HTMLDivElement>("#toast")!.className = ""
  waveform.reset(); starting = true; render()
  try { selected = await recorder.start(snapshot.settings.microphone); view = "recordings" }
  finally { starting = false; await refresh() }
}
function toast(text: string, error = false) {
  const node = document.querySelector<HTMLDivElement>("#toast")!
  node.textContent = text; node.className = error ? "visible error" : "visible"
  setTimeout(() => { if (node.textContent === text) node.className = "" }, error ? 12000 : 2600)
}
function showError(error: unknown) { toast(error instanceof AppError && error.code in copy.errors ? copy.errors[error.code] : copy.errors.storage, true) }
async function refresh() {
  if (refreshing) { refreshAgain = true; return }
  refreshing = true
  try {
    do {
      refreshAgain = false
      snapshot = unwrap(await window.api.snapshot())
      if (view !== "ready" && (!selected || !snapshot.recordings.some(row => row.id === selected))) selected = snapshot.activeId || snapshot.recordings[0]?.id
      // Never replace a settings draft while capture progress updates arrive.
      if (view !== "settings" || !settingsDirty) render()
      else renderSidebar()
    } while (refreshAgain)
  } catch (error) { showError(error) } finally { refreshing = false }
}
function renderSidebar() {
  const existing = document.querySelector("aside")
  if (existing) window.CreamInk.unmount(existing)
  const aside = el("aside")
  aside.dataset.ciSurface = "header"
  const record = button(copy.record, () => {
    document.querySelector<HTMLDivElement>("#toast")!.className = ""
    selected = undefined; view = "ready"; settingsDirty = false; waveform.reset(); render()
  }, "primary", "plus")
  record.disabled = starting || !!snapshot.busyId || !!snapshot.activeId
  const actions = el("div", "new-record-actions")
  const active = snapshot.recordings.find(row => row.id === snapshot.activeId)
  const enabled = active?.preferences.speakers ?? snapshot.settings.speakers
  const supported = supportsSpeakers(active?.preferences.model ?? snapshot.settings.model)
  const speakers = speakerSwitch(enabled, !supported || !!snapshot.activeId || !!snapshot.busyId || starting, async () => { unwrap(await window.api.setSpeakers(!enabled)); await refresh() })
  if (supported) speakers.title = enabled ? copy.speakersOn : copy.speakersOff
  actions.append(record, speakers); aside.append(actions)
  const imported = button(copy.import, async () => { const id = unwrap(await window.api.importAudio()); if (id) selected = id; view = "recordings"; await refresh() }, "subtle import", "import")
  imported.disabled = !!snapshot.activeId || !!snapshot.busyId || starting
  aside.append(imported, el("div", "list-label", copy.recordings))
  const list = el("nav", "recordings-list"); list.setAttribute("aria-label", copy.recordings)
  for (const row of snapshot.recordings) {
    const item = button("", () => { selected = row.id; view = "recordings"; settingsDirty = false; render() }, `recording-item ${selected === row.id && view === "recordings" ? "selected" : ""}`)
    item.replaceChildren(icon("audio"))
    item.dataset.recordingId = row.id
    if (selected === row.id && view === "recordings") { item.dataset.ciSurface = "paper"; item.dataset.ciBorder = "dash"; item.setAttribute("aria-current", "true") }
    const meta = el("span", "item-meta"); meta.append(el("span", "item-title", row.title), el("span", "item-detail", `${duration(row.duration)} · ${copy[row.status]}`)); item.append(meta)
    if (row.status === "recording" || row.status === "transcribing") item.append(el("span", `dot ${row.status}`))
    list.append(item)
  }
  aside.append(list)
  const footer = el("div", "sidebar-footer")
  const settings = button(copy.settings, () => { view = "settings"; settingsDirty = false; render(); void microphones() }, `subtle ${view === "settings" ? "active" : ""}`, "settings")
  settings.title = `${copy.app} ${snapshot.version}`
  footer.append(settings)
  aside.append(footer)
  if (existing) existing.replaceWith(aside); else root.prepend(aside)
  window.CreamInk.mount(aside)
}
function render() {
  if (playerId !== selected) { player?.pause(); player = undefined; playerId = undefined }
  renderSidebar()
  const previous = document.querySelector("main")
  if (previous) { window.CreamInk.unmount(previous); previous.remove() }
  const main = el("main"); root.append(main)
  main.dataset.ciSurface = "paper"
  renderDictation()
  if (view === "settings") { renderSettings(main); window.CreamInk.mount(main); return }
  if (view === "ready") {
    const header = el("header", "recording-header"); header.dataset.ciSurface = "header"
    header.append(el("h1", "", copy.record), el("span", "status ready", copy.ready))
    const ready = el("section", "ready-screen")
    const start = button(copy.start, startRecording, "primary", "mic"); start.disabled = starting || !!snapshot.activeId || !!snapshot.busyId
    ready.append(el("div", "ready-clock", "00:00"), start, costBadge())
    main.append(header, ready); window.CreamInk.mount(main); return
  }
  const row = snapshot.recordings.find(value => value.id === selected)
  if (!row) {
    const empty = el("div", "empty"); const illustration = el("div", "empty-wave")
    for (let index = 0; index < 13; index++) illustration.append(el("i", `bar bar-${index}`))
    empty.append(illustration, el("h1", "", copy.emptyTitle), el("p", "", copy.emptyBody))
    main.append(empty); window.CreamInk.mount(main); return
  }
  const header = el("header", "recording-header")
  header.dataset.ciSurface = "header"
  const heading = el("div"); heading.append(el("h1", "", row.title))
  const badge = el("div", `status ${row.status}`); badge.append(el("span", "dot"), el("span", "status-text", `${copy[row.status]} · ${duration(row.duration)}`))
  header.append(heading, badge); main.append(header)
  const toolbar = el("div", "toolbar")
  if (snapshot.busyId === row.id) toolbar.append(button(copy.cancel, async () => { unwrap(await window.api.cancel()) }, "secondary"))
  else if (row.status !== "complete" && row.status !== "recording") {
    const transcribe = button(row.completedParts || row.status === "error" || row.status === "interrupted" ? copy.retry : copy.transcribe, async () => { unwrap(await window.api.transcribe(row.id)); await refresh() }, "primary", "audio")
    transcribe.disabled = !!snapshot.activeId || !!snapshot.busyId
    toolbar.append(transcribe)
  }
  const copyButton = button(copy.copy, async () => { unwrap(await window.api.copy(row.id)); toast(copy.copied) }, "secondary", "copy")
  copyButton.disabled = !row.transcript
  if (row.transcript) toolbar.append(copyButton)
  if (row.status !== "recording" && row.duration > 0) {
    const playback = el("div", "playback")
    const play = button(copy.listen, async () => {
      if (playerId !== row.id || !player) {
        const source = unwrap(await window.api.audio(row.id))
        player?.pause(); player = el("audio"); player.src = source; player.controls = true; player.preload = "metadata"
        player.setAttribute("aria-label", copy.listen); playerId = row.id
        player.onerror = () => showError(new AppError("playback"))
      }
      playback.replaceChildren(player)
      await player.play().catch(() => { throw new AppError("playback") })
    }, "subtle", "audio")
    play.disabled = !!snapshot.activeId
    if (playerId === row.id && player) playback.append(player); else playback.append(play)
    toolbar.prepend(playback)
  }
  toolbar.append(costBadge(row)); main.append(toolbar)
  if (row.status === "transcribing" && row.progress) {
    const processing = el("div", "transcription-progress")
    processing.setAttribute("role", "status"); processing.setAttribute("aria-live", "polite")
    const label = row.progress.stage === "preparing" ? copy.preparing : row.progress.stage === "saving" ? copy.savingTranscript : copy.transcribingPart.replace("{current}", String(Math.min(row.progress.completed + 1, row.progress.total ?? 1))).replace("{total}", String(row.progress.total ?? 1))
    const spinner = el("span", "spinner"); spinner.setAttribute("aria-hidden", "true")
    processing.append(spinner, el("span", "", label)); main.append(processing)
  }
  if (row.error && row.error in copy.errors) main.append(el("div", "notice", copy.errors[row.error as keyof typeof copy.errors]))
  const body = el("section", "transcript")
  body.setAttribute("aria-label", copy.transcript)
  const text = el("div", row.transcript ? "transcript-text" : "transcript-placeholder", row.transcript || copy.noTranscript)
  if (row.status !== "recording" && row.turns?.length) {
    for (const turn of row.turns) {
      const block = el("div", "speaker-turn")
      const caption = el("div", "speaker-caption")
      caption.append(el("strong", "speaker-label", speakerName(turn.speaker)), el("span", "speaker-time", duration(turn.start)))
      block.append(caption, el("p", "speaker-text", turn.text)); body.append(block)
    }
  } else {
    text.tabIndex = 0; if (row.status !== "recording") body.append(text)
  }
  main.append(body)
  const footer = el("footer", "recording-footer")
  const save = button(copy.export, async () => { unwrap(await window.api.exportAudio(row.id)) }, "subtle save-audio")
  save.disabled = !!snapshot.activeId || !!snapshot.busyId
  const remove = iconButton(copy.remove, async () => { unwrap(await window.api.remove(row.id)); await refresh() }, "subtle danger", "trash")
  remove.disabled = !!snapshot.activeId || !!snapshot.busyId
  footer.append(save, remove); if (row.status !== "recording") main.append(footer)
  window.CreamInk.mount(main)
}
function renderSettings(main: HTMLElement) {
  const header = el("header", "settings-header"); header.dataset.ciSurface = "header"; header.append(el("h1", "", copy.settingsTitle)); main.append(header)
  const form = el("form", "settings-form")
  form.addEventListener("input", () => { settingsDirty = true })
  function field(label: string, name: string, value: string, hint?: string, type = "text") {
    const wrapper = el("div", "field"); const caption = el("label", "", label); caption.htmlFor = name
    const input = el("input", "ci-field"); input.id = name; input.name = name; input.type = type; input.value = value; input.autocomplete = "off"; input.spellcheck = false
    wrapper.append(caption, input); if (hint) wrapper.append(el("p", "hint", hint)); form.append(wrapper); return input
  }
  const key = field(copy.key, "key", "", undefined, "password"); key.placeholder = snapshot.settings.hasKey ? copy.keySaved : copy.keyPlaceholder
  const model = field(copy.model, "model", snapshot.settings.model)
  const language = field(copy.language, "language", snapshot.settings.language)
  language.placeholder = copy.languageHint
  const microphoneField = el("div", "field"); const label = el("label", "", copy.microphone); label.htmlFor = "microphone"
  const select = el("select", "ci-field"); select.id = "microphone"; select.name = "microphone"
  const option = el("option", "", copy.defaultMic); option.value = ""; select.append(option)
  if (snapshot.settings.microphone) { const saved = el("option", "", copy.microphone); saved.value = snapshot.settings.microphone; select.append(saved); select.value = saved.value }
  microphoneField.append(label, select); form.append(microphoneField)
  const speakerField = el("div", "speaker-field")
  let separate = snapshot.settings.speakers
  const toggle = speakerSwitch(separate, !supportsSpeakers(model.value.trim()), () => {
    separate = !separate; settingsDirty = true; updateToggle()
  })
  const updateToggle = () => {
    const supported = supportsSpeakers(model.value.trim())
    if (!supported) separate = false
    toggle.disabled = !supported
    toggle.setAttribute("aria-checked", String(separate))
    toggle.dataset.ciSurface = separate ? "primary" : "control"
    toggle.title = supported ? separate ? copy.speakersOn : copy.speakersOff : copy.speakerModelHint
    window.CreamInk.mount(toggle)
  }
  model.addEventListener("input", updateToggle)
  speakerField.append(toggle, el("span", "", copy.speakers)); form.append(speakerField)
  form.append(el("p", "privacy", copy.privacy))
  const submit = el("button", "ci-button primary", copy.save); submit.dataset.ciSurface = "primary"; submit.type = "submit"; form.append(submit)
  form.addEventListener("submit", event => {
    event.preventDefault(); submit.disabled = true
    const data = new FormData(form)
    void window.api.saveSettings({ key: String(data.get("key")), model: String(data.get("model")), language: String(data.get("language")), microphone: String(data.get("microphone")), speakers: separate }).then(reply => {
      unwrap(reply); settingsDirty = false; if (view === "settings") toast(copy.savedSettings); return refresh()
    }).catch(showError).finally(() => { submit.disabled = false })
  })
  main.append(form)
  const storage = el("div", "storage"); const folder = button(copy.folder, async () => { unwrap(await window.api.folder()) }, "subtle", "folder"); folder.title = snapshot.settings.storagePath; storage.append(folder); main.append(storage)
  void microphones()
}
async function microphones() {
  const select = document.querySelector<HTMLSelectElement>("#microphone")
  if (!select) return
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  const value = select.value
  for (const [index, device] of devices.filter(device => device.kind === "audioinput").entries()) {
    if (!device.deviceId || [...select.options].some(option => option.value === device.deviceId)) continue
    const option = el("option", "", device.label || `${copy.microphone} ${index + 1}`); option.value = device.deviceId; select.append(option)
  }
  select.value = value
}
window.api.onChange(() => { void refresh() })
window.api.onClose(error => recorder.finish(error))
window.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyC" && selected) { event.preventDefault(); void window.api.copy(selected).then(reply => { unwrap(reply); toast(copy.copied) }).catch(showError) }
})
void refresh()
