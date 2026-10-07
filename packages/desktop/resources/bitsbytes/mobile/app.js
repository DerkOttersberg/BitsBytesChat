import { PhoneAudio } from "/audio.js"
const C = window.BB_COPY,
  $ = (selector) => document.querySelector(selector)
document.querySelectorAll("[data-copy]").forEach((node) => (node.textContent = C[node.dataset.copy]))
document.querySelectorAll("[data-label]").forEach((node) => {
  node.setAttribute("aria-label", C[node.dataset.label])
  node.title = C[node.dataset.label]
})
document.querySelectorAll("[data-placeholder]").forEach((node) => (node.placeholder = C[node.dataset.placeholder]))
$("#menu-button").setAttribute("aria-label", C.chats)
$("#device-name").value = C.phone
const state = {
  overview: null,
  chat: localStorage.getItem("bb.session") || "",
  tab: "chats",
  busy: false,
  messages: "",
  interactions: "",
  files: [],
  preview: null,
  page: 1,
  pdf: null,
  generation: 0,
  sending: false,
  polling: false,
  refreshGeneration: 0,
  refreshed: 0,
  drawerGeneration: 0,
}
const node = (tag, text, className) => {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = text
  if (className) element.className = className
  return element
}
const button = (text, fn, className) => {
  const element = node("button", text, className)
  element.type = "button"
  element.onclick = fn
  return element
}
let noticeTimer
const notice = (text) => {
  clearTimeout(noticeTimer)
  $("#notice").textContent = text
  $("#notice").hidden = !text
  if (text) noticeTimer = setTimeout(() => ($("#notice").hidden = true), 7000)
}
async function request(path, options = {}, timeout = options.method && options.method !== "GET" ? 0 : 15000) {
  const controller = timeout ? new AbortController() : null,
    timer = controller ? setTimeout(() => controller.abort(), timeout) : null
  try {
    const response = await fetch(path, { ...options, signal: options.signal || controller?.signal, credentials: "same-origin" })
    const value = await response.json()
    if (response.status === 401) {
      $("#app").hidden = true
      $("#pair-screen").hidden = false
      $("#pair-status").textContent = value.error
    }
    if (!response.ok) {
      const error = Error(value.error || C.error)
      error.status = response.status
      throw error
    }
    return value
  } catch (error) {
    if (controller?.signal.aborted) throw Error(C.disconnected)
    throw error
  } finally {
    clearTimeout(timer)
  }
}
const api = (method, args = {}) =>
  request("/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, args }),
  }, ["overview", "chat", "artifacts", "transcript-reference"].includes(method) ? 15000 : 0)
const draftKey = () => "bb.draft." + state.chat
const audio = new PhoneAudio({ copy: C, update: audioControls, notice, request, upload: uploadAudio, attach: attachTranscript })
function audioControls() {
  const active = audio.active, recording = !!active || audio.working
  $("#composer").dataset.recording = String(recording)
  $("#recording-controls").hidden = !recording
  $("#audio-button").disabled = recording
  $("#record-button").disabled = recording
  $("#recording-status").textContent = audio.working ? C.busy : active?.recorder.state === "paused" ? C.audioPaused : C.audioRecording
  const seconds = audio.seconds()
  $("#recording-time").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  const pause = $("#recording-pause"), label = active?.recorder.state === "paused" ? C.audioResume : C.audioPause
  pause.textContent = active?.recorder.state === "paused" ? "▶" : "Ⅱ"
  pause.setAttribute("aria-label", label)
  pause.title = label
  for (const id of ["recording-cancel", "recording-pause", "recording-finish"]) $("#" + id).disabled = audio.working || !active
}
async function attachTranscript(upload, sessionID) {
  const reference = await api("transcript-reference", { id: upload.jobID })
  const key = "bb.draft." + sessionID, value = draft(sessionID)
  localStorage.setItem(key, JSON.stringify({ ...value, transcripts: [
    ...(value.transcripts || []).filter((row) => row.id !== upload.jobID),
    { id: upload.jobID, revision: reference.revision, name: upload.name },
  ] }))
  if (sessionID === state.chat) attachments()
}
const draft = (sessionID = state.chat) => {
  const key = "bb.draft." + sessionID, source = localStorage.getItem(key)
  try {
    const value = JSON.parse(source || "{}")
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ["skills", "transcripts"].some(key => value[key] !== undefined && (!Array.isArray(value[key])
        || !value[key].every(row => row && typeof row.id === "string")))) throw Error(C.error)
    return value
  } catch {
    if (source) try { localStorage.setItem(key + ".recovery", source) } catch {}
    return {}
  }
}
function persist(value) {
  localStorage.setItem(draftKey(), JSON.stringify({ ...draft(), ...value }))
}
function restore() {
  const value = draft()
  $("#prompt").value = value.text || ""
  attachments()
  models(value.model, value.variant)
}
function attachments() {
  const root = $("#attachments")
  root.replaceChildren()
  const value = draft()
  for (const [kind, rows] of [
    ["skills", value.skills || []],
    ["transcripts", value.transcripts || []],
  ])
    for (const row of rows) {
      const chip = node("span", undefined, "source-chip")
      chip.append(
        button(row.name || C.transcript, async () => {
          const result = await api(kind === "skills" ? "skill" : "transcript", row)
          textPreview(row.name || C.transcript, result.text)
        }),
      )
      chip.append(
        button("×", () => {
          persist({ [kind]: rows.filter((item) => item.id !== row.id) })
          attachments()
        }),
      )
      chip.lastChild.setAttribute("aria-label", C.remove)
      root.append(chip)
    }
}
function models(preferred, variant) {
  const select = $("#model")
  select.replaceChildren()
  const empty = node("option", C.selectModel)
  empty.value = ""
  select.append(empty)
  for (const row of state.overview?.models || []) {
    const option = node("option", `${row.provider} · ${row.name}`)
    option.value = JSON.stringify({ providerID: row.providerID, modelID: row.id })
    select.append(option)
  }
  if ([...select.options].some((row) => row.value === preferred)) select.value = preferred
  else if (state.overview?.model) {
    const split = state.overview.model.indexOf("/"),
      model = JSON.stringify({
        providerID: state.overview.model.slice(0, split),
        modelID: state.overview.model.slice(split + 1),
      })
    if ([...select.options].some((row) => row.value === model)) select.value = model
  }
  variants(variant)
}
function variants(preferred) {
  const selected = $("#model").value ? JSON.parse($("#model").value) : null,
    model = state.overview?.models.find(
      (row) => row.providerID === selected?.providerID && row.id === selected?.modelID,
    )
  $("#variant").replaceChildren()
  const option = node("option", C.default)
  option.value = ""
  $("#variant").append(option)
  for (const variant of model?.variants || []) {
    const option = node("option", variant)
    option.value = variant
    $("#variant").append(option)
  }
  $("#variant").value = preferred || ""
  $("#variant").hidden = !model?.variants?.length
}
async function overview() {
  state.overview = await api("overview")
  state.refreshed = Date.now()
  models(draft().model, draft().variant)
  drawer()
}
async function select(id) {
  persist({ text: $("#prompt").value })
  state.chat = id
  localStorage.setItem("bb.session", id)
  state.messages = ""
  state.interactions = ""
  $("#drawer").hidden = true
  restore()
  await refresh()
}
async function create(carryDraft = false) {
  const value = { ...draft(), text: $("#prompt").value }
  const chat = await api("create")
  if (carryDraft) localStorage.setItem("bb.draft." + chat.id, JSON.stringify(value))
  await overview()
  await select(chat.id)
}
function drawer() {
  const generation = ++state.drawerGeneration
  document
    .querySelectorAll("[data-tab]")
    .forEach((button) => button.classList.toggle("active", button.dataset.tab === state.tab))
  const root = $("#drawer-body")
  root.replaceChildren()
  if (state.tab === "chats") {
    root.append(button(C.newChat, () => create().catch((error) => notice(error.message)), "list-row"))
    for (const chat of state.overview?.chats || [])
      root.append(
        button(chat.title || C.newChat, () => select(chat.id).catch((error) => notice(error.message)), "list-row"),
      )
  }
  if (state.tab === "skills")
    for (const skill of state.overview?.skills || []) {
      const row = node("div", undefined, "list-row")
      row.append(
        node("strong", skill.name),
        button(C.addSkill, () => {
          const value = draft()
          if (!(value.skills || []).some((row) => row.id === skill.id))
            persist({ skills: [...(value.skills || []), skill] })
          attachments()
          $("#drawer").hidden = true
        }),
        button(C.readSkill, async () => {
          const result = await api("skill", skill)
          textPreview(skill.name, result.text)
        }),
      )
      root.append(row)
    }
  if (state.tab === "uploads") {
    root.append(
      node("p", C.uploadLimit, "muted"),
      node("p", state.overview?.engine === "groq" ? C.onlineAudio : C.localAudio, "muted"),
      button(C.audioRecord, () => { $("#drawer").hidden = true; $("#record-button").click() }, "list-row"),
      button(C.choose, () => $("#audio-file").click(), "list-row"),
    )
    void recordings(root, generation)
    void uploads(root, generation)
  }
}
async function recordings(root, generation) {
  try {
    const rows = (await audio.records()).filter((row) => row.id !== audio.active?.row.id).sort((a, b) => b.created - a.created)
    if (state.tab !== "uploads" || state.drawerGeneration !== generation || !rows.length) return
    const group = node("section")
    group.append(node("strong", C.audioLocal), node("p", C.audioForeground, "muted"))
    for (const recording of rows) {
      const row = node("div", undefined, "list-row")
      if (recording.status === "recording") {
        row.append(node("strong", recording.name), node("small", C.audioOtherTab))
        group.append(row)
        continue
      }
      row.append(node("strong", recording.name), node("small", recording.error || (recording.status === "attached" ? C.audioAttached : recording.status === "processing" ? C.processing : C.audioSaved)))
      if (recording.status !== "attached") row.append(button(C.audioFinish, async () => {
        if (audio.active || audio.working) { notice(C.audioInProgress); return }
        audio.working = true
        audioControls()
        try { await audio.submit(recording) } catch (error) { notice(error.message) }
        finally { audio.working = false; audioControls(); drawer() }
      }))
      row.append(button(C.download, async () => {
        try {
          const url = URL.createObjectURL(await audio.file(recording)), link = node("a")
          link.href = url; link.download = recording.name; link.click()
          setTimeout(() => URL.revokeObjectURL(url), 30000)
        } catch (error) { notice(error.message) }
      }), button(C.audioDelete, async () => { await audio.remove(recording); drawer() }))
      group.append(row)
    }
    root.append(group)
  } catch (error) { notice(C.audioStorage) }
}
async function uploads(root, generation) {
  try {
    const rows = await request("/uploads")
    if (state.tab !== "uploads" || state.drawerGeneration !== generation) return
    for (const upload of rows) {
      const row = node("div", undefined, "list-row")
      row.append(
        node("strong", upload.name),
        node(
          "small",
          upload.status === "ready"
            ? C.complete
            : upload.error || (upload.status === "uploading" ? C.uploading : C.processing),
        ),
      )
      if (upload.status === "ready")
        row.append(
          button(C.attach, async () => {
            if (!state.chat) {
              notice(C.chooseChat)
              return
            }
            await attachTranscript(upload, state.chat)
            $("#drawer").hidden = true
          }),
          button(C.preview, async () => {
            const value = await api("transcript", { id: upload.jobID })
            textPreview(C.transcript, value.text)
          }),
        )
      if (upload.status === "error")
        row.append(
          button(C.retry, async () => {
            await request("/upload/" + upload.id + "/finish", { method: "POST", body: "{}" })
            drawer()
          }),
        )
      root.append(row)
    }
    if (!rows.length) root.append(node("p", C.noUploads, "muted"))
  } catch (error) {
    notice(error.message)
  }
}
function source(part) {
  const chip = button(
    part.filename || C.attachment,
    async () => {
      const url = new URL(part.url || "bitsbytes://none")
      const method = url.hostname === "skill" ? "skill" : "transcript"
      const result = await api(method, {
        id: url.pathname.slice(1),
        revision: Number(url.searchParams.get("revision")),
      })
      textPreview(part.filename || C.attachment, result.text)
    },
    "source-chip",
  )
  return chip
}
function timeline(messages) {
  const root = $("#messages"),
    bottom = root.scrollHeight - root.scrollTop - root.clientHeight < 100
  root.replaceChildren()
  if (!messages.length) root.append(node("p", C.empty, "muted"))
  for (const message of messages) {
    const parts = message.parts || [],
      text = parts
        .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
        .map((part) => part.text || "")
        .join("\n"),
      files = parts.filter((part) => part.type === "file" && part.url?.startsWith("bitsbytes://")),
      artifacts = state.files.filter((item) => (item.turnIDs || [item.turnID]).includes(message.info.id))
    const error =
      message.info.error?.data?.message || message.info.error?.message || (message.info.error ? C.error : "")
    if (!text && !files.length && !artifacts.length && !error) continue
    const row = node("article", undefined, "message " + message.info.role)
    if (text) row.append(node("div", text, "message-text"))
    if (error) row.append(node("div", error, "muted"))
    for (const part of files) row.append(source(part))
    for (const item of artifacts)
      row.append(fileCard(item, item.versions?.findLast((version) => version.turnID === message.info.id)?.revision))
    root.append(row)
  }
  if (bottom) root.scrollTop = root.scrollHeight
}
function fileCard(item, revision) {
  const card = button("", () => preview(item, revision), "artifact-card")
  card.append(
    node("strong", item.filename),
    node("small", `${C.revision} ${revision || item.revision}${item.status === "ready" ? "" : " · " + C.preparing}`),
  )
  return card
}
function interactions(chat) {
  const hash = JSON.stringify([chat.permissions, chat.questions])
  if (hash === state.interactions) return
  state.interactions = hash
  const root = $("#interactions")
  root.replaceChildren()
  for (const permission of chat.permissions) {
    const row = node("div", undefined, "interaction")
    row.append(
      node("strong", C.ask),
      node("pre", permission.permission + "\n" + (permission.patterns || []).join("\n")),
      button(C.allowOnce, async () => {
        await api("permission", { sessionID: state.chat, id: permission.id, reply: "once" })
        await refresh()
      }),
      button(C.deny, async () => {
        await api("permission", { sessionID: state.chat, id: permission.id, reply: "reject" })
        await refresh()
      }),
    )
    root.append(row)
  }
  for (const request of chat.questions) {
    const row = node("form", undefined, "interaction"),
      inputs = []
    for (const question of request.questions) {
      row.append(node("strong", question.question))
      const input = node("input")
      input.placeholder = C.answer
      row.append(input)
      for (const option of question.options || []) row.append(button(option.label, () => (input.value = option.label)))
      inputs.push(input)
    }
    row.append(
      button(C.submitAnswer, async () => {
        await api("question", { sessionID: state.chat, id: request.id, answers: inputs.map((input) => [input.value]) })
        await refresh()
      }),
    )
    root.append(row)
  }
}
async function refresh() {
  if (!state.chat) return
  const id = state.chat, generation = ++state.refreshGeneration,
    [chat, files] = await Promise.all([api("chat", { sessionID: id }), api("artifacts", { sessionID: id })])
  if (id !== state.chat || generation !== state.refreshGeneration) return
  $("#chat-title").textContent = chat.title || C.newChat
  state.files = files
  state.busy = Boolean(chat.status && chat.status.type !== "idle") || Boolean(chat.run.awaiting)
  const hash = JSON.stringify([chat.messages, files])
  if (hash !== state.messages) {
    state.messages = hash
    timeline(chat.messages)
  }
  $("#access").value = chat.access.mode
  $("#access").dataset.mode = chat.access.mode
  $("#stop").hidden = !state.busy
  $("#stop").textContent = "■"
  $("#steer").hidden = !state.busy
  $("#send").setAttribute("aria-label", state.busy ? C.queue : C.send)
  const queue = $("#queue-status")
  queue.replaceChildren()
  if (chat.run.error) queue.append(node("span", chat.run.error))
  if (chat.run.queue.length) {
    queue.append(node("span", `${C.queued} · ${chat.run.queue.length}`))
    if (chat.run.paused)
      queue.append(
        button(C.resume, async () => {
          await api("resume", { sessionID: id })
          await refresh()
        }),
      )
  }
  interactions(chat)
  if (!draft().model) {
    const last = chat.messages.findLast((row) => row.info.role === "user")
    if (last?.info.model)
      models(
        JSON.stringify({ providerID: last.info.model.providerID, modelID: last.info.model.modelID }),
        last.info.variant,
      )
  }
}
async function send(delivery = "queue") {
  if (audio.active || audio.working) { notice(C.audioInProgress); return }
  if (!state.chat) await create(true)
  if (state.sending) return
  const value = draft(),
    model = $("#model").value
  if (!model) {
    notice(C.unknownModel)
    return
  }
  const pending = value.pending || {
    sessionID: state.chat,
    id:
      "msg_" +
      BigInt.asUintN(48, BigInt(Date.now()) * 4096n)
        .toString(16)
        .padStart(12, "0") +
      crypto.randomUUID().replaceAll("-", "").slice(0, 14),
    text: $("#prompt").value,
    skills: value.skills || [],
    transcripts: value.transcripts || [],
    model: JSON.parse(model),
    variant: $("#variant").value,
    delivery,
  }
  persist({ pending })
  state.sending = true
  const id = state.chat
  try {
    await api("send", pending)
    const key = "bb.draft." + id,
      current = JSON.parse(localStorage.getItem(key) || "{}")
    localStorage.setItem(
      key,
      JSON.stringify({
        ...current,
        pending: undefined,
        ...((current.text || "") === pending.text ? { text: "", skills: [], transcripts: [] } : {}),
      }),
    )
    if (id === state.chat) restore()
    await refresh()
  } catch (error) {
    if (error.status >= 400 && error.status < 500) {
      const key = "bb.draft." + id,
        current = JSON.parse(localStorage.getItem(key) || "{}")
      localStorage.setItem(key, JSON.stringify({ ...current, pending: undefined }))
    }
    notice(error.message)
  } finally {
    state.sending = false
  }
}
$("#prompt").oninput = () => persist({ text: $("#prompt").value })
$("#model").onchange = () => {
  persist({ model: $("#model").value, variant: "" })
  variants()
}
$("#variant").onchange = () => persist({ variant: $("#variant").value })
$("#access").onchange = () =>
  api("access", { sessionID: state.chat, mode: $("#access").value }).catch((error) => notice(error.message))
$("#composer").onsubmit = (event) => {
  event.preventDefault()
  void send()
}
$("#prompt").onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault()
    void send(event.ctrlKey ? "steer" : "queue")
  }
}
$("#steer").onclick = () => void send("steer")
$("#stop").onclick = () =>
  api("stop", { sessionID: state.chat })
    .then(refresh)
    .catch((error) => notice(error.message))
$("#menu-button").onclick = () => {
  $("#drawer").hidden = !$("#drawer").hidden
  drawer()
  if (!$("#drawer").hidden) void overview().catch((error) => notice(error.message))
}
document.querySelectorAll("[data-tab]").forEach(
  (button) =>
    (button.onclick = () => {
      state.tab = button.dataset.tab
      drawer()
    }),
)
$("#audio-button").onclick = () => $("#audio-file").click()
$("#record-button").onclick = () => {
  const origin = state.chat
  void audio.start(async () => {
    if (origin) return origin
    await create(true)
    return state.chat
  }).catch((error) => notice(error.message))
}
$("#recording-pause").onclick = () => audio.pause()
$("#recording-cancel").onclick = () => audio.stop("cancelled")
$("#recording-finish").onclick = () => audio.stop("finish")
$("#logout").onclick = async () => {
  await request("/logout", { method: "POST", body: "{}" })
  location.reload()
}
$("#files-button").onclick = async () => {
  const items = await api("artifacts", { sessionID: state.chat })
  textPreview(C.documents, "")
  const root = $("#preview-content")
  if (!items.length) root.append(node("p", C.noFiles))
  for (const item of items) root.append(fileCard(item))
}
const hash = async (buffer) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
async function uploadAudio(file, id, uploadID, admitted = async () => {}) {
  if (file.size > 1024 ** 3) throw Error(C.tooLarge)
  if (!file.size) throw Error(C.audioEmpty)
  notice(C.uploading)
    const fingerprint = await hash(
      await new Blob([file.slice(0, 65536), file.slice(Math.max(0, file.size - 65536))]).arrayBuffer(),
    )
    const saved = uploadID ? (await request("/uploads")).find((row) => row.id === uploadID) : null
    const upload = saved || await request("/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionID: id, name: file.name, size: file.size, fingerprint }),
    })
    await admitted(upload)
    if (upload.status === "ready") return upload
    for (const chunk of upload.chunks)
      if ((await hash(await file.slice(chunk.offset, chunk.offset + chunk.length).arrayBuffer())) !== chunk.hash)
        throw Error(C.uploadMismatch)
    let offset = upload.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    while (offset < file.size) {
      const bytes = await file.slice(offset, offset + 4 * 1024 ** 2).arrayBuffer()
      let result, failure
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await request(`/upload/${upload.id}?offset=${offset}`, { method: "PUT", body: bytes })
          break
        } catch (error) {
          failure = error
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
      if (!result) throw failure
      offset = result.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      notice(`${C.uploading} ${Math.round((offset / file.size) * 100)}%`)
    }
    return request("/upload/" + upload.id + "/finish", { method: "POST", body: "{}" })
}
$("#audio-file").onchange = async () => {
  const file = $("#audio-file").files[0]
  if (!file) return
  if (audio.active || audio.working) { notice(C.audioInProgress); return }
  try {
    if (!state.chat) await create(true)
    await uploadAudio(file, state.chat)
    notice(C.uploadDone)
    state.tab = "uploads"
    $("#drawer").hidden = false
    drawer()
  } catch (error) {
    notice(error.message)
  } finally {
    $("#audio-file").value = ""
  }
}
function textPreview(title, text) {
  state.preview = null
  $("#preview-title").textContent = title
  $("#preview-content").replaceChildren(node("pre", text))
  $("#versions").hidden = true
  $("#download").hidden = true
  $("#pdf-controls").hidden = true
  if (!$("#preview").open) $("#preview").showModal()
}
async function preview(item, revision) {
  const token = ++state.generation
  state.preview = item
  state.pdf?.destroy()
  state.pdf = null
  state.page = 1
  $("#preview-title").textContent = item.filename
  $("#preview-content").replaceChildren(node("p", C.preparing))
  $("#download").hidden = false
  $("#versions").hidden = !item.versions?.length
  $("#versions").replaceChildren()
  for (const version of item.versions || []) {
    const option = node("option", `${C.revision} ${version.revision}`)
    option.value = version.revision
    $("#versions").append(option)
  }
  const selected = revision || item.revision
  $("#versions").value = selected
  $("#download").href = `/file/${item.id}?revision=${selected}`
  $("#pdf-controls").hidden = true
  if (!$("#preview").open) $("#preview").showModal()
  try {
    if (["document", "presentation", "pdf"].includes(item.kind)) {
      const { getDocument, GlobalWorkerOptions } = await import("/pdf.mjs")
      GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs"
      const task = getDocument({
        url: `/file/${item.id}?preview=1&revision=${selected}`,
        withCredentials: true,
        cMapUrl: "/pdf-assets/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdf-assets/standard_fonts/",
      })
      const pdf = await task.promise
      if (token !== state.generation) {
        pdf.destroy()
        return
      }
      state.pdf = pdf
      $("#pdf-controls").hidden = false
      await renderPage()
      return
    }
    const root = $("#preview-content")
    if (item.kind === "image") {
      const image = node("img")
      image.src = "/file/" + item.id + "?inline=1&revision=" + selected
      image.style.maxWidth = "100%"
      root.replaceChildren(image)
      return
    }
    const content = await api("content", { id: item.id, revision: selected })
    if (token !== state.generation) return
    root.replaceChildren()
    if (item.kind === "spreadsheet") {
      const select = node("select")
      for (const sheet of content.sheets) {
        const option = node("option", sheet)
        select.append(option)
      }
      select.value = content.sheet
      const table = node("table")
      const render = (value) => {
        table.replaceChildren()
        for (const row of value.rows) {
          const tr = node("tr")
          for (const cell of row) tr.append(node("td", cell))
          table.append(tr)
        }
      }
      render(content)
      let offset = 0
      const load = async () =>
        render(await api("content", { id: item.id, revision: selected, sheet: select.value, offset }))
      select.onchange = () => {
        offset = 0
        void load()
      }
      root.append(
        select,
        table,
        button(C.previous, () => {
          offset = Math.max(0, offset - 200)
          void load()
        }),
        button(C.next, () => {
          if (offset + 200 < content.total) {
            offset += 200
            void load()
          }
        }),
      )
      return
    }
    if (item.kind === "html") {
      const source = button(C.source, () => {
        root.replaceChildren(node("pre", content.text))
      })
      const frame = node("iframe")
      frame.setAttribute("sandbox", "allow-scripts")
      frame.src = "/html/" + item.id + "?revision=" + selected
      root.append(source, frame)
      return
    }
    root.append(node("pre", content.text || C.noContent))
  } catch (error) {
    if (token === state.generation)
      $("#preview-content").replaceChildren(
        node("p", error.message),
        button(C.retry, async () => {
          if (item.status === "error") await api("preview-retry", { id: item.id })
          await preview(item, selected)
        }),
      )
  }
}
async function renderPage() {
  if (!state.pdf) return
  const token = state.generation,
    pdf = state.pdf,
    page = await pdf.getPage(state.page)
  if (token !== state.generation) return
  const width = Math.max(240, $("#preview-content").clientWidth - 24),
    scale = width / page.getViewport({ scale: 1 }).width,
    ratio = Math.min(2, devicePixelRatio || 1),
    viewport = page.getViewport({ scale: scale * ratio }),
    canvas = node("canvas")
  canvas.width = viewport.width
  canvas.height = viewport.height
  canvas.style.width = width + "px"
  $("#preview-content").replaceChildren(canvas)
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise
  $("#pages").textContent = `${state.page} / ${pdf.numPages}`
}
$("#versions").onchange = () => preview(state.preview, Number($("#versions").value))
$("#previous-page").onclick = () => {
  if (state.page > 1) {
    state.page--
    void renderPage()
  }
}
$("#next-page").onclick = () => {
  if (state.pdf && state.page < state.pdf.numPages) {
    state.page++
    void renderPage()
  }
}
$("#preview-close").onclick = () => {
  $("#preview").close()
  state.generation++
  state.pdf?.destroy()
  state.pdf = null
}
let pairing = null,
  timer
const invitation = new URLSearchParams(location.hash.slice(1)).get("pair")
if (invitation) {
  history.replaceState(null, "", "/")
  $("#pair-screen").hidden = false
  $("#device-name").focus()
}
$("#pair-button").onclick = async () => {
  try {
    pairing = await request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: invitation, name: $("#device-name").value }),
    })
    $("#pair-button").disabled = true
    $("#pair-status").textContent = C.waiting
    timer = setInterval(async () => {
      try {
        const result = await request("/pair/" + pairing.id, { headers: { authorization: "Bearer " + pairing.secret } })
        if (result.status === "approved") {
          clearInterval(timer)
          await boot()
        }
        if (result.status === "rejected") {
          clearInterval(timer)
          $("#pair-status").textContent = C.cancelled
        }
      } catch (error) {
        clearInterval(timer)
        $("#pair-status").textContent = error.message
      }
    }, 1000)
  } catch (error) {
    $("#pair-status").textContent = error.message
  }
}
async function boot() {
  $("#pair-screen").hidden = true
  $("#app").hidden = false
  restore()
  await audio.recover().catch(() => notice(C.audioStorage))
  audioControls()
  await overview()
  await refresh()
}
if (!invitation) void boot().catch((error) => notice(error.message))
setInterval(async () => {
  if ($("#app").hidden || state.polling) return
  state.polling = true
  try {
    if (Date.now() - state.refreshed > 15000) await overview()
    await refresh()
    await audio.sync()
    $("#connection").textContent = C.paired
    if (state.tab === "uploads" && !$("#drawer").hidden) drawer()
  } catch (error) {
    $("#connection").textContent = C.disconnected
  } finally {
    state.polling = false
  }
}, 1500)
