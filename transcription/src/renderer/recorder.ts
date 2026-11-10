import { AppError } from "../copy.js"
import type { Reply } from "../shared.js"
export function unwrap<T>(reply: Reply<T>): T {
  if (!reply.ok) throw new AppError(reply.error as ConstructorParameters<typeof AppError>[0])
  return reply.value
}

export class Recorder {
  private context?: AudioContext
  private stream?: MediaStream
  private worklet?: AudioWorkletNode
  private id?: string
  private sequence = 0
  private queue: Promise<void> = Promise.resolve()
  private pending = 0
  private finishing?: Promise<void>
  private failure?: string
  private flushed?: () => void
  constructor(private level: (peak: number) => void, private changed: (duration?: number) => void, private failed: (error: unknown) => void) {}
  async start(microphone: string) {
    this.sequence = 0; this.pending = 0; this.failure = undefined; this.finishing = undefined; this.queue = Promise.resolve()
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(microphone ? { deviceId: { exact: microphone } } : {}), channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      this.context = new AudioContext({ sampleRate: 16000 })
      if (this.context.sampleRate !== 16000) throw new AppError("microphone")
      await this.context.audioWorklet.addModule("capture.js")
      this.worklet = new AudioWorkletNode(this.context, "durable-capture")
      const row = unwrap(await window.api.start())
      this.id = row.id
      this.worklet.port.onmessage = event => {
        if (event.data.stopped) { this.flushed?.(); return }
        if (typeof event.data.peak === "number") { this.level(event.data.peak); return }
        if (!(event.data.pcm instanceof ArrayBuffer) || this.failure) return
        const pcm = event.data.pcm as ArrayBuffer
        const sequence = this.sequence++
        this.pending++
        this.queue = this.queue.then(async () => {
          // Retrying the same sequence is idempotent if the acknowledgement was lost.
          const first = await window.api.append(row.id, sequence, pcm)
          const duration = first.ok ? first.value : unwrap(await window.api.append(row.id, sequence, pcm))
          this.changed(duration)
        }).catch(error => {
          this.failure = error instanceof AppError ? error.code : "storage"
          void this.finish(this.failure).catch(this.failed)
          this.failed(error)
        }).finally(() => { this.pending-- })
        if (this.pending > 8) { this.failure = "backlog"; void this.finish("backlog").catch(this.failed) }
      }
      for (const track of this.stream.getAudioTracks()) track.onended = () => { void this.finish("disconnected").catch(this.failed) }
      this.context.createMediaStreamSource(this.stream).connect(this.worklet)
      // A zero-gain output keeps the audio graph running without microphone monitoring.
      const silent = this.context.createGain(); silent.gain.value = 0
      this.worklet.connect(silent).connect(this.context.destination)
      await this.context.resume()
      return row.id
    } catch (error) {
      await this.finish("microphone").catch(() => undefined)
      throw error instanceof AppError ? error : new AppError("microphone")
    }
  }
  finish(error?: string): Promise<void> {
    if (this.finishing) return this.finishing
    this.finishing = this.flush(error)
    return this.finishing
  }
  private async flush(error?: string) {
    if (this.worklet && this.context?.state === "running") {
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, 2000)
        this.flushed = () => { clearTimeout(timeout); resolve() }
        this.worklet?.port.postMessage("stop")
      })
    }
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop() })
    await this.context?.close().catch(() => undefined)
    this.stream = undefined; this.context = undefined; this.worklet = undefined
    await this.queue
    if (this.id) unwrap(await window.api.finish(this.id, error || this.failure))
    this.id = undefined; this.level(0); this.changed()
  }
}
