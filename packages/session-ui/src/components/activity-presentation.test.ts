import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { activityCategory, activitySummary } from "./activity-presentation"
import { referenceKind } from "./reference-kind"

const tool = (
  name: string,
  state: ToolPart["state"] = {
    status: "completed",
    input: {},
    output: "",
    title: name,
    metadata: {},
    time: { start: 1, end: 2 },
  },
): ToolPart => ({
  id: "prt_" + name,
  sessionID: "ses_qa",
  messageID: "msg_qa",
  type: "tool",
  callID: name,
  tool: name,
  state,
})

describe("activity presentation", () => {
  test("both engine tool vocabularies share concise truthful summaries", () => {
    expect(activitySummary([tool("read"), tool("edit"), tool("shell")])).toEqual({
      key: "ui.activity.summary.7",
      icon: "pencil-line",
    })
    expect(activitySummary([tool("bash"), tool("websearch")])).toEqual({
      key: "ui.activity.summary.12",
      icon: "console",
    })
    expect(activityCategory(tool("apply_patch"))).toBe(2)
    expect(activityCategory(tool("patch"))).toBe(2)
  })
  test("unknown tools, questions and unresolved failures stay individually visible", () => {
    expect(activityCategory(tool("custom_write"))).toBe(0)
    expect(activityCategory(tool("question"))).toBe(0)
    expect(
      activityCategory(tool("shell", { status: "error", input: {}, error: "failed", time: { start: 1, end: 2 } })),
    ).toBe(0)
  })
  test("an actual recorded image keeps its preview outside the collapsed group", () => {
    const image = tool("read")
    if (image.state.status !== "completed") throw Error("fixture state")
    image.state.attachments = [
      {
        id: "prt_image",
        sessionID: image.sessionID,
        messageID: image.messageID,
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,aGVsbG8=",
      },
    ]
    expect(activityCategory(image)).toBe(0)
    expect(activityCategory(tool("read"))).toBe(1)
  })
  test("live statuses can group without claiming completion or hiding them from ownership checks", () => {
    expect(activityCategory(tool("shell", { status: "running", input: {}, time: { start: 1 } }))).toBe(4)
    expect(activityCategory(tool("read", { status: "pending", input: {}, raw: "" }))).toBe(1)
  })
})

describe("reference presentation", () => {
  test("Windows absolute, UNC and file links retain their actual local target", () => {
    for (const value of [
      "D:/Chat/plan.md:12",
      "/C:/My%20Folder/file.pdf",
      "C:\\Chat\\preview.png",
      "\\\\server\\share\\file.docx",
      "file:///D:/Chat/plan.md",
    ])
      expect(referenceKind(value)).toBe("file")
  })
  test("only real web URLs classify as web; no fake citations or unsafe scheme decoration", () => {
    expect(referenceKind("https://example.org/source")).toBe("web")
    for (const value of ["javascript:alert(1)", "data:text/html,hello", "#heading", "relative.md", "unverified source"])
      expect(referenceKind(value)).toBeUndefined()
  })
})
