export type QuestionActivity = "foreground" | "background" | "conversation" | "snooze"

export class QuestionClock {
  phase: "inactivity" | "countdown" | "snoozed" | "disabled"
  expiresAt: number | undefined
  foreground = false
  private snoozed = false
  constructor(
    readonly blocking: boolean,
    private enabled = true,
    now = Date.now(),
  ) {
    this.phase = blocking || !enabled ? "disabled" : "countdown"
    this.expiresAt = this.phase === "countdown" ? now + 90000 : undefined
  }
  activity(kind: QuestionActivity, enabled = this.enabled, now = Date.now()) {
    const changed = enabled !== this.enabled
    this.enabled = enabled
    if (kind === "snooze") this.snoozed = true
    if (kind === "foreground") this.foreground = true
    if (kind === "background") this.foreground = false
    if (this.blocking || !enabled) {
      this.phase = "disabled"
      this.expiresAt = undefined
      return
    }
    if (this.snoozed) {
      this.phase = "snoozed"
      this.expiresAt = undefined
      return
    }
    if (kind === "conversation" && !this.foreground && !changed) return
    this.phase = this.foreground ? "inactivity" : "countdown"
    this.expiresAt = now + (this.foreground ? 60000 : 90000)
  }
  tick(now = Date.now()) {
    if (this.expiresAt === undefined || now < this.expiresAt) return false
    if (this.phase === "inactivity") {
      this.phase = "countdown"
      this.expiresAt += 90000
    }
    return this.phase === "countdown" && now >= this.expiresAt!
  }
  snapshot() {
    return { phase: this.phase, expiresAt: this.expiresAt }
  }
}
