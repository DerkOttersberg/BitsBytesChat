import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { proposedPlan } from "@opencode-ai/core/util/proposed-plan"
import { ascending } from "@opencode-ai/core/id/id"
import { BBJournalWriter } from "./bitsbytes-journal"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

export type RunPrompt = {
  sessionID: string; directory: string; id: string; text: string; agent?: string
  model?: { providerID: string; modelID: string }; variant?: string
  legacyParts?: unknown[]; files?: { uri: string; name?: string }[]; agents?: { name: string }[]
  draft?: unknown; protocol?: "v1" | "v2"; mode?: "normal" | "plan"; goal?: boolean; delivery?: "queue" | "steer"; prepared?: boolean; turnID?: string; resume?: boolean; revision?: number; diagnosticPrepared?: boolean
}
export type QueuedInput = { id: string; prompt: RunPrompt; status: "pending" | "sending" | "uncertain" | "failed"; sentAt?: number; error?: string; editing?: boolean; editingSince?: number; delivery: "queue" | "steer"; dismissGoalID?: string; presentation?: "transcript" | "queue" }
export type Goal = { id: string; objective: string; status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete"; reason: string; evidence: string; started: number; elapsed: number; tokens: number; budget?: number; lastTurn?: string; firstID?: string; continuations: number; baseline?: number; progress?: string; summaryDismissed?: boolean; pendingInputIDs?: string[]; stoppedInputs?: { id: string; before: number }[]; minActiveDurationMs?: number; activeTimeMs?: number; activeSince?: number; stagnantCount?: number; updatedAt?: number }
export type Plan = { id: string; revision: number; text: string; versions: { revision: number; text: string }[] }
export type ChatRun = { sessionID: string; mode: "normal" | "plan"; goalDraft: boolean; goalDraftDurationMs?: number; replaceGoal?: boolean; paused: boolean; pauseReason?: "user-stop" | "recovery" | "storage"; revision?: number; queue: QueuedInput[]; goal?: Goal; plan?: Plan; last?: RunPrompt; awaiting?: boolean; awaitingInputIDs?: string[]; resumeRequested?: boolean; error: string }
export type ChatRunPanel = Pick<ChatRun, "goal" | "plan">
export type Inspection = { busy: boolean; waiting?: boolean; messages: { id: string; text: string; tokens: number; tools: number; progress?: string; assistant?: boolean; error?: string; parentID?: string; created?: number; aborted?: boolean; receipt?: SessionV1.ExecutionReceipt }[] }
export type InspectionOptions = { readBusyMessages?: boolean; readWaitingState?: boolean }
export type DispatchResult = void | "not-sent"

// Only the admission boundary can prove a prompt was not posted. Other
// failures stay uncertain so reconciliation can find a late acknowledgement.
export class UnsentError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
  }
}

// The Electron engine host owns this journal, independently of renderer lifetime.
export class BBRuns {
  chats: Record<string, ChatRun> = Object.create(null)
  private journal = new BBJournalWriter(() => JSON.stringify(this.chats), async source => {
    await writeFile(join(this.root, "chat-runs.json.tmp"), source)
    await rename(join(this.root, "chat-runs.json.tmp"), join(this.root, "chat-runs.json"))
  })
  private active = new Set<string>()
  private pumping = new Map<string, { revision: number | undefined; done: PromiseWithResolvers<void> }>()
  private checkpoints = new Map<string, number>()
  private goalTicks = new Map<string, number>()
  private admissions = new Map<string, AbortController>()
  private timer?: ReturnType<typeof setInterval>
  private stopping = new Map<string, Promise<void>>()
  constructor(private root: string, private inspect: (prompt: RunPrompt, options?: InspectionOptions) => Promise<Inspection>, private dispatch: (prompt: RunPrompt, signal?: AbortSignal) => Promise<DispatchResult>, private changed: (sessionID: string) => void, private interrupt?: (prompt: RunPrompt) => Promise<void>, private now = () => Date.now(), private monotonic = () => performance.now()) {}
  async start() {
    await mkdir(this.root, { recursive: true })
    const source = await readFile(join(this.root, "chat-runs.json"), "utf8").catch(error => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "{}"
      throw error
    })
    let stored: unknown
    try { stored = JSON.parse(source) } catch {}
    const entries = stored && typeof stored === "object" && !Array.isArray(stored)
      ? Object.entries(stored).flatMap(([id, chat]) => { const recovered = recoverChatRun(id, chat); return recovered ? [[id, recovered] as const] : [] })
      : []
    const recovered = Object.assign(Object.create(null), Object.fromEntries(entries))
    if (JSON.stringify(recovered) !== JSON.stringify(stored)) await writeFile(join(this.root, `chat-runs-recovery-${Date.now()}-${randomBytes(6).toString("hex")}.json`), source)
    this.chats = recovered
    for (const chat of Object.values(this.chats)) {
      chat.resumeRequested = false
      if (chat.queue.length || chat.awaiting) { chat.paused = true; chat.pauseReason = "recovery" }
      for (const item of chat.queue) if (item.status === "sending") item.status = "uncertain"
      if (chat.goal) { chat.goal.activeSince = undefined; if (chat.goal.status === "active") { chat.goal.status = "paused"; chat.goal.reason = "restart" } }
    }
    await this.persist().catch(error => {
      for (const chat of Object.values(this.chats)) this.storageFailure(chat, error)
    })
    this.timer = setInterval(() => { for (const chat of Object.values(this.chats)) if (chat.queue.length || chat.awaiting || chat.goal?.status === "active") void this.pump(chat.sessionID) }, 1000)
    this.timer.unref()
  }
  close() { if (this.timer) clearInterval(this.timer) }
  get(id: string) {
    if (!id || id.length > 512) throw new Error("bb.error.invalidRequest")
    return this.chats[id] ??= { sessionID: id, mode: "normal", goalDraft: false, paused: false, queue: [], error: "" }
  }
  private persist() {
    return this.journal.save()
  }
  private async save(chat: ChatRun) {
    await this.persist().catch(error => { this.storageFailure(chat, error); throw error })
    this.changed(chat.sessionID)
  }
  async call(action: string, args: Record<string, unknown>) {
    const chat = this.get(String(args.sessionID ?? (args.prompt as RunPrompt | undefined)?.sessionID ?? ""))
    if (action === "get") return chat
    if (action === "panel") return { goal: chat.goal, plan: chat.plan } satisfies ChatRunPanel
    chat.revision = (chat.revision ?? 0) + 1
    const revision = chat.revision
    if (action === "goal-progress" && !chat.goal) throw new Error("bb.error.deliveryConflict")
    if (action === "promote") {
      const source = this.get(String(args.from))
      chat.mode = source.mode; chat.goalDraft = source.goalDraft; source.goalDraft = false; source.mode = "normal"
    }
    if (action === "inherit") chat.mode = this.get(String(args.from)).mode
    if (action === "mode") {
      if (args.mode !== "normal" && args.mode !== "plan") throw new Error("bb.error.invalidRequest")
      chat.mode = args.mode
    }
    if (action === "goal-draft") { chat.goalDraft = Boolean(args.enabled); if (args.replace !== undefined) chat.replaceGoal = Boolean(args.replace); if (args.minActiveDurationMs !== undefined) { if (!Number.isSafeInteger(args.minActiveDurationMs) || Number(args.minActiveDurationMs) < 0) throw new Error("bb.error.invalidRequest"); chat.goalDraftDurationMs = Number(args.minActiveDurationMs) } }
    if (action === "prepare" || action === "admit") {
      const prompt = structuredClone(args.prompt) as RunPrompt
      if (!prompt?.id || prompt.sessionID !== chat.sessionID || !prompt.directory || typeof prompt.text !== "string") throw new Error("bb.error.invalidRequest")
      prompt.mode ??= chat.mode
      if (prompt.mode === "plan" && !prompt.prepared) {
        prompt.agent = "plan"
        const context = "Plan mode: inspect and clarify before proposing a decision-complete plan. Do not execute changes. Ask short structured questions when needed. Finish with <proposed_plan>Markdown plan</proposed_plan>."
        prompt.legacyParts = [...(prompt.legacyParts ?? [{ type: "text", text: prompt.text }]), { type: "text", text: context, synthetic: true }]
        prompt.text = context + "\n\n" + prompt.text
      }
      if (chat.goalDraft || prompt.goal) {
        if (chat.goal && chat.goal.status !== "complete" && !args.replace && !chat.replaceGoal) throw new Error("bb.error.goalExists")
        const baseline = (await this.inspect(prompt)).messages.reduce((sum, row) => sum + row.tokens, 0)
        if (chat.revision !== revision) throw new Error("bb.error.deliveryConflict")
        const duration = Number(args.minActiveDurationMs ?? chat.goalDraftDurationMs ?? 0)
        if (!Number.isSafeInteger(duration) || duration < 0) throw new Error("bb.error.invalidRequest")
        if (chat.goal) this.clockGoal(chat.goal, false)
        chat.goal = { id: randomBytes(12).toString("hex"), objective: String(args.objective || args.userText || (args.prompt as RunPrompt).text).trim(), status: "active", reason: "", evidence: "", started: this.now(), elapsed: 0, activeTimeMs: 0, minActiveDurationMs: duration, tokens: 0, budget: typeof args.budget === "number" && args.budget > 0 ? args.budget : undefined, continuations: 0, baseline, firstID: prompt.id, updatedAt: this.now() }
        chat.goalDraft = false; chat.replaceGoal = false
        const context = `This is a saved goal (ID ${chat.goal.id}): ${chat.goal.objective}. Work until complete, respecting user constraints and permissions. Minimum active work: ${duration} ms; waiting for the user and paused time do not count. Use bitsbytes-local_goal_progress with this goal ID to report completion with actual validation evidence, or blocked with a precise reason. Do not generate filler work to satisfy the duration. If meaningful work is complete early, explain the remaining duration and ask the user to revise it. Do not claim completion merely because you stop working.`
        prompt.legacyParts = [...(prompt.legacyParts ?? [{ type: "text", text: prompt.text }]), { type: "text", text: context, synthetic: true }]
        prompt.text += "\n\n" + context
      }
      prompt.goal = false; prompt.prepared = true
      const editing = chat.queue.find(item => item.editing)
      if (editing) { prompt.id = editing.id; prompt.revision = (editing.prompt.revision ?? 1) + 1 }
      if (action === "prepare") { chat.last = prompt; await this.save(chat); return prompt }
      const existing = chat.queue.find(item => item.id === prompt.id)
      if (existing && !existing.editing) {
        if (JSON.stringify(existing.prompt) !== JSON.stringify(prompt)) throw new Error("bb.error.deliveryConflict")
        await this.save(chat); void this.pump(chat.sessionID)
        return existing
      }
      const item: QueuedInput = { id: prompt.id, prompt, status: "pending", delivery: args.delivery === "steer" ? "steer" : "queue", dismissGoalID: chat.goal?.status === "complete" ? chat.goal.id : undefined }
      if (chat.paused && chat.pauseReason === "user-stop") { chat.paused = false; chat.pauseReason = undefined }
      // Renderer busy events can lag the completed/Stop boundary. Reconcile
      // attempted admission before deciding whether a first new input is queued.
      const boundary = !chat.paused && !chat.awaiting && (args.immediate === false || chat.queue.some(row => row.sentAt !== undefined))
        ? await this.inspect(prompt, { readBusyMessages: chat.queue.some(row => row.sentAt !== undefined), readWaitingState: false }).catch(() => undefined)
        : undefined
      if (chat.revision !== revision) throw new Error("bb.error.deliveryConflict")
      if (boundary) {
        const admitted = new Set(boundary.messages.filter(row => row.receipt?.stage !== "preparing").map(row => row.id))
        chat.queue = chat.queue.filter(row => row === existing || row.sentAt === undefined || !admitted.has(row.id))
      }
      item.presentation = (args.immediate === true || boundary?.busy === false) && !chat.paused && !chat.queue.some(row => row !== existing && !row.editing) ? "transcript" : "queue"
      if (existing) chat.queue.splice(chat.queue.indexOf(existing), 1, item)
      else chat.queue.push(item)
      await this.save(chat); void this.pump(chat.sessionID); return item
    }
    const item = chat.queue.find(item => item.id === args.id)
    if (["delete", "edit", "cancel-edit", "steer", "retry"].includes(action)) {
      if (!item || item.status === "sending" || ((item.sentAt !== undefined || item.status === "uncertain") && ["delete", "edit"].includes(action))) throw new Error("bb.error.deliveryConflict")
      if (action === "delete") { this.forgetUnsent(chat, item.id); chat.queue = chat.queue.filter(row => row !== item); if (!chat.queue.some(row => row.error)) chat.error = "" }
      if (action === "edit") { for (const entry of chat.queue) if (entry.editing) { entry.editing = false; entry.editingSince = undefined }; item.editing = true; item.editingSince = this.now() }
      if (action === "cancel-edit") { item.editing = false; item.editingSince = undefined }
      if (action === "steer" || action === "retry") { item.delivery = action === "steer" ? "steer" : item.delivery; item.status = "pending"; item.error = ""; chat.error = ""; chat.paused = false; chat.pauseReason = undefined }
    }
    if (action === "reorder") {
      const ids = args.ids as string[]
      if (!Array.isArray(ids) || new Set(ids).size !== chat.queue.length || chat.queue.some(item => !ids.includes(item.id) || item.status === "sending")) throw new Error("bb.error.deliveryConflict")
      chat.queue.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
    }
    if (action === "stop") {
      if (chat.goal && chat.goal.status !== "complete") {
        const goal = chat.goal
        const before = Date.now()
        // Steer may replace chat.last while the original provider turn is still
        // running. Retain ownership of every admitted input until its boundary.
        const ids = new Set([...(goal.pendingInputIDs ?? []), ...(chat.awaiting && chat.last?.protocol !== "v2" && chat.last ? [chat.last.id] : [])])
        if (ids.size) goal.stoppedInputs = [...(goal.stoppedInputs ?? []).filter(row => !ids.has(row.id)), ...[...ids].map(id => ({ id, before }))]
        if (goal.status === "active") { this.clockGoal(goal, false); goal.status = "paused"; goal.reason = "stopped" }
      }
      chat.paused = true; chat.pauseReason = "user-stop"; chat.awaiting = false; chat.resumeRequested = false; this.admissions.get(chat.sessionID)?.abort()
      if (chat.last && this.interrupt) {
        const prompt = chat.last
        const stopped = this.save(chat).then(() => this.interrupt!(prompt))
        this.stopping.set(chat.sessionID, stopped)
        try { await stopped } finally { if (this.stopping.get(chat.sessionID) === stopped) this.stopping.delete(chat.sessionID); void this.pump(chat.sessionID) }
      }
      else await this.save(chat)
      return { ...chat, interruptionOwned: Boolean(chat.last && this.interrupt) }
    }
    if (action === "resume") { chat.paused = false; chat.pauseReason = undefined; chat.resumeRequested = true; for (const entry of chat.queue) if (entry.status === "failed") entry.status = "pending" }
    if (action === "goal-pause" && chat.goal) { this.clockGoal(chat.goal, false); chat.goal.status = "paused" }
    if (action === "goal-resume" && chat.goal) { if (chat.goal.budget && chat.goal.tokens >= chat.goal.budget) throw new Error("bb.error.goalBudget"); this.clockGoal(chat.goal, false); chat.goal.status = "active"; chat.goal.reason = ""; chat.goal.continuations = 0; chat.goal.stagnantCount = 0; chat.paused = false; chat.pauseReason = undefined; chat.resumeRequested = true }
    if (action === "goal-clear") { if (chat.goal) this.clockGoal(chat.goal, false); chat.goal = undefined; chat.goalDraft = false }
    if (action === "goal-edit") {
      if (!chat.goal || args.goalID !== undefined && args.goalID !== chat.goal.id) throw new Error("bb.error.deliveryConflict")
      if (!String(args.objective ?? "").trim() || args.budget !== undefined && (!Number.isSafeInteger(args.budget) || Number(args.budget) < 0) || args.minActiveDurationMs !== undefined && (!Number.isSafeInteger(args.minActiveDurationMs) || Number(args.minActiveDurationMs) < 0)) throw new Error("bb.error.invalidRequest")
      chat.goal.objective = String(args.objective).trim()
      if (typeof args.budget === "number") chat.goal.budget = args.budget > 0 ? args.budget : undefined
      if (args.minActiveDurationMs !== undefined) chat.goal.minActiveDurationMs = Number(args.minActiveDurationMs)
      chat.goal.updatedAt = this.now()
    }
    if (action === "goal-progress" && chat.goal) {
      if (args.goalID !== chat.goal.id) throw new Error("bb.error.deliveryConflict")
      if (args.status === "complete" && !String(args.evidence ?? "").trim()) throw new Error("bb.error.goalEvidence")
      this.clockGoal(chat.goal, chat.goal.status === "active" && chat.goal.activeSince !== undefined)
      const remainingMs = Math.max(0, (chat.goal.minActiveDurationMs ?? 0) - (chat.goal.activeTimeMs ?? 0))
      if (args.status === "complete" && remainingMs > 0) { await this.save(chat); return { completionDenied: true, remainingMs, goal: chat.goal } }
      if (args.status === "complete" || args.status === "blocked") chat.goal.status = args.status
      chat.goal.reason = String(args.reason ?? ""); chat.goal.evidence = String(args.evidence ?? "")
      this.clockGoal(chat.goal, false)
    }
    if (action === "plan") {
      const text = String(args.text ?? "").trim()
      if (!text) throw new Error("bb.error.invalidRequest")
      if (chat.plan?.text !== text) {
        const revision = (chat.plan?.revision ?? 0) + 1
        chat.plan = { id: chat.plan?.id ?? randomBytes(12).toString("hex"), revision, text, versions: [...(chat.plan?.versions ?? []), { revision, text }] }
      }
    }
    if (action === "implement") {
      const version = chat.plan?.versions.find(row => row.revision === Number(args.revision ?? chat.plan?.revision))
      if (!version || !chat.last) throw new Error("bb.error.invalidRequest")
      chat.mode = "normal"
      const prompt = { ...chat.last, mode: "normal" as const, agent: "build", id: this.messageID(), text: "PLEASE IMPLEMENT THIS PLAN:\n" + version.text, legacyParts: [{ type: "text", text: `Implement approved plan · revision ${version.revision}` }, { type: "text", text: "PLEASE IMPLEMENT THIS PLAN:\n" + version.text, synthetic: true }], files: undefined, agents: undefined, draft: undefined }
      chat.queue.push({ id: prompt.id, prompt, delivery: "queue", status: "pending", dismissGoalID: chat.goal?.status === "complete" ? chat.goal.id : undefined }); chat.paused = false
    }
    await this.save(chat)
    void this.pump(chat.sessionID)
    return chat
  }
  private messageID() { return ascending("message") }
  async pump(id: string) {
    const pending = this.pumping.get(id)
    if (pending) { await pending.done.promise; if (this.get(id).revision !== pending.revision) await this.pump(id); return }
    const chat = this.get(id)
    if (chat.paused || this.stopping.has(id) || (!chat.queue.length && !chat.awaiting && !chat.resumeRequested && chat.goal?.status !== "active")) return
    this.active.add(id)
    const revision = chat.revision
    const done = Promise.withResolvers<void>()
    this.pumping.set(id, { revision, done })
    let priorSentAt: number | undefined
    let attempt: QueuedInput | undefined
    let dispatchStarted = false
    try {
      const candidate = chat.queue.find(item => item.delivery === "steer" && !item.editing) ?? chat.queue[0]
      const reference = candidate?.prompt ?? chat.last
      if (!reference) return
      if (candidate?.status === "failed" && candidate.sentAt === undefined) return
      // Acknowledgement reconciliation and steering need current history. Idle
      // waiting needs only busy status until the engine can accept another input.
      const state = await this.inspect(reference, { readBusyMessages: Boolean(chat.resumeRequested || candidate && (candidate.delivery === "steer" || candidate.status !== "pending" || candidate.sentAt !== undefined)), readWaitingState: chat.goal?.status === "active" })
      // User controls remain available while inspection waits on the engine.
      // Discard the snapshot if Stop, an edit or reordering changed its candidate.
      if (chat.paused || chat.revision !== revision || candidate !== (chat.queue.find(item => item.delivery === "steer" && !item.editing) ?? chat.queue[0])) return
      if (chat.goal?.status === "active") {
        const checkpoint = chat.goal.activeSince
        this.clockGoal(chat.goal, state.busy && !state.waiting && Boolean(chat.goal.pendingInputIDs?.length))
        if ((checkpoint === undefined) !== (chat.goal.activeSince === undefined) || checkpoint !== undefined && this.now() - (this.checkpoints.get(chat.goal.id) ?? 0) >= 10000) { this.checkpoints.set(chat.goal.id, this.now()); await this.save(chat) }
      }
      const receipts = new Map(state.messages.flatMap(row => row.receipt ? [[row.id, row.receipt] as const] : []))
      if (chat.awaiting && chat.awaitingInputIDs?.length && chat.awaitingInputIDs.every(id => {
        const receipt = receipts.get(id)
        return receipt && ["completed", "interrupted", "failed"].includes(receipt.stage)
      })) { chat.awaiting = false; chat.awaitingInputIDs = []; await this.save(chat) }
      // Admission acknowledgements can precede projected history. Hold the next input until reconciled.
      if (candidate && state.messages.some(row => row.id === candidate.id && row.receipt?.stage !== "preparing")) { this.dismissGoal(chat, candidate); chat.queue = chat.queue.filter(row => row !== candidate); chat.error = ""; await this.save(chat); return }
      if (chat.resumeRequested && !state.busy && !state.waiting) {
        chat.resumeRequested = false
        const receipt = receipts.get(reference.id)
        if (reference.protocol === "v2" || receipt && ["interrupted", "failed", "admitted", "preparing"].includes(receipt.stage)) {
          chat.awaiting = true; chat.awaitingInputIDs = [...new Set([...(chat.awaitingInputIDs ?? []), reference.id])]
          await this.save(chat)
          await this.dispatch({ ...reference, resume: true })
          return
        }
        await this.save(chat)
      }
      if (candidate?.status === "sending" && !state.busy && Date.now() - (candidate.sentAt ?? Date.now()) > 30000) {
        candidate.status = "uncertain"; candidate.error = "bb.error.deliveryUnknown"
        chat.awaiting = false; chat.error = candidate.error
        await this.save(chat); return
      }
      if (state.busy && candidate?.delivery !== "steer") {
        if (candidate?.status === "pending" && candidate.presentation === "transcript") { candidate.presentation = "queue"; await this.save(chat) }
        return
      }
      const last = state.messages.findLast(row => row.assistant)
      const projected = state.messages.findIndex(row => row.id === reference.id)
      const completedBoundary = last && (last.parentID === reference.id || reference.protocol === "v2" && projected >= 0 && state.messages.indexOf(last) > projected)
      if (!state.busy && chat.awaiting && !receipts.has(reference.id) && completedBoundary) { chat.awaiting = false; chat.awaitingInputIDs = []; await this.save(chat) }
      const proposed = last && reference.mode === "plan" ? proposedPlan(last.text) : undefined
      if (!state.busy && proposed?.complete && proposed.plan.trim() && chat.plan?.text !== proposed.plan.trim()) await this.call("plan", { sessionID: id, text: proposed.plan })
      if (!state.busy && chat.goal && last && last.id > (chat.goal.firstID ?? "") && chat.goal.lastTurn !== last.id) {
        const goal = chat.goal
        goal.lastTurn = last.id; goal.tokens = Math.max(0, state.messages.reduce((sum, row) => sum + row.tokens, 0) - (goal.baseline ?? 0))
        // Never guess from error text or suppress a fresh retry of the same
        // input. Equal-millisecond timestamps remain conservatively failures.
        const stopped = last.error !== undefined && last.aborted === true && last.parentID !== undefined && last.created !== undefined
          && goal.stoppedInputs?.some(row => row.id === last.parentID && last.created! < row.before)
        const parent = state.messages.findIndex(row => row.id === last.parentID)
        if (goal.pendingInputIDs && parent >= 0) {
          const completed = new Set(state.messages.slice(0, parent + 1).map(row => row.id))
          goal.pendingInputIDs = goal.pendingInputIDs.filter(id => !completed.has(id))
        }
        const turn = state.messages.slice(state.messages.findIndex(row => row.id === reference.id) + 1).filter(row => row.assistant)
        const progress = turn.flatMap(row => row.progress ? [row.progress] : []).join(":")
        if (goal.status === "active") {
          if (last.error && !stopped) { goal.status = /429|quota|limit/i.test(last.error) ? "usageLimited" : "blocked"; goal.reason = last.error }
          if (goal.budget && goal.tokens >= goal.budget) { goal.status = "budgetLimited"; goal.reason = "budget" }
          if (!last.error && !stopped && goal.status === "active" && goal.continuations > 0) {
            goal.stagnantCount = turn.every(row => row.tools === 0) || (progress && goal.progress === progress) ? (goal.stagnantCount ?? 0) + 1 : 0
            if (goal.stagnantCount >= 3) { goal.status = "blocked"; goal.reason = "no-progress"; this.clockGoal(goal, false) }
          }
        }
        if (!stopped) goal.progress = progress
        await this.save(chat)
      }
      if (!candidate) {
        if (state.busy || state.waiting || chat.awaiting || chat.mode === "plan" || chat.goal?.status !== "active" || !last || last.id < reference.id) return
        const goal = chat.goal
        goal.continuations++
        const prompt: RunPrompt = { ...reference, id: this.messageID(), mode: "normal", goal: false, agent: "build", text: `Continue the saved goal (ID ${goal.id}): ${goal.objective}\nInspect actual progress and finish the required work. Call goal_progress with this goal ID, status complete and concrete verification evidence when achieved, or blocked with the specific missing input. Minimum active work remaining: ${Math.max(0, (goal.minActiveDurationMs ?? 0) - (goal.activeTimeMs ?? 0))} ms. Do not generate filler work or status-only responses. Preserve user constraints and current permissions.`, legacyParts: undefined, files: undefined, agents: undefined, draft: undefined }
        prompt.legacyParts = [{ type: "text", text: prompt.text, synthetic: true }]
        chat.queue.push({ id: prompt.id, prompt, status: "pending", delivery: "queue" })
        await this.save(chat)
        return
      }
      if (candidate.editing || ["failed", "uncertain", "sending"].includes(candidate.status)) return
      priorSentAt = candidate.sentAt
      attempt = candidate
      candidate.status = "sending"; candidate.sentAt = Date.now(); chat.last = candidate.prompt; chat.awaiting = true; chat.error = ""; candidate.prompt.delivery = candidate.delivery
      chat.awaitingInputIDs = [...new Set([...(chat.awaitingInputIDs ?? []), candidate.id])]
      candidate.presentation = "transcript"
      if (chat.goal && chat.goal.status !== "complete") chat.goal.pendingInputIDs = [...new Set([...(chat.goal.pendingInputIDs ?? []), candidate.id])]
      await this.save(chat)
      if (chat.paused || chat.revision !== revision || this.stopping.has(id)) {
        this.unsent(chat, candidate, priorSentAt)
        await this.save(chat); return
      }
      const admission = new AbortController()
      this.admissions.set(id, admission)
      dispatchStarted = true
      if (await this.dispatch(candidate.prompt, admission.signal) === "not-sent") {
        this.unsent(chat, candidate, priorSentAt)
        await this.save(chat); return
      }
      this.dismissGoal(chat, candidate)
      if (chat.goal?.status === "active") this.clockGoal(chat.goal, true)
      // Keep the durable row until the engine exposes its stable message ID.
      await this.save(chat)
    } catch (error) {
      const failure = this.admissions.get(id)?.signal.aborted ? "bb.error.deliveryUnknown" : String(error)
      const item = chat.queue.find(row => row.status === "sending")
      if (item) {
        const unsent = error instanceof UnsentError || (item === attempt && !dispatchStarted)
        item.status = unsent && priorSentAt === undefined ? "failed" : "uncertain"
        if (unsent) item.sentAt = priorSentAt
        if (unsent && priorSentAt === undefined) this.forgetUnsent(chat, item.id)
        item.error = failure; chat.awaiting = unsent && priorSentAt === undefined && !chat.paused && Boolean(chat.awaitingInputIDs?.length)
      }
      chat.error = failure
      if (chat.goal?.status === "active" && /429|quota|rate.?limit/i.test(chat.error)) { this.clockGoal(chat.goal, false); chat.goal.status = "usageLimited"; chat.goal.reason = chat.error }
      await this.save(chat).catch(() => undefined)
    } finally { this.admissions.delete(id); this.active.delete(id); this.pumping.delete(id); done.resolve() }
  }
  private clockGoal(goal: Goal, running: boolean) {
    const now = this.now()
    const tick = this.monotonic(), previous = this.goalTicks.get(goal.id)
    // Wall-clock jumps must not satisfy a minimum work duration. The UI anchor
    // is a timestamp; only process-local monotonic intervals earn saved time.
    goal.activeTimeMs = (goal.activeTimeMs ?? goal.elapsed) + (goal.activeSince === undefined || previous === undefined ? 0 : Math.max(0, tick - previous))
    goal.elapsed = goal.activeTimeMs
    goal.activeSince = running && goal.status === "active" ? now : undefined
    if (goal.activeSince === undefined) this.goalTicks.delete(goal.id)
    else this.goalTicks.set(goal.id, tick)
  }
  private dismissGoal(chat: ChatRun, item: QueuedInput) {
    if (chat.goal?.status === "complete" && item.dismissGoalID === chat.goal.id) chat.goal.summaryDismissed = true
  }
  private storageFailure(chat: ChatRun, error: unknown) {
    // Unsaved state cannot dispatch automatically after storage recovers.
    // Preserve the previous journal; explicit mutations still reject their write.
    chat.paused = true; chat.pauseReason = "storage"; chat.awaiting = false; chat.error = String(error)
    if (chat.goal?.status === "active") {
      this.clockGoal(chat.goal, false); chat.goal.status = "paused"; chat.goal.reason = chat.error
    }
    this.changed(chat.sessionID)
  }
  private unsent(chat: ChatRun, item: QueuedInput, priorSentAt: number | undefined) {
    item.status = priorSentAt === undefined ? "pending" : "uncertain"
    item.sentAt = priorSentAt
    item.error = priorSentAt === undefined ? "" : "bb.error.deliveryUnknown"
    if (priorSentAt === undefined) this.forgetUnsent(chat, item.id)
    chat.error = item.error; chat.awaiting = priorSentAt === undefined && !chat.paused && Boolean(chat.awaitingInputIDs?.length)
  }
  private forgetUnsent(chat: ChatRun, id: string) {
    // Preparation/journal failure never admitted this input. Retire only its
    // provisional ownership; earlier admitted or uncertain work stays owned.
    chat.awaitingInputIDs = chat.awaitingInputIDs?.filter(inputID => inputID !== id)
    if (!chat.awaitingInputIDs?.length) chat.awaiting = false
    if (chat.goal?.pendingInputIDs) chat.goal.pendingInputIDs = chat.goal.pendingInputIDs.filter(inputID => inputID !== id)
  }
}

function recoverChatRun(id: string, value: unknown): ChatRun | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const chat = value as ChatRun
  if (chat.sessionID !== id || !["normal", "plan"].includes(chat.mode) || !Array.isArray(chat.queue)) return
  // Preserve valid neighbours independently. A broken optional plan or goal
  // must not erase a durable queued request, and recovery never dispatches it.
  const queue = chat.queue.filter(item => item && typeof item.id === "string" && item.id.length > 0
      && ["pending", "sending", "uncertain", "failed"].includes(item.status)
      && item.prompt?.sessionID === id && item.prompt.id === item.id
      && typeof item.prompt.text === "string" && typeof item.prompt.directory === "string")
  const editing = queue.find(item => item.editing)
  const plan = validPlan(chat.plan) ? chat.plan : undefined
  const waiting: unknown = chat.awaitingInputIDs
  const awaitingInputIDs = waiting === undefined || validInputIDs(waiting)
    ? waiting
    : [...new Set([
      ...(Array.isArray(waiting) ? waiting.filter((inputID: unknown): inputID is string => typeof inputID === "string" && inputID.length > 0 && inputID.length <= 512) : []),
      ...queue.filter(item => item.sentAt !== undefined).map(item => item.id),
      ...(chat.awaiting && typeof chat.last?.id === "string" && chat.last.id ? [chat.last.id] : []),
    ])]
  const goal = validGoal(chat.goal) ? {
    ...chat.goal,
    summaryDismissed: typeof chat.goal.summaryDismissed === "boolean" ? chat.goal.summaryDismissed : undefined,
    pendingInputIDs: validInputIDs(chat.goal.pendingInputIDs) ? chat.goal.pendingInputIDs : undefined,
    stoppedInputs: validStoppedInputs(chat.goal.stoppedInputs) ? chat.goal.stoppedInputs : undefined,
    minActiveDurationMs: chat.goal.minActiveDurationMs === undefined || Number.isSafeInteger(chat.goal.minActiveDurationMs) && chat.goal.minActiveDurationMs >= 0 ? chat.goal.minActiveDurationMs : 0,
    activeTimeMs: chat.goal.activeTimeMs === undefined || Number.isFinite(chat.goal.activeTimeMs) && chat.goal.activeTimeMs >= 0 ? chat.goal.activeTimeMs : chat.goal.elapsed,
    stagnantCount: chat.goal.stagnantCount === undefined || Number.isSafeInteger(chat.goal.stagnantCount) && chat.goal.stagnantCount >= 0 ? chat.goal.stagnantCount : 0,
    updatedAt: chat.goal.updatedAt === undefined || Number.isFinite(chat.goal.updatedAt) && chat.goal.updatedAt >= 0 ? chat.goal.updatedAt : undefined,
  } : undefined
  return { ...chat, awaitingInputIDs, revision: chat.revision === undefined || Number.isSafeInteger(chat.revision) && chat.revision >= 0 ? chat.revision : 0, goalDraftDurationMs: chat.goalDraftDurationMs === undefined || Number.isSafeInteger(chat.goalDraftDurationMs) && chat.goalDraftDurationMs >= 0 ? chat.goalDraftDurationMs : undefined, queue: queue.map(item => ({ ...item, ...(item.editing && item !== editing ? { editing: false } : {}), dismissGoalID: typeof item.dismissGoalID === "string" && item.dismissGoalID ? item.dismissGoalID : undefined })), plan, goal }
}

function validPlan(value: unknown): value is Plan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const plan = value as Plan
  return typeof plan.id === "string" && Boolean(plan.id) && typeof plan.text === "string"
    && Number.isInteger(plan.revision) && plan.revision > 0 && Array.isArray(plan.versions) && plan.versions.length > 0
    && plan.versions.every(version => version && Number.isInteger(version.revision) && version.revision > 0 && version.revision <= plan.revision && typeof version.text === "string")
    && new Set(plan.versions.map(version => version.revision)).size === plan.versions.length
    && plan.versions.some(version => version.revision === plan.revision && version.text === plan.text)
}

function validGoal(value: unknown): value is Goal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const goal = value as Goal
  return typeof goal.id === "string" && Boolean(goal.id)
    && (["objective", "reason", "evidence"] as const).every(field => typeof goal[field] === "string")
    && ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(goal.status)
    && (["started", "elapsed", "tokens", "continuations"] as const).every(field => Number.isFinite(goal[field]) && goal[field] >= 0)
    && (["budget", "baseline"] as const).every(field => goal[field] === undefined || (Number.isFinite(goal[field]) && goal[field]! >= 0))
    && (["lastTurn", "firstID", "progress"] as const).every(field => goal[field] === undefined || typeof goal[field] === "string")
}

function validInputIDs(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(id => typeof id === "string" && id.length > 0 && id.length <= 512) && new Set(value).size === value.length
}

function validStoppedInputs(value: unknown): value is NonNullable<Goal["stoppedInputs"]> {
  return Array.isArray(value) && value.every(row => row && typeof row === "object" && !Array.isArray(row)
    && typeof row.id === "string" && row.id.length > 0 && row.id.length <= 512 && Number.isFinite(row.before) && row.before >= 0)
    && new Set(value.map(row => row.id)).size === value.length
}
