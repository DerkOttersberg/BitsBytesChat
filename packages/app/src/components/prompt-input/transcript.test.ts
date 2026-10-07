import { describe, expect, test } from "bun:test"
import { createPromptState } from "@/context/prompt-state"
import { captureTranscriptDraft } from "./transcript"
import { buildRequestParts } from "./build-request-parts"
import { extractPromptFromParts } from "../../utils/prompt"

describe("recorded transcript drafts", () => {
  test("preserves an existing request and attachments without submitting", () => {
    const target = createPromptState()
    target.set([{ type: "text", content: "Maak een intake.", start: 0, end: 16 }, { type: "file", path: "template.docx", content: "@template", start: 16, end: 25 }])
    const append = captureTranscriptDraft(target.capture(), id => `Source ${id}`)
    const text = "De deelnemer heet Voorbeeld.\n".repeat(4000)
    append({ text, path: "C:\\recordings\\job\\transcript.txt", jobID: "job" })
    expect(target.current()[0]).toMatchObject({ type: "text", content: "Maak een intake." })
    expect(target.current()[1]?.type).toBe("file")
    expect(target.current()).toHaveLength(2)
    expect(target.store[0]().context.items[0]?.attachment).toEqual({ kind: "transcript", id: "job", name: "transcript.txt" })
    expect(target.current().some(part => "content" in part && part.content.includes("Voorbeeld"))).toBe(false)
    expect(target.store[0]().context.items[0]?.comment).toBe("Source job")
  })
  test("stays bound to the original draft after switching chats", () => {
    const first = createPromptState()
    const second = createPromptState()
    const append = captureTranscriptDraft(first.capture(), id => id)
    second.set([{ type: "text", content: "Other chat", start: 0, end: 10 }])
    append({ text: "Recorded speech", path: "transcript.txt", jobID: "first" })
    expect(first.current().map(part => "content" in part ? part.content : "").join("")).toBe("")
    expect(first.store[0]().context.items[0]?.attachment?.id).toBe("first")
    expect(second.current()[0]).toMatchObject({ type: "text", content: "Other chat" })
  })
  test("empty speech leaves the draft unchanged", () => {
    const target = createPromptState()
    captureTranscriptDraft(target.capture(), id => id)({ text: "  ", path: "transcript.txt", jobID: "empty" })
    expect(target.dirty()).toBe(false)
    expect(target.context.items()).toHaveLength(0)
  })
})

test("source references survive send and restore without visible source text", () => {
  const state = createPromptState()
  captureTranscriptDraft(state.capture(), id => id)({ text: "private source".repeat(20000), path: "transcript.txt", jobID: "test-recording" })
  state.context.add({ type: "file", path: "skill/SKILL.md", comment: "Intake", attachment: { kind: "skill", id: "intake", revision: 3, name: "Intake" } })
  const result = buildRequestParts({ prompt: state.current(), context: state.store[0]().context.items, images: [], text: "", messageID: "message_test", sessionID: "session_test", sessionDirectory: "C:/workspace" })
  expect(result.requestParts).toHaveLength(2)
  expect(result.requestParts[0]).toMatchObject({ type: "file", url: "bitsbytes://transcript/test-recording" })
  expect(result.requestParts[1]).toMatchObject({ type: "file", url: "bitsbytes://skill/intake?revision=3" })
  const restored = createPromptState()
  restored.set(extractPromptFromParts(result.optimisticParts))
  expect(restored.store[0]().context.items.map(item => item.attachment?.kind)).toEqual(["transcript", "skill"])
  expect(restored.current().map(part => "content" in part ? part.content : "").join("")).toBe("")
})
