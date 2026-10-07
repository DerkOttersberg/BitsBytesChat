// Each caller waits for the snapshot containing its changes. Later changes
// share the next write without delaying callers whose snapshot is already saved.
export class BBJournalWriter {
  private pending: ReturnType<typeof Promise.withResolvers<void>>[] = []
  private running = false
  constructor(
    private snapshot: () => string,
    private write: (source: string) => Promise<void>,
  ) {}
  save() {
    const result = Promise.withResolvers<void>()
    this.pending.push(result)
    if (!this.running) {
      this.running = true
      queueMicrotask(() => {
        void this.flush()
      })
    }
    return result.promise
  }
  private async flush() {
    while (this.pending.length) {
      const batch = this.pending.splice(0)
      try {
        await this.write(this.snapshot())
        for (const result of batch) result.resolve()
      } catch (error) {
        for (const result of batch) result.reject(error)
      }
    }
    this.running = false
  }
}
