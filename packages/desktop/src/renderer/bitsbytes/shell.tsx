import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { ParentProps } from "solid-js"
import type { Job, Settings, Skill, State } from "../../bitsbytes/types"
import { bbt, bbError } from "../../bitsbytes/copy"
import { Icon } from "@opencode-ai/ui/icon"
import "./style.css"

const freshSkill = (): Skill => ({ id: "", name: "", instructions: "", defaultPrompt: "", template: "", output: "", enabled: false, revision: 0, versions: [], files: [] })
const time = (seconds: number) => `${Math.floor(seconds / 3600).toString().padStart(2, "0")}:${Math.floor(seconds / 60 % 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`

export function BitsBytesShell(props: ParentProps<{ audio: { insert: (job: Job) => void } }>) {
  const api = window.api.bitsbytes
  const [state, setState] = createSignal<State>()
  const [tab, setTab] = createSignal<"chats" | "skills" | "recordings" | "settings">("chats")
  const [busy, setBusy] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const [error, setError] = createSignal("")
  const [editor, setEditor] = createSignal(freshSkill())
  const [description, setDescription] = createSignal("")
  const [testInput, setTestInput] = createSignal("")
  const [testOutput, setTestOutput] = createSignal("")
  const [transcript, setTranscript] = createSignal<Job>()
  const active = createMemo(() => state()?.jobs.find((job) => job.recording))
  const updateEditor = (value: Partial<Skill>) => setEditor({ ...editor(), ...value })

  async function refresh() {
    const next = await api.call<State>("state")
    setState(next)
  }
  function navigate(result: unknown) {
    if (!result || typeof result !== "object" || !("sessionID" in result) || !("directory" in result)) return
    setTab("chats")
    window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail: result }))
  }
  async function run(method: string, args: Record<string, unknown> = {}) {
    setBusy(method); setError(""); setNotice("")
    try {
      const result = await api.call(method, args)
      navigate(result)
      await refresh()
      if (["audio.import", "transcribe"].includes(method) && result && typeof result === "object" && "transcript" in result) addTranscript(result as Job)
      if (method === "share.test") setNotice(bbt("shareOK"))
      if (method === "skill.test" && result && typeof result === "object" && "text" in result) setTestOutput(String(result.text))
      if (method === "skill.draft" && result && typeof result === "object" && "instructions" in result) updateEditor({ instructions: String(result.instructions) })
      if (method === "pick.template" && typeof result === "string") updateEditor({ template: result })
      return result
    } catch (reason) { setError(bbError(reason)) }
    finally { setBusy("") }
  }
  onMount(() => {
    void refresh().catch((reason) => setError(bbError(reason)))
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "meter" || event.type === "duration" || event.type === "browser" || event.type === "artifact") return
      if (event.type === "notice") { setError(bbError(event.message)); return }
      if (event.type === "job") {
        setState((current) => current ? { ...current, jobs: [event.job, ...current.jobs.filter((job) => job.id !== event.job.id)].sort((a,b) => b.created - a.created) } : current)
        return
      }
      void refresh()
    })
    onCleanup(unsubscribe)
    const openSettings = () => { setTab("chats"); window.dispatchEvent(new Event("bitsbytes:open-settings")) }
    window.addEventListener("bitsbytes:settings", openSettings)
    onCleanup(() => window.removeEventListener("bitsbytes:settings", openSettings))
  })

  async function saveSkill() {
    const value = editor()
    const id = value.id || value.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0,64)
    if (!id || !value.instructions.trim()) { setError(bbt("bb.error.invalidSkill")); return }
    const instructions = value.instructions.startsWith("---") ? value.instructions : `---\nname: ${id}\ndescription: ${JSON.stringify(value.name)}\n---\n\n${value.instructions}`
    await run("skill.save", { ...value, id, instructions })
    const saved = state()?.skills.find((skill) => skill.id === id)
    if (saved) setEditor({ ...saved })
  }
  function addTranscript(job: Job) {
    try { props.audio.insert(job); setTab("chats") }
    catch (reason) { setError(bbError(reason)) }
  }
  async function showDocument(job: Job) {
    if (!job.artifact) return
    setTab("chats")
    if (job.sessionID) navigate({ sessionID: job.sessionID, directory: state()!.root + "\\workspace" })
    window.dispatchEvent(new CustomEvent("bitsbytes:open-document", { detail: { path: job.artifact.path, sessionID: job.sessionID } }))
  }

  return <div class="bb-shell">
    <nav class="bb-nav">
      <For each={["chats", "skills", "recordings", "settings"] as const}>{(item) => <button classList={{ selected: tab() === item, "bb-nav-settings": item === "settings" }} aria-label={bbt(item)} aria-pressed={tab() === item} title={bbt(item)} onClick={() => { if (item === "settings") { setTab("chats"); window.dispatchEvent(new Event("bitsbytes:open-settings")); return } setTab(item) }}><Show when={item === "recordings"} fallback={<Icon name={item === "chats" ? "bubble-5" : item === "skills" ? "brain" : "settings-gear"} />}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3M9 21h6"/></svg></Show></button>}</For>
    </nav>
    <main class="bb-main">
      <Show when={busy() || error() || notice()}><div classList={{ "bb-banner": true, "bb-error": Boolean(error()) }} role="status">{error() || notice() || bbt("running")}</div></Show>
      <div class="bb-content">
        <div class="bb-chat" classList={{ "bb-hidden": tab() !== "chats" }}>{props.children}</div>

        <Show when={tab() === "recordings"}>
          <section class="bb-page"><h1>{bbt("recordings")}</h1><p class="bb-subtle">{state()?.settings.engine === "groq" ? bbt("onlineHint") : bbt("localHint")}</p>
            <button disabled={Boolean(busy()) || Boolean(active()) || !state()?.workerReady} onClick={() => void run("audio.import")}>{bbt("importAudio")}</button>
            <Show when={state()?.jobs.length} fallback={<div class="bb-empty">{bbt("emptyRecordings")}</div>}>
              <For each={state()?.jobs}>{(job) => <article class="bb-card bb-job">
                <div><h2>{job.title}</h2><p class="bb-subtle">{time(job.duration)} · {job.engine} · {job.status} · {job.chunks.filter((chunk) => chunk.done).length}/{job.chunks.length}</p><Show when={job.error}><p class="bb-error">{bbError(job.error)}</p></Show></div>
                <div class="bb-actions"><Show when={job.recording}><button onClick={() => void run("record.cancel", { id: job.id })}>{bbt("cancelRecording")}</button></Show><button onClick={() => setTranscript(job)}>{bbt("transcript")}</button>
                  <Show when={job.sessionID}><button onClick={() => navigate({ sessionID: job.sessionID, directory: state()!.root + "\\workspace" })}>{bbt("openChat")}</button></Show>
                  <Show when={job.artifact}>{(artifact) => <><button onClick={() => void showDocument(job)}>{bbt("preview")}</button><button onClick={() => void run("file.open", { path: artifact().path })}>{bbt("openWord")}</button><span class="bb-badge">{bbt(artifact().used_fallback ? "savedLocal" : "savedServer")}</span><Show when={artifact().used_fallback}><button onClick={() => void run("docx.retry", { id: job.id })}>{bbt("retryServer")}</button></Show></>}</Show>
                  <Show when={!["complete", "transcribed", "transcribing"].includes(job.status) && !job.recording}><button disabled={Boolean(busy())} onClick={() => void run("transcribe", { id: job.id })}>{bbt("retry")}</button></Show>
                  <Show when={job.transcript && !job.recording && job.status !== "transcribing"}><button disabled={Boolean(busy())} onClick={() => addTranscript(job)}>{bbt("addToChat")}</button></Show>
                  <Show when={job.skill && !job.recording && job.status !== "transcribing"}><button disabled={Boolean(busy())} onClick={() => void run("template.refresh", { id: job.id })}>{bbt("refreshTemplate")}</button></Show>
                  <Show when={job.status === "transcribing"}><button onClick={() => void run("transcribe.cancel", { id: job.id })}>{bbt("cancel")}</button></Show>
                  <button disabled={job.recording || job.status === "transcribing"} onClick={() => void run("job.delete", { id: job.id })}>{bbt("delete")}</button>
                </div></article>}</For>
            </Show>
          </section>
        </Show>
        <Show when={tab() === "skills"}>
          <section class="bb-page bb-skills"><div class="bb-skill-list"><h1>{bbt("skills")}</h1><button class="bb-primary" onClick={() => setEditor(freshSkill())}>{bbt("newSkill")}</button>
            <For each={state()?.skills}>{(skill) => <button classList={{ selected: editor().id === skill.id }} onClick={() => setEditor({ ...skill })}><strong>{skill.name}</strong><small>{bbt(skill.enabled ? "enable" : "draft")}</small></button>}</For>
            <button onClick={() => void run("skill.import")}>{bbt("skillImport")}</button>
          </div><div class="bb-skill-editor"><h2>{editor().name || bbt("newSkill")}</h2><p class="bb-subtle">{bbt("skillHint")}</p>
            <label>{bbt("name")}<input value={editor().name} onInput={(event) => updateEditor({ name: event.currentTarget.value })} /></label>
            <label>{bbt("description")}<textarea rows="3" value={description()} onInput={(event) => setDescription(event.currentTarget.value)} /></label>
            <div class="bb-actions"><button disabled={Boolean(busy()) || !description().trim()} onClick={() => void run("skill.draft", { description: description(), template: editor().template, instructions: editor().instructions })}>{bbt("generate")}</button><button onClick={() => void run("pick.template")}>{bbt("attachTemplate")}</button></div>
            <label>{bbt("template")}<input value={editor().template} onInput={(event) => updateEditor({ template: event.currentTarget.value })} /></label>
            <label>{bbt("outputFolder")}<input value={editor().output} onInput={(event) => updateEditor({ output: event.currentTarget.value })} /></label>
            <label>{bbt("defaultPrompt")}<textarea rows="2" value={editor().defaultPrompt} onInput={(event) => updateEditor({ defaultPrompt: event.currentTarget.value })} /></label>
            <label>{bbt("instructions")}<textarea class="bb-code" rows="15" value={editor().instructions} onInput={(event) => updateEditor({ instructions: event.currentTarget.value })} /></label>
            <label class="bb-check"><input type="checkbox" checked={editor().enabled} onChange={(event) => updateEditor({ enabled: event.currentTarget.checked })} />{bbt("enable")}</label>
            <div class="bb-actions"><button class="bb-primary" disabled={Boolean(busy())} onClick={() => void saveSkill()}>{bbt("save")}</button><button disabled={!editor().id} onClick={() => void run("skill.export", { id: editor().id })}>{bbt("skillExport")}</button><button disabled={!editor().id} onClick={() => void run("skill.resources", { id: editor().id })}>{bbt("editResources")}</button>
              <Show when={editor().versions.length}><select aria-label={bbt("versions")} onChange={(event) => void run("skill.restore", { id: editor().id, revision: Number(event.currentTarget.value) }).then(() => { const skill=state()?.skills.find(row=>row.id===editor().id); if(skill)setEditor({...skill}) })}><option value="">{bbt("restore")}</option><For each={editor().versions}>{(version) => <option value={version}>{version}</option>}</For></select></Show>
            </div>
            <label>{bbt("testInput")}<textarea rows="4" value={testInput()} onInput={(event) => setTestInput(event.currentTarget.value)} /></label><button disabled={Boolean(busy()) || !testInput()} onClick={() => void run("skill.test", { id: editor().id, template: editor().template, instructions: editor().instructions, input: testInput() })}>{bbt("test")}</button><Show when={testOutput()}><pre class="bb-test-result">{testOutput()}</pre></Show>
          </div></section>
        </Show>
      </div>
    </main>
    <Show when={transcript()}>{(job) => <div class="bb-modal"><div class="bb-modal-card"><header><h2>{job().title}</h2><button onClick={() => setTranscript(undefined)}>×</button></header><pre>{job().transcript || bbt("running")}</pre></div></div>}</Show>
  </div>
}
