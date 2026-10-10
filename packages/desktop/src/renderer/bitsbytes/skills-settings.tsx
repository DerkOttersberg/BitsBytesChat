import { For, Show, onMount, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { Skill, State } from "../../bitsbytes/types"
import { bbt, bbError } from "../../bitsbytes/copy"

function skillContent(instructions: string) {
  const header = instructions.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)(?:\r?\n)*/)
  const value = header?.[1].match(/^description:[ \t]*([^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)/m)?.[1].trim() ?? ""
  const description = (() => {
    if (value.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(value)
        if (typeof parsed === "string") return parsed
      } catch {}
    }
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'")
    return value
      .replace(/^[>|][-+]?\s*\n/, "")
      .replace(/\s+/g, " ")
      .trim()
  })()
  return { prefix: header?.[0] ?? "", body: instructions.slice(header?.[0].length ?? 0), description }
}

function skillInstructions(instructions: string, id: string, shortDescription: string) {
  const content = skillContent(instructions)
  const description = `description: ${JSON.stringify(shortDescription.trim())}`
  const prefix = !content.prefix
    ? `---\nname: ${id}\n${description}\n---\n\n`
    : content.description === shortDescription.trim()
      ? content.prefix
      : /^description:/m.test(content.prefix)
        ? content.prefix.replace(/^description:[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/m, () => description)
        : content.prefix.replace(/\r?\n---/, () => `\n${description}\n---`)
  return prefix + content.body
}

const freshSkill = (): Skill => ({
  id: "",
  name: "",
  instructions: "",
  defaultPrompt: "",
  enabled: false,
  template: "",
  output: "",
  revision: 0,
  versions: [],
  files: [],
})
export function SkillsSettings() {
  const [store, setStore] = createStore({
    skills: [] as Skill[],
    editor: freshSkill(),
    editing: false,
    busy: false,
    error: "",
    shortDescription: "",
    description: "",
    input: "",
    output: "",
  })
  async function refresh() {
    const state = await window.api.bitsbytes.call<State>("state")
    setStore("skills", state.skills)
  }
  async function run(method: string, args: Record<string, unknown> = {}) {
    setStore({ busy: true, error: "" })
    try {
      const result = await window.api.bitsbytes.call(method, JSON.parse(JSON.stringify(args)))
      await refresh()
      if (method === "skill.draft" && result && typeof result === "object" && "instructions" in result) {
        setStore("editor", "instructions", String(result.instructions))
        setStore("shortDescription", skillContent(String(result.instructions)).description)
      }
      if (method === "skill.test" && result && typeof result === "object" && "text" in result)
        setStore("output", String(result.text))
      if (method === "pick.template" && typeof result === "string") setStore("editor", "template", result)
      if (method === "skill.restore") {
        const skill = store.skills.find((row) => row.id === args.id)
        if (skill) {
          setStore("editor", { ...skill })
          setStore("shortDescription", skillContent(skill.instructions).description)
        }
      }
      return true
    } catch (error) {
      setStore("error", bbError(error))
      return false
    } finally {
      setStore("busy", false)
    }
  }
  async function save() {
    const id =
      store.editor.id ||
      store.editor.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64)
    const content = skillContent(store.editor.instructions)
    if (!id || !store.editor.name.trim() || !content.body.trim()) {
      setStore("error", bbt("bb.error.invalidSkill"))
      return
    }
    const instructions = skillInstructions(store.editor.instructions, id, store.shortDescription)
    if (await run("skill.save", { ...store.editor, id, instructions })) {
      const skill = store.skills.find((row) => row.id === id)
      if (skill) {
        setStore("editor", { ...skill })
        setStore("shortDescription", skillContent(skill.instructions).description)
      }
    }
  }
  onMount(() => {
    void refresh().catch((error) => setStore("error", bbError(error)))
    const unsubscribe = window.api.bitsbytes.subscribe((event) => {
      if (event.type === "refresh") void refresh().catch((error) => setStore("error", bbError(error)))
    })
    onCleanup(unsubscribe)
  })
  return (
    <section data-setting-key="extensions-skills">
      <div class="bb-settings-section-heading">
        <span>{bbt("extensions.global")}</span>
        <div class="bb-actions">
          <ButtonV2 variant="neutral" disabled={store.busy} onClick={() => void run("skill.import")}>
            {bbt("skillImport")}
          </ButtonV2>
          <ButtonV2
            variant="neutral"
            disabled={store.busy}
            onClick={() =>
              setStore({
                editing: true,
                editor: freshSkill(),
                shortDescription: "",
                description: "",
                input: "",
                output: "",
                error: "",
              })
            }
          >
            {bbt("newSkill")}
          </ButtonV2>
        </div>
      </div>
      <Show when={store.error}>
        <p class="bb-error" role="alert">
          {store.error}
        </p>
      </Show>
      <Show when={!store.skills.length}>
        <p class="bb-subtle">{bbt("extensions.noSkills")}</p>
      </Show>
      <For each={store.skills}>
        {(skill) => (
          <div class="bb-extension-row">
            <button
              class="bb-extension-label"
              disabled={store.busy}
              onClick={() =>
                setStore({
                  editing: true,
                  editor: { ...skill },
                  shortDescription: skillContent(skill.instructions).description,
                  description: "",
                  input: "",
                  output: "",
                  error: "",
                })
              }
            >
              <Icon name="brain" size="small" />
              <span style={{ display: "flex", "flex-direction": "column", gap: "3px" }}>
                <strong>{skill.name}</strong>
                <Show when={skillContent(skill.instructions).description}>
                  <small
                    style={{
                      "margin-left": "0",
                      display: "-webkit-box",
                      "-webkit-line-clamp": "2",
                      "-webkit-box-orient": "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {skillContent(skill.instructions).description}
                  </small>
                </Show>
              </span>
            </button>
            <input
              type="checkbox"
              role="switch"
              checked={skill.enabled}
              disabled={store.busy}
              aria-label={bbt("extensions.toggle", { name: skill.name })}
              onChange={(event) => {
                const enabled = event.currentTarget.checked
                event.currentTarget.checked = skill.enabled
                void run("skill.save", { ...skill, enabled }).then((saved) => {
                  if (saved && store.editor.id === skill.id) setStore("editor", "enabled", enabled)
                })
              }}
            />
          </div>
        )}
      </For>
      <Show when={store.editing}>
        <fieldset class="bb-settings-editor" disabled={store.busy}>
          <label>
            {bbt("name")}
            <input
              aria-label={bbt("name")}
              value={store.editor.name}
              onInput={(event) => setStore("editor", "name", event.currentTarget.value)}
            />
          </label>
          <label>
            {bbt("extensions.skillDescription")}
            <input
              aria-label={bbt("extensions.skillDescription")}
              value={store.shortDescription}
              onInput={(event) => setStore("shortDescription", event.currentTarget.value)}
            />
          </label>
          <label>
            {bbt("instructions")}
            <textarea
              aria-label={bbt("instructions")}
              class="bb-code"
              rows={10}
              value={skillContent(store.editor.instructions).body}
              onInput={(event) =>
                setStore(
                  "editor",
                  "instructions",
                  skillContent(store.editor.instructions).prefix + event.currentTarget.value,
                )
              }
            />
          </label>
          <label class="bb-check">
            <input
              type="checkbox"
              checked={store.editor.enabled}
              onChange={(event) => setStore("editor", "enabled", event.currentTarget.checked)}
            />
            {bbt("enable")}
          </label>
          <div class="bb-actions">
            <ButtonV2 disabled={store.busy} onClick={() => void save()}>
              {bbt("save")}
            </ButtonV2>
            <ButtonV2 variant="neutral" disabled={store.busy} onClick={() => setStore("editing", false)}>
              {bbt("close")}
            </ButtonV2>
            <ButtonV2
              variant="neutral"
              disabled={store.busy || !store.editor.id}
              onClick={() => void run("skill.export", { id: store.editor.id })}
            >
              {bbt("skillExport")}
            </ButtonV2>
          </div>
          <details class="bb-settings-details">
            <summary>{bbt("extensions.advanced")}</summary>
            <label>
              {bbt("defaultPrompt")}
              <textarea
                rows={2}
                value={store.editor.defaultPrompt}
                onInput={(event) => setStore("editor", "defaultPrompt", event.currentTarget.value)}
              />
            </label>
            <label>
              {bbt("template")}
              <input
                value={store.editor.template}
                onInput={(event) => setStore("editor", "template", event.currentTarget.value)}
              />
            </label>
            <ButtonV2 variant="neutral" disabled={store.busy} onClick={() => void run("pick.template")}>
              {bbt("attachTemplate")}
            </ButtonV2>
            <label>
              {bbt("outputFolder")}
              <input
                value={store.editor.output}
                onInput={(event) => setStore("editor", "output", event.currentTarget.value)}
              />
            </label>
            <ButtonV2
              variant="neutral"
              disabled={store.busy || !store.editor.id}
              onClick={() => void run("skill.resources", { id: store.editor.id })}
            >
              {bbt("editResources")}
            </ButtonV2>
            <Show when={store.editor.versions.length}>
              <label>
                {bbt("versions")}
                <select
                  aria-label={bbt("versions")}
                  value=""
                  onChange={(event) =>
                    void run("skill.restore", { id: store.editor.id, revision: Number(event.currentTarget.value) })
                  }
                >
                  <option value="" disabled>
                    {bbt("restore")}
                  </option>
                  <For each={store.editor.versions}>{(version) => <option value={version}>{version}</option>}</For>
                </select>
              </label>
            </Show>
            <details class="bb-settings-details">
              <summary>{bbt("extensions.generateSkill")}</summary>
              <label>
                {bbt("description")}
                <textarea
                  rows={3}
                  value={store.description}
                  onInput={(event) => setStore("description", event.currentTarget.value)}
                />
              </label>
              <ButtonV2
                disabled={store.busy || !store.description.trim()}
                onClick={() =>
                  void run("skill.draft", {
                    description: store.description,
                    template: store.editor.template,
                    instructions: skillInstructions(store.editor.instructions, store.editor.id, store.shortDescription),
                  })
                }
              >
                {bbt("generate")}
              </ButtonV2>
            </details>
            <details class="bb-settings-details">
              <summary>{bbt("extensions.testSkill")}</summary>
              <label>
                {bbt("testInput")}
                <textarea
                  rows={4}
                  value={store.input}
                  onInput={(event) => setStore("input", event.currentTarget.value)}
                />
              </label>
              <ButtonV2
                disabled={store.busy || !store.input.trim()}
                onClick={() =>
                  void run("skill.test", {
                    id: store.editor.id,
                    template: store.editor.template,
                    instructions: skillInstructions(store.editor.instructions, store.editor.id, store.shortDescription),
                    input: store.input,
                  })
                }
              >
                {bbt("extensions.testSkill")}
              </ButtonV2>
              <Show when={store.output}>
                <pre class="bb-test-result">{store.output}</pre>
              </Show>
            </details>
          </details>
        </fieldset>
      </Show>
    </section>
  )
}
