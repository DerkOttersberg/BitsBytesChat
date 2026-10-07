// Persist encoded chunks as they arrive, instead of retaining an hour of audio in an array.
export class PhoneAudio {
  constructor(options) {
    this.options = options
    this.active = null
    this.working = false
    this.syncing = false
    this.db = null
  }
  async open() {
    if (this.db) return this.db
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("bitsbytes-audio", 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore("recordings", { keyPath: "id" })
        request.result.createObjectStore("chunks", { keyPath: ["id", "index"] })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return this.db
  }
  async transaction(stores, mode, action) {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode)
      const request = action(tx)
      tx.oncomplete = () => resolve(request?.result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || Error(this.options.copy.audioStorage))
    })
  }
  records() {
    return this.transaction(["recordings"], "readonly", (tx) => tx.objectStore("recordings").getAll())
  }
  save(row) {
    return this.transaction(["recordings"], "readwrite", (tx) => tx.objectStore("recordings").put({ ...row }))
  }
  remove(row) {
    if (this.active?.row.id === row.id || row.status === "recording") return
    return this.transaction(["recordings", "chunks"], "readwrite", (tx) => {
      tx.objectStore("chunks").delete(IDBKeyRange.bound([row.id, 0], [row.id, Number.MAX_SAFE_INTEGER]))
      return tx.objectStore("recordings").delete(row.id)
    })
  }
  async recover() {
    const recover = async () => {
      for (const row of await this.records()) {
        if (row.status !== "recording") continue
        await this.save({ ...row, status: "interrupted" })
      }
    }
    // A second phone tab must not recover or replace another tab's live capture.
    if (!navigator.locks) return recover()
    await navigator.locks.request("bitsbytes-phone-recording", { ifAvailable: true }, (lock) => {
      if (lock) return recover()
      // Closing a tab releases its locks asynchronously. Queue recovery without
      // blocking this tab's startup, rather than missing that release boundary.
      this.recovering ??= navigator.locks.request("bitsbytes-phone-recording", recover)
        .catch(() => this.options.notice?.(this.options.copy.audioStorage))
        .finally(() => { this.recovering = null })
    })
  }
  async file(row) {
    const chunks = await this.transaction(["chunks"], "readonly", (tx) =>
      tx.objectStore("chunks").getAll(IDBKeyRange.bound([row.id, 0], [row.id, Number.MAX_SAFE_INTEGER])),
    )
    const file = new File(chunks.map((chunk) => chunk.blob), row.name, { type: row.mime })
    if (file.size !== row.size || !file.size) throw Error(this.options.copy.audioEmpty)
    return file
  }
  async start(chat) {
    if (this.active || this.working) return
    const C = this.options.copy
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw Error(C.audioUnavailable)
    this.working = true
    this.options.update()
    let stream
    try {
      if (navigator.locks) await new Promise((resolve, reject) => {
        navigator.locks.request("bitsbytes-phone-recording", { ifAvailable: true }, async (lock) => {
          if (!lock) { reject(Error(C.audioOtherTab)); return }
          await new Promise((release) => { this.releaseLock = release; resolve() })
        }).catch(reject)
      })
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
        .find((type) => MediaRecorder.isTypeSupported(type))
      const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 96000 })
      const id = crypto.randomUUID(), type = recorder.mimeType || mime || "audio/webm"
      const row = {
        id, chat: await chat(), mime: type,
        name: C.audioRecording + " " + new Date().toISOString().replaceAll(":", "-") + (type.includes("mp4") ? ".m4a" : type.includes("ogg") ? ".ogg" : ".webm"),
        status: "recording", size: 0, count: 0, seconds: 0, created: Date.now(),
      }
      await this.save(row)
      const active = { row, recorder, stream, writes: Promise.resolve(), started: performance.now(), elapsed: 0, intent: "interrupted", failure: null }
      this.active = active
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return
        active.writes = active.writes.then(async () => {
          if (row.size + event.data.size > 1024 ** 3) throw Error(C.tooLarge)
          const next = { ...row, count: row.count + 1, size: row.size + event.data.size, seconds: this.seconds(active) }
          await this.transaction(["recordings", "chunks"], "readwrite", (tx) => {
            tx.objectStore("chunks").put({ id, index: row.count, blob: event.data })
            return tx.objectStore("recordings").put(next)
          })
          Object.assign(row, next)
        }).catch((error) => {
          active.failure = error
          if (recorder.state !== "inactive") recorder.stop()
        })
      }
      recorder.onerror = () => {
        active.failure = Error(C.audioInterrupted)
        if (recorder.state !== "inactive") recorder.stop()
      }
      recorder.onstop = () => void this.stopped(active)
      stream.getTracks().forEach((track) => track.addEventListener("ended", () => {
        if (recorder.state !== "inactive") recorder.stop()
      }))
      recorder.start(2000)
      active.timer = setInterval(() => this.options.update(), 500)
      if (navigator.wakeLock) active.wake = await navigator.wakeLock.request("screen").catch(() => null)
      this.options.notice(C.audioForeground)
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop())
      if (this.active?.recorder.state !== "inactive") this.active?.recorder.stop()
      else if (this.active) {
        await this.save({ ...this.active.row, status: "interrupted" }).catch(() => {})
        this.active = null
      }
      if (!this.active) { this.releaseLock?.(); this.releaseLock = null }
      if (error.name === "NotAllowedError" || error.name === "SecurityError") throw Error(C.audioPermission)
      throw error
    } finally {
      this.working = false
      this.options.update()
    }
  }
  seconds(active = this.active) {
    if (!active) return 0
    return Math.floor((active.elapsed + (active.started === null ? 0 : performance.now() - active.started)) / 1000)
  }
  pause() {
    const active = this.active
    if (!active || this.working) return
    if (active.recorder.state === "recording") {
      active.recorder.requestData()
      active.recorder.pause()
      active.elapsed += performance.now() - active.started
      active.started = null
    } else if (active.recorder.state === "paused") {
      active.recorder.resume()
      active.started = performance.now()
    }
    this.options.update()
  }
  stop(intent) {
    if (!this.active || this.working) return
    this.active.intent = intent
    this.working = true
    this.active.recorder.stop()
    this.options.update()
  }
  async stopped(active) {
    if (active.started !== null) active.elapsed += performance.now() - active.started
    active.started = null
    this.working = true
    clearInterval(active.timer)
    active.stream.getTracks().forEach((track) => track.stop())
    await active.wake?.release().catch(() => {})
    await active.writes
    const row = { ...active.row, seconds: this.seconds(active), status: active.failure ? "interrupted" : active.intent }
    this.active = null
    try {
      await this.save(row)
      if (active.failure) throw active.failure
      if (active.intent === "finish") await this.submit(row)
      if (active.intent === "cancelled") this.options.notice(this.options.copy.audioCancelled)
      if (active.intent === "interrupted") this.options.notice(this.options.copy.audioInterrupted)
    } catch (error) {
      this.options.notice(error.message)
    } finally {
      this.releaseLock?.()
      this.releaseLock = null
      this.working = false
      this.options.update()
    }
  }
  async submit(row) {
    if (row.status === "attached" || row.status === "recording") return
    await this.save({ ...row, status: "finish" })
    const upload = await this.options.upload(await this.file(row), row.chat, row.uploadID, async (upload) => {
      row.uploadID = upload.id
      // Persist the server ID before sending chunks or finalizing: a lost acknowledgement is an exact retry.
      await this.save({ ...row, status: "finish", error: "" })
    }).catch(async (error) => {
      await this.save({ ...row, status: "finish", error: error.message })
      throw error
    })
    await this.save({ ...row, uploadID: upload.id, status: "processing" })
    this.options.notice(this.options.copy.processing)
    await this.sync()
  }
  async sync() {
    if (this.syncing) return
    this.syncing = true
    try {
      const pending = (await this.records()).filter((row) => row.status === "processing")
      if (!pending.length) return
      const uploads = await this.options.request("/uploads")
      for (const row of pending) {
        const upload = uploads.find((item) => item.id === row.uploadID)
        if (upload?.status === "error") {
          await this.save({ ...row, status: "error", error: upload.error || this.options.copy.error })
          continue
        }
        if (upload?.status !== "ready") continue
        await this.options.attach(upload, row.chat)
        await this.save({ ...row, status: "attached" })
        this.options.notice(this.options.copy.audioAttached)
      }
    } finally {
      this.syncing = false
    }
  }
}
