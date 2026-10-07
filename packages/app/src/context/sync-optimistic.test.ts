import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { applyOptimisticAdd, applyOptimisticRemove, mergeOptimisticPage } from "./sync"

type Text = Extract<Part, { type: "text" }>

const userMessage = (id: string, sessionID: string, created = 1): Message => ({
  id,
  sessionID,
  role: "user",
  time: { created },
  agent: "assistant",
  model: { providerID: "openai", modelID: "gpt" },
})

const textPart = (id: string, sessionID: string, messageID: string): Text => ({
  id,
  sessionID,
  messageID,
  type: "text",
  text: id,
})

describe("sync optimistic reducers", () => {
  test("applyOptimisticAdd inserts by creation time", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_z", sessionID, 1)] },
      part: {} as Record<string, Part[] | undefined>,
    }

    applyOptimisticAdd(draft, {
      sessionID,
      message: userMessage("msg_a", sessionID, 2),
      parts: [textPart("prt_2", sessionID, "msg_a"), textPart("prt_1", sessionID, "msg_a")],
    })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_z", "msg_a"])
    expect(draft.part.msg_a?.map((x) => x.id)).toEqual(["prt_1", "prt_2"])
  })

  test("applyOptimisticRemove removes message and part entries", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_1", sessionID), userMessage("msg_2", sessionID)] },
      part: {
        msg_1: [textPart("prt_1", sessionID, "msg_1")],
        msg_2: [textPart("prt_2", sessionID, "msg_2")],
      } as Record<string, Part[] | undefined>,
    }

    applyOptimisticRemove(draft, { sessionID, messageID: "msg_1" })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_2"])
    expect(draft.part.msg_1).toBeUndefined()
    expect(draft.part.msg_2).toHaveLength(1)
  })

  test("repeated optimistic additions replace their identity and correct ordering", () => {
    const sessionID = "ses_1"
    const draft = {
      message: {
        [sessionID]: [
          userMessage("msg_same", sessionID, 1),
          userMessage("msg_same", sessionID, 2),
          userMessage("msg_other", sessionID, 3),
        ],
      },
      part: {} as Record<string, Part[] | undefined>,
    }
    for (const created of [4, 0]) {
      applyOptimisticAdd(draft, {
        sessionID,
        message: userMessage("msg_same", sessionID, created),
        parts: [textPart("prt_same", sessionID, "msg_same")],
      })
      expect(draft.message[sessionID]).toHaveLength(2)
      expect(draft.message[sessionID]?.filter((message) => message.id === "msg_same")).toHaveLength(1)
    }
    expect(draft.message[sessionID]?.map((message) => message.id)).toEqual(["msg_same", "msg_other"])
    expect(draft.message[sessionID]?.[0].time.created).toBe(0)
    expect(draft.part.msg_same?.map((part) => part.id)).toEqual(["prt_same"])
  })

  test("optimistic removal clears every stale copy of the same ID", () => {
    const sessionID = "ses_1"
    const draft = {
      message: {
        [sessionID]: [
          userMessage("msg_same", sessionID, 1),
          userMessage("msg_other", sessionID, 2),
          userMessage("msg_same", sessionID, 3),
        ],
      },
      part: { msg_same: [textPart("prt_same", sessionID, "msg_same")] } as Record<string, Part[] | undefined>,
    }
    applyOptimisticRemove(draft, { sessionID, messageID: "msg_same" })
    expect(draft.message[sessionID]?.map((message) => message.id)).toEqual(["msg_other"])
    expect(draft.part.msg_same).toBeUndefined()
  })

  test("mergeOptimisticPage keeps pending messages in fetched timelines", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_z", sessionID, 1)],
        part: [{ id: "msg_z", part: [textPart("prt_1", sessionID, "msg_z")] }],
        complete: true,
      },
      [{ message: userMessage("msg_a", sessionID, 2), parts: [textPart("prt_2", sessionID, "msg_a")] }],
    )

    expect(page.session.map((x) => x.id)).toEqual(["msg_z", "msg_a"])
    expect(page.part.find((x) => x.id === "msg_a")?.part.map((x) => x.id)).toEqual(["prt_2"])
    expect(page.confirmed).toEqual([])
    expect(page.complete).toBe(true)
  })

  test("mergeOptimisticPage uses IDs only to break equal-time ties", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_z", sessionID, 1)],
        part: [],
        complete: true,
      },
      [{ message: userMessage("msg_a", sessionID, 1), parts: [] }],
    )

    expect(page.session.map((message) => message.id)).toEqual(["msg_a", "msg_z"])
  })

  test("mergeOptimisticPage keeps missing optimistic parts until the server has them", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [{ id: "msg_2", part: [textPart("prt_2", sessionID, "msg_2")] }],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_1", sessionID, "msg_2"), textPart("prt_2", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual(["prt_1", "prt_2"])
    expect(page.confirmed).toEqual([])
  })

  test("mergeOptimisticPage confirms echoed messages once all parts arrive", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [
          {
            id: "msg_2",
            part: [{ ...textPart("prt_1", sessionID, "msg_2"), text: "server" }, textPart("prt_2", sessionID, "msg_2")],
          },
        ],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_1", sessionID, "msg_2"), textPart("prt_2", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.confirmed).toEqual(["msg_2"])
    expect(page.part.find((x) => x.id === "msg_2")?.part).toMatchObject([
      { id: "prt_1", type: "text", text: "server" },
      { id: "prt_2", type: "text", text: "prt_2" },
    ])
  })

  test("a server echo confirms the same ID despite a corrected timestamp", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_before", sessionID, 2), userMessage("msg_same", sessionID, 3)],
        part: [
          { id: "msg_same", part: [{ ...textPart("prt_same", sessionID, "msg_same"), text: "authoritative source" }] },
        ],
        complete: true,
      },
      [{ message: userMessage("msg_same", sessionID, 1), parts: [textPart("prt_same", sessionID, "msg_same")] }],
    )
    expect(page.session.map((message) => message.id)).toEqual(["msg_before", "msg_same"])
    expect(page.session.at(-1)?.time.created).toBe(3)
    expect(page.confirmed).toEqual(["msg_same"])
    expect(page.part.find((entry) => entry.id === "msg_same")?.part[0]).toMatchObject({ text: "authoritative source" })
  })

  test("a timestamp-corrected echo retains missing optimistic parts without a duplicate message", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage({ session: [userMessage("msg_same", sessionID, 3)], part: [], complete: true }, [
      { message: userMessage("msg_same", sessionID, 1), parts: [textPart("prt_same", sessionID, "msg_same")] },
    ])
    expect(page.session).toHaveLength(1)
    expect(page.session[0].time.created).toBe(3)
    expect(page.part.find((entry) => entry.id === "msg_same")?.part.map((part) => part.id)).toEqual(["prt_same"])
    expect(page.confirmed).toEqual([])
  })
})
