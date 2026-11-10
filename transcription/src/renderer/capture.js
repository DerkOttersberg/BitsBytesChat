class DurableCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.samples = new Int16Array(sampleRate)
    this.used = 0
    this.stopped = false
    this.energy = 0
    this.count = 0
    this.port.onmessage = event => {
      if (event.data === "stop") {
        this.stopped = true
        this.flush()
        this.port.postMessage({ stopped: true })
      }
    }
  }
  flush() {
    if (!this.used) return
    const pcm = this.samples.slice(0, this.used).buffer
    this.port.postMessage({ pcm }, [pcm])
    this.used = 0
  }
  process(inputs) {
    if (this.stopped) return false
    const input = inputs[0]?.[0]
    if (!input) return true
    for (const value of input) {
      const sample = Math.max(-1, Math.min(1, value))
      this.energy += sample * sample
      this.count++
      this.samples[this.used++] = Math.round(sample * (sample < 0 ? 32768 : 32767))
      if (this.used === this.samples.length) this.flush()
    }
    if (this.count >= 1024) {
      this.port.postMessage({ peak: Math.sqrt(this.energy / this.count) })
      this.energy = 0; this.count = 0
    }
    return true
  }
}
registerProcessor("durable-capture", DurableCapture)
