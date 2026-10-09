import { expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { DesktopBridge } from "@opencode-ai/core/desktop-bridge"

test("desktop automatic review preserves Ask/Full behavior and Plan restrictions with real authenticated bridge calls", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bitsbytes-approval-bridge-"))
  const previous = { url: process.env.BITSBYTES_ENGINE_BRIDGE_URL, token: process.env.BITSBYTES_ENGINE_BRIDGE_TOKEN }
  let mode = "auto",
    plan = false,
    unavailable = false,
    diagnostic = false
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer owned-qa-bridge")
      if (unavailable) return new Response("Unavailable", { status: 503 })
      const body = (await request.json()) as { name: string; arguments: { sessionID: string } }
      expect(body.arguments.sessionID).toBe("ses_owned_qa")
      return Response.json(body.name === "runs.permission" ? { plan, diagnostic } : { mode })
    },
  })
  process.env.BITSBYTES_ENGINE_BRIDGE_URL = server.url.toString()
  process.env.BITSBYTES_ENGINE_BRIDGE_TOKEN = "owned-qa-bridge"
  try {
    await writeFile(path.join(directory, "safe.md"), "kept")
    const details = { directory, resources: ["safe.md"], metadata: { operation: "edit", destructive: false } }
    expect(await DesktopBridge.permission("ses_owned_qa", "edit", details)).toBe("allow")
    expect(await DesktopBridge.permission("ses_owned_qa", "edit", { ...details, resources: [".env"] })).toBe("ask")
    expect(await DesktopBridge.permission("ses_owned_qa", "bash", { ...details, resources: ["git status"] })).toBe(
      "ask",
    )
    mode = "ask"
    expect(await DesktopBridge.permission("ses_owned_qa", "edit", details)).toBe("ask")
    expect(await DesktopBridge.permission("ses_owned_qa", "read", details)).toBe("allow")
    mode = "full"
    expect(await DesktopBridge.permission("ses_owned_qa", "edit", { ...details, resources: [".env"] })).toBe("allow")
    plan = true
    for (const value of ["auto", "ask", "full"]) {
      mode = value
      expect(await DesktopBridge.permission("ses_owned_qa", "edit", details)).toBe("deny")
      expect(await DesktopBridge.permission("ses_owned_qa", "read", details)).toBe("allow")
    }
    plan = false
    diagnostic = true
    for (const value of ["auto", "ask", "full"]) {
      mode = value
      expect(await DesktopBridge.permission("ses_owned_qa", "edit", details)).toBe("deny")
      expect(await DesktopBridge.permission("ses_owned_qa", "webfetch", details)).toBe("deny")
      expect(await DesktopBridge.permission("ses_owned_qa", "parent_progress", details)).toBe("allow")
      expect(await DesktopBridge.permission("ses_owned_qa", "read", details)).toBe("allow")
    }
    diagnostic = false
    unavailable = true
    expect(await DesktopBridge.permission("ses_owned_qa", "edit", details)).toBe("deny")
  } finally {
    server.stop(true)
    if (previous.url === undefined) delete process.env.BITSBYTES_ENGINE_BRIDGE_URL
    else process.env.BITSBYTES_ENGINE_BRIDGE_URL = previous.url
    if (previous.token === undefined) delete process.env.BITSBYTES_ENGINE_BRIDGE_TOKEN
    else process.env.BITSBYTES_ENGINE_BRIDGE_TOKEN = previous.token
    await rm(directory, { recursive: true, force: true })
  }
})
