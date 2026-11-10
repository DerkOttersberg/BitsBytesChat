class DurableCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.samples = new Int16Array(sampleRate)
    this.used = 0
    this.stopped = false
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
    let peak = 0
    for (const value of input) {
      const sample = Math.max(-1, Math.min(1, value))
      peak = Math.max(peak, Math.abs(sample))
      this.samples[this.used++] = Math.round(sample * (sample < 0 ? 32768 : 32767))
      if (this.used === this.samples.length) this.flush()
    }
    if (currentFrame % 1024 === 0) this.port.postMessage({ peak })
    return true
  }
}
registerProcessor("durable-capture", DurableCapture)
