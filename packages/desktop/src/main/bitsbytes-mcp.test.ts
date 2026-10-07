import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Schema } from "effect"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { BBMcpSettings, MCP_STORED_VALUE, serverName, validateMcpConfig } from "./bitsbytes-mcp"

const folders: string[] = []
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => {
      if (!folder.startsWith(join(tmpdir(), "bitsbytes-mcp-test-")))
        throw new Error("Cleanup outside owned MCP fixtures")
      return rm(folder, { recursive: true, force: true })
    }),
  )
})
async function fixture(previous: Record<string, unknown> = {}) {
  const folder = await mkdtemp(join(tmpdir(), "bitsbytes-mcp-test-"))
  folders.push(folder)
  const path = join(folder, "opencode.json")
  await writeFile(path, JSON.stringify(previous))
  const calls: { path: string; method?: string; directory?: string; body?: unknown }[] = []
  const statuses: Record<string, { status: string; error?: string }> = {}
  const directories = ["D:\\Test\\main", "D:\\Test\\other"]
  const manager = new BBMcpSettings(
    path,
    async (endpoint, options, directory) => {
      const body: unknown = options?.body ? JSON.parse(String(options.body)) : undefined
      calls.push({ path: endpoint, method: options?.method, directory, body })
      if (endpoint.endsWith("/disconnect")) {
        const name = decodeURIComponent(endpoint.split("/")[2])
        statuses[name] = { status: "disabled" }
        return true
      }
      if (options?.method === "POST" && body && typeof body === "object" && "name" in body && "config" in body) {
        const saved = JSON.parse(await readFile(path, "utf8"))
        const name = String(body.name)
        const config = body.config as { enabled?: boolean; command?: string[] }
        if (config.command?.[0] !== "removed") expect(saved.mcp[name]).toEqual(config)
        statuses[name] = { status: config.enabled === false ? "disabled" : "connected" }
      }
      return structuredClone(statuses)
    },
    () => directories,
  )
  return { manager, path, calls, statuses, directories }
}

test("local and remote settings validate against the actual V1 MCP schema", () => {
  const decode = Schema.decodeUnknownSync(ConfigMCPV1.Info)
  const local = validateMcpConfig({
    type: "local",
    command: ["cmd.exe", "/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"],
    environment: { MODE: "test" },
    enabled: true,
    timeout: 60000,
  })
  const remote = validateMcpConfig({
    type: "remote",
    url: "https://example.test/mcp",
    headers: { Authorization: "Bearer test" },
    enabled: false,
    timeout: 5000,
    oauth: {
      clientId: "id",
      clientSecret: "secret",
      scope: "test",
      callbackPort: 19876,
      redirectUri: "http://127.0.0.1:19876/mcp/oauth/callback",
    },
  })
  expect(decode(local)).toEqual(local)
  expect(decode(remote)).toEqual(remote)
  expect(decode(validateMcpConfig({ type: "remote", url: "http://127.0.0.1/mcp", oauth: false }))).toMatchObject({
    oauth: false,
  })
})

test.each([
  { type: "local", command: [] },
  { type: "local", command: [""] },
  { type: "local", command: ["exe\0"] },
  { type: "local", command: ["exe"], cwd: "D:\\Test" },
  { type: "local", command: ["exe"], disabled: true },
  { type: "local", command: ["exe"], timeout: { request: 5000 } },
  { type: "local", command: ["exe"], timeout: 0 },
  { type: "remote", url: "file:///local" },
  { type: "remote", url: "https://user:password@example.test/mcp" },
  { type: "remote", url: "https://example.test/mcp", headers: { Authorization: "line\nbreak" } },
  { type: "remote", url: "https://example.test/mcp", oauth: { client_secret: "V2 field" } },
  { type: "remote", url: "https://example.test/mcp", oauth: { callbackPort: 65536 } },
])("rejects invalid or unsupported configuration %#", (value) => {
  expect(() => validateMcpConfig(value)).toThrow("bb.error.mcpConfig")
})

test("protected and unsafe names cannot replace built-in tools", () => {
  for (const name of [
    "bitsbytes-local",
    "windows-control",
    "__proto__",
    "constructor",
    "prototype",
    "name/with/path",
    "123server",
    "my.server",
  ])
    expect(() => serverName(name)).toThrow("bb.error.mcpName")
  expect(serverName("Roblox_Studio")).toBe("Roblox_Studio")
})

test("save preserves unrelated configuration and persists before live additions", async () => {
  const f = await fixture({
    provider: { fixture: { options: { apiKey: "fixture-only" } } },
    permission: { read: "allow" },
    mcp: { "bitsbytes-local": { enabled: true } },
  })
  const result = await f.manager.call("save", {
    name: "Roblox_Studio",
    config: { type: "local", command: ["cmd.exe", "/c", "test.bat"], enabled: false },
  })
  expect(result.saved).toBe(true)
  expect(JSON.parse(await readFile(f.path, "utf8"))).toMatchObject({
    provider: { fixture: { options: { apiKey: "fixture-only" } } },
    permission: { read: "allow" },
    mcp: { "bitsbytes-local": { enabled: true }, Roblox_Studio: { enabled: false } },
  })
  expect(f.calls.filter((call) => call.method === "POST").map((call) => call.directory)).toEqual(f.directories)
  expect(f.calls.some((call) => call.path.includes("dispose"))).toBe(false)
})

test("replacement explicitly disconnects each known workspace before adding", async () => {
  const f = await fixture({ mcp: { tools: { type: "local", command: ["old"], enabled: true } } })
  f.statuses.tools = { status: "connected" }
  await f.manager.call("save", { name: "tools", config: { type: "local", command: ["new"], enabled: true } })
  for (const directory of f.directories)
    expect(
      f.calls.filter((call) => call.directory === directory && call.method === "POST").map((call) => call.path),
    ).toEqual(["/mcp/tools/disconnect", "/mcp"])
})

test("secrets stay hidden and placeholders or blank values preserve saved values", async () => {
  const original = {
    type: "remote",
    url: "https://example.test/mcp",
    headers: { Authorization: "Bearer fixture-secret" },
    oauth: { clientId: "public-id", clientSecret: "fixture-oauth-secret" },
  }
  const f = await fixture({ mcp: { tools: original } })
  const listed = await f.manager.call("list", {})
  expect(JSON.stringify(listed)).not.toContain("fixture-secret")
  expect(JSON.stringify(listed)).not.toContain("fixture-oauth-secret")
  const config = listed.servers[0].config
  expect(config?.type).toBe("remote")
  if (config?.type !== "remote" || !config.oauth) throw new Error("Expected remote config")
  expect(config.headers?.Authorization).toBe(MCP_STORED_VALUE)
  await f.manager.call("save", {
    name: "tools",
    config: { ...config, headers: { Authorization: "" }, oauth: { ...config.oauth, clientSecret: "" }, timeout: 10000 },
  })
  expect(JSON.parse(await readFile(f.path, "utf8")).mcp.tools).toMatchObject({
    headers: original.headers,
    oauth: original.oauth,
    timeout: 10000,
  })
  expect(() =>
    validateMcpConfig({ type: "local", command: ["exe"], environment: { TOKEN: MCP_STORED_VALUE } }),
  ).toThrow()
})

test("remove persists deletion then disconnects and disables old live entries", async () => {
  const f = await fixture({ mcp: { tools: { type: "local", command: ["old"], enabled: true } } })
  f.statuses.tools = { status: "connected" }
  await f.manager.call("remove", { name: "tools" })
  expect(JSON.parse(await readFile(f.path, "utf8")).mcp.tools).toBeUndefined()
  expect(f.statuses.tools.status).toBe("disabled")
  expect(f.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
    "/mcp/tools/disconnect",
    "/mcp/tools/disconnect",
    "/mcp",
    "/mcp",
  ])
})

test("bad persisted JSON remains intact and causes no live changes", async () => {
  const f = await fixture()
  await writeFile(f.path, "broken config")
  await expect(f.manager.call("save", { name: "tools", config: { type: "local", command: ["new"] } })).rejects.toThrow(
    "bb.error.mcpConfig",
  )
  expect(await readFile(f.path, "utf8")).toBe("broken config")
  expect(f.calls).toHaveLength(0)
})

test("an unreadable configuration cannot connect or disconnect a server", async () => {
  const f = await fixture()
  await rm(f.path)
  await mkdir(f.path)
  await expect(f.manager.call("save", { name: "tools", config: { type: "local", command: ["new"] } })).rejects.toThrow()
  expect(f.calls).toHaveLength(0)
})

test("failed lifecycle updates stay saved and visible without exposing stored secrets", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bitsbytes-mcp-test-"))
  folders.push(folder)
  const path = join(folder, "opencode.json")
  const manager = new BBMcpSettings(
    path,
    async (_endpoint, options) => {
      if (options?.method === "POST") throw new Error("Connection rejected Bearer fixture-sensitive-value")
      return {}
    },
    () => ["D:\\Main"],
  )
  const value = await manager.call("save", {
    name: "tools",
    config: {
      type: "remote",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer fixture-sensitive-value" },
    },
  })
  expect(value.saved).toBe(true)
  expect(value.servers[0].status).toBe("failed")
  expect(value.error).toContain("Connection rejected [stored value]")
  expect(JSON.stringify(value)).not.toContain("fixture-sensitive-value")
  expect(JSON.parse(await readFile(path, "utf8")).mcp.tools.headers.Authorization).toBe(
    "Bearer fixture-sensitive-value",
  )
  const refreshed = await manager.call("list", {})
  expect(refreshed.servers[0].status).toBe("failed")
  expect(refreshed.error).toBe(value.error)
})

test.each([
  { name: "Authorization", value: "Bearer fixture-token-only", echo: "fixture-token-only", diagnostic: "HTTP 401" },
  {
    name: "proxy-authorization",
    value: "bEaReR fixture-proxy-token",
    echo: "fixture-proxy-token",
    diagnostic: "proxy HTTP 407",
  },
  {
    name: "AUTHORIZATION",
    value: "Basic " + Buffer.from("fixture-user:fixture-password").toString("base64"),
    echo: Buffer.from("fixture-user:fixture-password").toString("base64"),
    diagnostic: "HTTP 401",
  },
  {
    name: "Proxy-Authorization",
    value: "Basic " + Buffer.from("fixture-user:fixture-password").toString("base64"),
    echo: "fixture-password",
    diagnostic: "user fixture-user HTTP 407",
  },
  {
    name: "Authorization",
    value: "Basic " + Buffer.from("fixture-user:fixture-password:tail").toString("base64"),
    echo: "fixture-user:fixture-password:tail",
    diagnostic: "HTTP 401",
  },
  {
    name: "Authorization",
    value: "Basic " + Buffer.from('fixture-user:fixture"password\\tail').toString("base64"),
    echo: JSON.stringify('fixture"password\\tail').slice(1, -1),
    diagnostic: "user fixture-user HTTP 401",
  },
])(
  "standard authorization component echoes stay hidden while diagnostics remain (%#)",
  async ({ name, value, echo, diagnostic }) => {
    const folder = await mkdtemp(join(tmpdir(), "bitsbytes-mcp-test-"))
    folders.push(folder)
    const path = join(folder, "opencode.json")
    const manager = new BBMcpSettings(
      path,
      async (_endpoint, options) => {
        if (options?.method === "POST") throw new Error(`Rejected credential ${echo}; ${diagnostic}`)
        return {}
      },
      () => ["D:\\Main"],
    )
    const result = await manager.call("save", {
      name: "tools",
      config: { type: "remote", url: "https://example.test/mcp", headers: { [name]: value } },
    })
    expect(result.error).toBe(`Rejected credential [stored value]; ${diagnostic}`)
    expect(JSON.stringify(result)).not.toContain(echo)
    expect(JSON.parse(await readFile(path, "utf8")).mcp.tools.headers[name]).toBe(value)
    expect((await manager.call("list", {})).error).toBe(result.error)
  },
)

test("authorization parsing does not guess secrets from unrelated headers or Basic usernames", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bitsbytes-mcp-test-"))
  folders.push(folder)
  const manager = new BBMcpSettings(
    join(folder, "opencode.json"),
    async (_endpoint, options) => {
      if (options?.method === "POST") throw new Error("Retry fixture-user HTTP 401; next retry; diagnostic Bearer retry")
      return {}
    },
    () => ["D:\\Main"],
  )
  const result = await manager.call("save", {
    name: "tools",
    config: {
      type: "remote",
      url: "https://example.test/mcp",
      headers: {
        Authorization: "Basic " + Buffer.from("fixture-user:fixture-password").toString("base64"),
        "X-Diagnostics": "Bearer retry",
      },
    },
  })
  expect(result.error).toBe("Retry fixture-user HTTP 401; next retry; diagnostic [stored value]")
})

test("unchanged failed optional servers do not retry during later prompt preparation", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bitsbytes-mcp-test-"))
  folders.push(folder)
  let attempts = 0
  const manager = new BBMcpSettings(
    join(folder, "opencode.json"),
    async (_endpoint, options) => {
      if (options?.method === "POST") {
        attempts++
        throw new Error("Optional connection unavailable")
      }
      return {}
    },
    () => ["D:\\Main"],
  )
  const args = { name: "tools", config: { type: "local", command: ["missing"], enabled: true } }
  await manager.call("save", args)
  expect(attempts).toBe(1)
  await Promise.all([manager.apply("D:\\Main"), manager.apply("D:\\Main")])
  await manager.apply("D:\\Main")
  expect(attempts).toBe(1)
  expect((await manager.call("list", {})).servers[0].status).toBe("failed")
  await manager.call("save", args)
  expect(attempts).toBe(2)
})

test("a failed server does not prevent adding another custom server", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bitsbytes-mcp-test-"))
  folders.push(folder)
  const added: string[] = []
  const manager = new BBMcpSettings(
    join(folder, "opencode.json"),
    async (_endpoint, options) => {
      if (!options?.body) return {}
      const request = JSON.parse(String(options.body)) as { name: string }
      added.push(request.name)
      if (request.name === "bad") throw new Error("Optional connection unavailable")
      return { [request.name]: { status: "connected" } }
    },
    () => ["D:\\Main"],
  )
  await manager.call("save", { name: "bad", config: { type: "local", command: ["bad"] } })
  await manager.call("save", { name: "good", config: { type: "local", command: ["good"] } })
  expect(added).toEqual(["bad", "good"])
})

test("later directories apply saved changes once and concurrent dispatches share application", async () => {
  const f = await fixture()
  await f.manager.call("save", { name: "tools", config: { type: "local", command: ["exe"], enabled: false } })
  f.calls.splice(0)
  await Promise.all([f.manager.apply("D:\\Later"), f.manager.apply("D:\\Later"), f.manager.apply("D:\\Later")])
  expect(f.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
    "/mcp/tools/disconnect",
    "/mcp",
  ])
  f.calls.splice(0)
  await f.manager.apply("D:\\Later")
  expect(f.calls).toHaveLength(0)
})
