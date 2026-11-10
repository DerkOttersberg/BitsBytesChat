// A short, real microphone history. Silence remains dots; no simulated activity.
export class Waveform {
  private samples = Array<number>(26).fill(0)
  private canvas?: HTMLCanvasElement
  reset() { this.samples.fill(0); this.draw() }
  update(peak: number) {
    this.samples.push(Number.isFinite(peak) ? Math.min(1, Math.sqrt(Math.max(0, peak - 0.006) / 0.18)) : 0)
    this.samples.shift()
    this.draw()
  }
  attach(canvas: HTMLCanvasElement) { this.canvas = canvas; this.draw() }
  private draw() {
    const canvas = this.canvas
    const context = canvas?.getContext("2d")
    if (!canvas || !context) return
    const ratio = window.devicePixelRatio || 1
    const width = 116; const height = 28
    if (canvas.width !== width * ratio) { canvas.width = width * ratio; canvas.height = height * ratio }
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    for (const [index, value] of this.samples.entries()) {
      const edge = Math.min(1, (index + 2) / 7, (this.samples.length - index + 1) / 7)
      const size = Math.max(3, value * 23 * edge)
      context.fillStyle = `rgba(255,249,235,${0.35 + edge * 0.55})`
      context.beginPath(); context.roundRect(index * 4.4, (height - size) / 2, 2.6, size, 1.3); context.fill()
    }
  }
}
