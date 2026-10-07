import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { proposedPlan } from "@opencode-ai/core/util/proposed-plan"
import { ascending } from "@opencode-ai/core/id/id"

export type RunPrompt = {
  sessionID: string; directory: string; id: string; text: string; agent?: string
  model?: { providerID: string; modelID: string }; variant?: string
  legacyParts?: unknown[]; files?: { uri: string; name?: string }[]; agents?: { name: string }[]
  draft?: unknown; protocol?: "v1" | "v2"; mode?: "normal" | "plan"; goal?: boolean; delivery?: "queue" | "steer"; prepared?: boolean; turnID?: string
}
export type QueuedInput = { id: string; prompt: RunPrompt; status: "pending" | "sending" | "uncertain" | "failed"; sentAt?: number; error?: string; editing?: boolean; delivery: "queue" | "steer" }
export type Goal = { id: string; objective: string; status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete"; reason: string; evidence: string; started: number; elapsed: number; tokens: number; budget?: number; lastTurn?: string; firstID?: string; continuations: number; baseline?: number; progress?: string }
export type Plan = { id: string; revision: number; text: string; versions: { revision: number; text: string }[] }
export type ChatRun = { sessionID: string; mode: "normal" | "plan"; goalDraft: boolean; replaceGoal?: boolean; paused: boolean; queue: QueuedInput[]; goal?: Goal; plan?: Plan; last?: RunPrompt; awaiting?: boolean; error: string }
export type Inspection = { busy: boolean; messages: { id: string; text: string; tokens: number; tools: number; progress?: string; assistant?: boolean; error?: string }[] }
export type InspectionOptions = { readBusyMessages?: boolean }

// The Electron engine host owns this journal, independently of renderer lifetime.
export class BBRuns {
  chats: Record<string, ChatRun> = Object.create(null)
  private saving = Promise.resolve()
  private active = new Set<string>()
  private timer?: ReturnType<typeof setInterval>
  constructor(private root: string, private inspect: (prompt: RunPrompt, options?: InspectionOptions) => Promise<Inspection>, private dispatch: (prompt: RunPrompt) => Promise<void>, private changed: (sessionID: string) => void) {}
  async start() {
    await mkdir(this.root, { recursive: true })
    const source = await readFile(join(this.root, "chat-runs.json"), "utf8").catch(() => "{}")
    try {
      const stored: unknown = JSON.parse(source)
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error("Invalid chat run journal")
      const entries = Object.entries(stored).flatMap(([id, chat]) => { const recovered = recoverChatRun(id, chat); return recovered ? [[id, recovered] as const] : [] })
      this.chats = Object.assign(Object.create(null), Object.fromEntries(entries))
      if (JSON.stringify(this.chats) !== JSON.stringify(stored)) await writeFile(join(this.root, `chat-runs-recovery-${Date.now()}-${randomBytes(6).toString("hex")}.json`), source)
    } catch {
      await writeFile(join(this.root, `chat-runs-recovery-${Date.now()}-${randomBytes(6).toString("hex")}.json`), source)
      this.chats = Object.create(null)
    }
    for (const chat of Object.values(this.chats)) {
      if (chat.queue.length) chat.paused = true
      for (const item of chat.queue) if (item.status === "sending") item.status = "uncertain"
      if (chat.goal?.status === "active") { chat.goal.status = "paused"; chat.goal.reason = "restart" }
    }
    await this.persist()
    this.timer = setInterval(() => { for (const chat of Object.values(this.chats)) if (chat.queue.length || chat.awaiting || chat.goal?.status === "active") void this.pump(chat.sessionID) }, 1000)
    this.timer.unref()
  }
  close() { if (this.timer) clearInterval(this.timer) }
  get(id: string) {
    if (!id || id.length > 512) throw new Error("bb.error.invalidRequest")
    return this.chats[id] ??= { sessionID: id, mode: "normal", goalDraft: false, paused: false, queue: [], error: "" }
  }
  private persist() {
    this.saving = this.saving.catch(() => undefined).then(async () => {
      await writeFile(join(this.root, "chat-runs.json.tmp"), JSON.stringify(this.chats))
      await rename(join(this.root, "chat-runs.json.tmp"), join(this.root, "chat-runs.json"))
    })
    return this.saving
  }
  private async save(chat: ChatRun) { await this.persist(); this.changed(chat.sessionID) }
  async call(action: string, args: Record<string, unknown>) {
    const chat = this.get(String(args.sessionID ?? (args.prompt as RunPrompt | undefined)?.sessionID ?? ""))
    if (action === "get") return chat
    if (action === "promote") {
      const source = this.get(String(args.from))
      chat.mode = source.mode; chat.goalDraft = source.goalDraft; source.goalDraft = false; source.mode = "normal"
    }
    if (action === "inherit") chat.mode = this.get(String(args.from)).mode
    if (action === "mode") {
      if (args.mode !== "normal" && args.mode !== "plan") throw new Error("bb.error.invalidRequest")
      chat.mode = args.mode
    }
    if (action === "goal-draft") { chat.goalDraft = Boolean(args.enabled); chat.replaceGoal = Boolean(args.replace) }
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
        chat.goal = { id: randomBytes(12).toString("hex"), objective: String(args.objective || args.userText || (args.prompt as RunPrompt).text).trim(), status: "active", reason: "", evidence: "", started: Date.now(), elapsed: 0, tokens: 0, budget: typeof args.budget === "number" && args.budget > 0 ? args.budget : undefined, continuations: 0, baseline, firstID: prompt.id }
        chat.goalDraft = false; chat.replaceGoal = false
        const context = `This is a saved goal: ${chat.goal.objective}. Work until complete, respecting user constraints and permissions. Use bitsbytes-local_goal_progress to report completion with actual validation evidence, or blocked with a precise reason. Do not claim completion merely because you stop working.`
        prompt.legacyParts = [...(prompt.legacyParts ?? [{ type: "text", text: prompt.text }]), { type: "text", text: context, synthetic: true }]
        prompt.text += "\n\n" + context
      }
      prompt.goal = false; prompt.prepared = true
      const editing = chat.queue.find(item => item.editing)
      if (editing) prompt.id = editing.id
      if (action === "prepare") { chat.last = prompt; await this.save(chat); return prompt }
      const existing = chat.queue.find(item => item.id === prompt.id)
      if (existing && !existing.editing) {
        if (JSON.stringify(existing.prompt) !== JSON.stringify(prompt)) throw new Error("bb.error.deliveryConflict")
        return existing
      }
      const item: QueuedInput = { id: prompt.id, prompt, status: "pending", delivery: args.delivery === "steer" ? "steer" : "queue" }
      if (existing) chat.queue.splice(chat.queue.indexOf(existing), 1, item)
      else chat.queue.push(item)
      await this.save(chat); void this.pump(chat.sessionID); return item
    }
    const item = chat.queue.find(item => item.id === args.id)
    if (["delete", "edit", "cancel-edit", "steer", "retry"].includes(action)) {
      if (!item || item.status === "sending") throw new Error("bb.error.deliveryConflict")
      if (action === "delete") { chat.queue = chat.queue.filter(row => row !== item); if (!chat.queue.some(row => row.error)) chat.error = "" }
      if (action === "edit") item.editing = true
      if (action === "cancel-edit") item.editing = false
      if (action === "steer" || action === "retry") { item.delivery = action === "steer" ? "steer" : item.delivery; item.status = "pending"; item.error = ""; chat.error = ""; chat.paused = false }
    }
    if (action === "reorder") {
      const ids = args.ids as string[]
      if (!Array.isArray(ids) || new Set(ids).size !== chat.queue.length || chat.queue.some(item => !ids.includes(item.id) || item.status === "sending")) throw new Error("bb.error.deliveryConflict")
      chat.queue.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
    }
    if (action === "stop") { chat.paused = true; if (chat.goal?.status === "active") { chat.goal.elapsed = Date.now() - chat.goal.started; chat.goal.status = "paused"; chat.goal.reason = "stopped" } }
    if (action === "resume") { chat.paused = false; for (const entry of chat.queue) if (entry.status === "failed") entry.status = "pending" }
    if (action === "goal-pause" && chat.goal) { chat.goal.elapsed = Date.now() - chat.goal.started; chat.goal.status = "paused" }
    if (action === "goal-resume" && chat.goal) { if (chat.goal.budget && chat.goal.tokens >= chat.goal.budget) throw new Error("bb.error.goalBudget"); chat.goal.status = "active"; chat.goal.reason = ""; chat.goal.continuations = 0; chat.paused = false }
    if (action === "goal-clear") { chat.goal = undefined; chat.goalDraft = false }
    if (action === "goal-edit" && chat.goal) { if (!String(args.objective ?? "").trim()) throw new Error("bb.error.invalidRequest"); chat.goal.objective = String(args.objective).trim(); if (typeof args.budget === "number") chat.goal.budget = args.budget > 0 ? args.budget : undefined }
    if (action === "goal-progress" && chat.goal) {
      if (args.status === "complete" && !String(args.evidence ?? "").trim()) throw new Error("bb.error.goalEvidence")
      if (args.status === "complete" || args.status === "blocked") chat.goal.status = args.status
      chat.goal.reason = String(args.reason ?? ""); chat.goal.evidence = String(args.evidence ?? "")
      chat.goal.elapsed = Date.now() - chat.goal.started
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
      chat.queue.push({ id: prompt.id, prompt, delivery: "queue", status: "pending" }); chat.paused = false
    }
    await this.save(chat)
    void this.pump(chat.sessionID)
    return chat
  }
  private messageID() { return ascending("message") }
  async pump(id: string) {
    if (this.active.has(id)) return
    const chat = this.get(id)
    if (chat.paused || (!chat.queue.length && !chat.awaiting && chat.goal?.status !== "active")) return
    this.active.add(id)
    try {
      const candidate = chat.queue.find(item => item.delivery === "steer" && !item.editing) ?? chat.queue[0]
      const reference = candidate?.prompt ?? chat.last
      if (!reference) return
      // Acknowledgement reconciliation and steering need current history. Idle
      // waiting needs only busy status until the engine can accept another input.
      const state = await this.inspect(reference, { readBusyMessages: Boolean(candidate && (candidate.delivery === "steer" || candidate.status !== "pending" || candidate.sentAt !== undefined)) })
      // User controls remain available while inspection waits on the engine.
      // Discard the snapshot if Stop, an edit or reordering changed its candidate.
      if (chat.paused || candidate !== (chat.queue.find(item => item.delivery === "steer" && !item.editing) ?? chat.queue[0])) return
      // Admission acknowledgements can precede projected history. Hold the next input until reconciled.
      if (candidate && state.messages.some(row => row.id === candidate.id)) { chat.queue = chat.queue.filter(row => row !== candidate); chat.error = ""; await this.save(chat); return }
      if (candidate?.status === "sending" && !state.busy && Date.now() - (candidate.sentAt ?? Date.now()) > 30000) {
        candidate.status = "uncertain"; candidate.error = "bb.error.deliveryUnknown"
        chat.awaiting = false; chat.error = candidate.error
        await this.save(chat); return
      }
      if (state.busy && candidate?.delivery !== "steer") return
      const last = state.messages.findLast(row => row.assistant)
      if (!state.busy && chat.awaiting && last && last.id > reference.id) { chat.awaiting = false; await this.save(chat) }
      const proposed = last && reference.mode === "plan" ? proposedPlan(last.text) : undefined
      if (!state.busy && proposed?.complete && proposed.plan.trim() && chat.plan?.text !== proposed.plan.trim()) await this.call("plan", { sessionID: id, text: proposed.plan })
      if (!state.busy && chat.goal && last && last.id > (chat.goal.firstID ?? "") && chat.goal.lastTurn !== last.id) {
        const goal = chat.goal
        goal.lastTurn = last.id; goal.tokens = Math.max(0, state.messages.reduce((sum, row) => sum + row.tokens, 0) - (goal.baseline ?? 0)); goal.elapsed = Date.now() - goal.started
        const turn = state.messages.slice(state.messages.findIndex(row => row.id === reference.id) + 1).filter(row => row.assistant)
        const progress = turn.flatMap(row => row.progress ? [row.progress] : []).join(":")
        if (goal.status === "active") {
          if (last.error) { goal.status = /429|quota|limit/i.test(last.error) ? "usageLimited" : "blocked"; goal.reason = last.error }
          if (goal.budget && goal.tokens >= goal.budget) { goal.status = "budgetLimited"; goal.reason = "budget" }
          if (goal.continuations > 0 && (turn.every(row => row.tools === 0) || (progress && goal.progress === progress))) { goal.status = "blocked"; goal.reason = "no-progress" }
        }
        goal.progress = progress
        await this.save(chat)
      }
      if (!candidate) {
        if (state.busy || chat.mode === "plan" || chat.goal?.status !== "active" || !last || last.id < reference.id) return
        const goal = chat.goal
        goal.continuations++
        const prompt: RunPrompt = { ...reference, id: this.messageID(), mode: "normal", goal: false, agent: "build", text: `Continue the saved goal: ${goal.objective}\nInspect actual progress and finish the required work. Call goal_progress with status complete and concrete verification evidence when achieved, or blocked with the specific missing input. Do not keep generating status-only responses. Preserve user constraints and current permissions.`, legacyParts: undefined, files: undefined, agents: undefined, draft: undefined }
        prompt.legacyParts = [{ type: "text", text: prompt.text, synthetic: true }]
        chat.queue.push({ id: prompt.id, prompt, status: "pending", delivery: "queue" })
        await this.save(chat)
        return
      }
      if (candidate.editing || ["failed", "uncertain", "sending"].includes(candidate.status)) return
      candidate.status = "sending"; candidate.sentAt = Date.now(); chat.last = candidate.prompt; chat.awaiting = true; chat.error = ""; candidate.prompt.delivery = candidate.delivery
      await this.save(chat)
      if (chat.paused) {
        candidate.status = "pending"; candidate.sentAt = undefined; chat.awaiting = false
        await this.save(chat); return
      }
      await this.dispatch(candidate.prompt)
      // Keep the durable row until the engine exposes its stable message ID.
      await this.save(chat)
    } catch (error) {
      const item = chat.queue.find(row => row.status === "sending")
      if (item) { item.status = "uncertain"; item.error = String(error); chat.awaiting = false }
      chat.error = String(error)
      if (chat.goal?.status === "active" && /429|quota|rate.?limit/i.test(chat.error)) { chat.goal.status = "usageLimited"; chat.goal.reason = chat.error }
      await this.save(chat)
    } finally { this.active.delete(id) }
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
  const plan = chat.plan && typeof chat.plan.text === "string" && Array.isArray(chat.plan.versions)
    && chat.plan.versions.every(version => version && Number.isInteger(version.revision) && typeof version.text === "string") ? chat.plan : undefined
  const goal = chat.goal && typeof chat.goal.objective === "string"
    && ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(chat.goal.status) ? chat.goal : undefined
  return { ...chat, queue, plan, goal }
}
