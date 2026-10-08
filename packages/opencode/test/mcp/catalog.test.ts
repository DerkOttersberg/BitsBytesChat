import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "@/mcp/catalog"
import { Effect } from "effect"
import { ToolOperation } from "@opencode-ai/schema/tool-operation"

const options = { toolCallId: "call_mcp", abortSignal: new AbortController().signal } as any

function clientReturning(result: unknown) {
  return {
    callTool: async () => result,
  } as unknown as Client
}

function mcpTool() {
  return {
    name: "screenshot",
    description: "Take a screenshot",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  } as any
}

describe("McpCatalog.convertTool", () => {
  test("MCP calls retain the executing input identity independently of model arguments", async () => {
    const calls: unknown[] = []
    const client = {
      callTool: async (request: unknown) => {
        calls.push(request)
        return { content: [] }
      },
    } as unknown as Client
    const converted = McpCatalog.convertTool(mcpTool(), client, undefined, "chat", "originating-input")
    await converted.execute?.({ inputID: "untrusted-argument" }, options)
    expect(calls).toEqual([
      {
        name: "screenshot",
        arguments: { inputID: "untrusted-argument" },
        _meta: { sessionID: "chat", inputID: "originating-input" },
      },
    ])
  })
  test("typed MCP failures preserve validated retry lineage and exact diagnostics", async () => {
    const operation = {
      operationID: "operation",
      attemptID: "attempt",
      sessionID: "chat",
      tool: "create_artifact",
      outputKey: "output",
    }
    const converted = McpCatalog.convertTool(
      mcpTool(),
      clientReturning({
        isError: true,
        content: [{ type: "text", text: "failed exactly 🌿" }],
        _meta: { [ToolOperation.key]: operation },
      }),
    )
    const error = await converted.execute?.({}, options).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(McpCatalog.ToolError)
    if (!(error instanceof McpCatalog.ToolError)) throw new Error("Expected typed tool error")
    expect(error.message).toBe("failed exactly 🌿")
    expect(error.operation).toEqual(operation)
  })
  test("malformed MCP operation metadata never acquires retry authority", async () => {
    const converted = McpCatalog.convertTool(
      mcpTool(),
      clientReturning({
        isError: true,
        content: [{ type: "text", text: "failed" }],
        _meta: { [ToolOperation.key]: { operationID: "partial" } },
      }),
    )
    const error = await converted.execute?.({}, options).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(McpCatalog.ToolError)
    if (!(error instanceof McpCatalog.ToolError)) throw new Error("Expected typed tool error")
    expect(error.operation).toBeUndefined()
  })
  test("preserves content when structuredContent is also present", async () => {
    const content = [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }]
    const structuredContent = { image: { mimeType: "image/png", data: "AAAA" } }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content, structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({ content, structuredContent })
  })

  test("falls back to structuredContent only when content is absent", async () => {
    const structuredContent = { results: [{ title: "one" }] }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content: [], structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    })
  })
})

test("preserves output schema validation across paginated tool discovery", async () => {
  const server = new Server({ name: "pagination", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, ({ params }) =>
    Promise.resolve(
      params?.cursor === "page-2"
        ? {
            tools: [
              {
                name: "second",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "number" } },
                  required: ["value"],
                },
              },
            ],
          }
        : {
            tools: [
              {
                name: "first",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
            nextCursor: "page-2",
          },
    ),
  )
  server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
    Promise.resolve({
      content: [],
      structuredContent: { value: params.name === "first" ? 42 : 1 },
    }),
  )

  const client = new Client({ name: "pagination-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  try {
    const tools = await Effect.runPromise(McpCatalog.defs(client))
    expect(tools?.map((tool) => tool.name)).toEqual(["first", "second"])
    await expect(client.callTool({ name: "first", arguments: {} })).rejects.toThrow(
      "Structured content does not match the tool's output schema",
    )
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})
