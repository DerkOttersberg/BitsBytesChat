import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { CustomMcpConfig, CustomMcpEntry, CustomMcpState } from "../bitsbytes/types"

export const MCP_STORED_VALUE = "<stored: leave unchanged to keep>"
const protectedNames = new Set(["bitsbytes-local", "windows-control", "__proto__", "constructor", "prototype"])
type Request = (path: string, options?: RequestInit, directory?: string) => Promise<unknown>

// V1 configuration is durable; /mcp add changes only one live workspace.
export class BBMcpSettings {
  private changes = new Map<string, { version: number; config?: CustomMcpConfig; previous?: unknown }>()
  private applied = new Map<string, Map<string, number>>()
  private revision = 0
  private applying = new Map<string, { operation: Promise<void>; revision: number }>()
  private failures = new Map<string, Map<string, { version: number; error: string }>>()
  constructor(
    private path: string,
    private request: Request,
    private directories: () => string[],
  ) {}

  async call(action: string, args: Record<string, unknown>): Promise<CustomMcpState> {
    if (!["list", "save", "remove"].includes(action)) throw new Error("bb.error.unknownMethod")
    const previous = await this.read()
    const servers = record(previous.mcp) ? previous.mcp : {}
    if (action === "list") return this.list(servers)
    const name = serverName(args.name)
    const original = Object.hasOwn(servers, name) ? servers[name] : undefined
    const config = action === "save" ? validateMcpConfig(args.config, original) : undefined
    if (action === "remove" && original === undefined) throw new Error("bb.error.mcpMissing")
    const next = { ...servers }
    if (config) next[name] = config
    else delete next[name]
    await this.write({ ...previous, mcp: next })
    this.changes.set(name, { version: ++this.revision, config, previous: original })
    const failures = await Promise.all(
      [...new Set(this.directories())].map((directory) =>
        this.apply(directory).catch((error) => redactError(error, original, config)),
      ),
    )
    const result = await this.list(next)
    return { ...result, saved: true, error: failures.find((value) => value !== undefined) ?? result.error }
  }

  apply(directory: string): Promise<void> {
    const pending = this.applying.get(directory)
    if (pending)
      return (pending.revision < this.revision ? pending.operation.catch(() => undefined) : pending.operation).then(
        () => this.apply(directory),
      )
    if (
      ![...this.changes].some(
        ([name, change]) =>
          this.applied.get(directory)?.get(name) !== change.version &&
          this.failures.get(directory)?.get(name)?.version !== change.version,
      )
    )
      return Promise.resolve()
    const operation = this.applyChanges(directory).finally(() => this.applying.delete(directory))
    this.applying.set(directory, { operation, revision: this.revision })
    return operation
  }
  private async applyChanges(directory: string) {
    const completed = this.applied.get(directory) ?? new Map<string, number>()
    this.applied.set(directory, completed)
    const results = await Promise.allSettled(
      [...this.changes]
        .filter(
          ([name, change]) =>
            completed.get(name) !== change.version &&
            this.failures.get(directory)?.get(name)?.version !== change.version,
        )
        .map(async ([name, change]) => {
          try {
            const statuses = await this.request("/mcp", {}, directory)
            if (record(statuses) && Object.hasOwn(statuses, name)) {
              await this.request(
                `/mcp/${encodeURIComponent(name)}/disconnect`,
                { method: "POST", signal: AbortSignal.timeout(20000) },
                directory,
              )
            }
            // A disabled entry also replaces the in-memory V1 configuration, so a
            // later native Connect cannot use the former command or secret values.
            const config = change.config ?? { type: "local", command: ["removed"], enabled: false }
            const timeout = Math.max(config.timeout ?? 5000, 15000) + 5000
            const response = await this.request(
              "/mcp",
              { method: "POST", body: JSON.stringify({ name, config }), signal: AbortSignal.timeout(timeout) },
              directory,
            )
            if (record(response) && record(response[name]) && response[name].status === "failed")
              throw new Error(redactError(response[name].error, config))
            completed.set(name, change.version)
            this.failures.get(directory)?.delete(name)
          } catch (error) {
            const failures = this.failures.get(directory) ?? new Map<string, { version: number; error: string }>()
            this.failures.set(directory, failures)
            failures.set(name, { version: change.version, error: redactError(error, change.previous, change.config) })
            throw error
          }
        }),
    )
    const failure = results.find((result) => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
  }

  private async list(servers: Record<string, unknown>): Promise<CustomMcpState> {
    const status = await this.request("/mcp", {}, this.directories()[0]).catch((error) => ({
      failure: redactError(error, ...Object.values(servers)),
    }))
    return {
      servers: Object.entries(servers)
        .filter(([name]) => !protectedNames.has(name))
        .map(([name, value]): CustomMcpEntry => {
          const config = (() => {
            try {
              return validateMcpConfig(value, value)
            } catch {
              return undefined
            }
          })()
          const current = record(status) && record(status[name]) ? status[name] : undefined
          const failed = [...this.failures.values()]
            .map((values) => values.get(name)?.error)
            .find((value) => value !== undefined)
          return {
            name,
            config: config ? redactConfig(config) : undefined,
            status: failed ? "failed" : typeof current?.status === "string" ? current.status : "unknown",
            error:
              failed ??
              (config
                ? typeof current?.error === "string"
                  ? redactError(current.error, value)
                  : undefined
                : "bb.error.mcpConfig"),
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
      error:
        (record(status) && typeof status.failure === "string" ? status.failure : undefined) ??
        [...this.failures.values()].flatMap((values) => [...values.values()].map((value) => value.error))[0],
    }
  }

  private async read(): Promise<Record<string, unknown>> {
    const raw = await readFile(this.path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "{}"
      throw error
    })
    const value: unknown = (() => {
      try {
        return JSON.parse(raw)
      } catch {
        throw new Error("bb.error.mcpConfig")
      }
    })()
    if (!record(value) || (value.mcp !== undefined && !record(value.mcp))) throw new Error("bb.error.mcpConfig")
    return value
  }
  private async write(value: Record<string, unknown>) {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.mcp-${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" })
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}

export function serverName(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) || protectedNames.has(value))
    throw new Error("bb.error.mcpName")
  return value
}

export function validateMcpConfig(value: unknown, previous?: unknown): CustomMcpConfig {
  if (!record(value) || !["local", "remote"].includes(String(value.type))) throw new Error("bb.error.mcpConfig")
  const common = ["type", "enabled", "timeout"]
  const allowed =
    value.type === "local" ? [...common, "command", "environment"] : [...common, "url", "headers", "oauth"]
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    (value.enabled !== undefined && typeof value.enabled !== "boolean") ||
    (value.timeout !== undefined &&
      (!Number.isInteger(value.timeout) || Number(value.timeout) < 1000 || Number(value.timeout) > 120000))
  )
    throw new Error("bb.error.mcpConfig")
  const basic = { enabled: value.enabled as boolean | undefined, timeout: value.timeout as number | undefined }
  if (value.type === "local") {
    if (
      !Array.isArray(value.command) ||
      !value.command.length ||
      value.command.length > 64 ||
      !value.command.every((item) => text(item, 8192)) ||
      !value.command[0].trim()
    )
      throw new Error("bb.error.mcpConfig")
    return {
      type: "local",
      command: value.command,
      ...basic,
      environment: stringValues(value.environment, record(previous) ? previous.environment : undefined),
    }
  }
  if (!text(value.url, 8192)) throw new Error("bb.error.mcpConfig")
  const url = (() => {
    try {
      return new URL(value.url as string)
    } catch {
      return undefined
    }
  })()
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("bb.error.mcpConfig")
  const oauth = value.oauth
  if (oauth !== undefined && oauth !== false && !record(oauth)) throw new Error("bb.error.mcpConfig")
  if (
    record(oauth) &&
    (Object.keys(oauth).some(
      (key) => !["clientId", "clientSecret", "scope", "callbackPort", "redirectUri"].includes(key),
    ) ||
      ["clientId", "clientSecret", "scope", "redirectUri"].some(
        (key) => oauth[key] !== undefined && !text(oauth[key], 8192),
      ) ||
      (oauth.callbackPort !== undefined &&
        (!Number.isInteger(oauth.callbackPort) ||
          Number(oauth.callbackPort) < 1 ||
          Number(oauth.callbackPort) > 65535)))
  )
    throw new Error("bb.error.mcpConfig")
  const oldOAuth = record(previous) && record(previous.oauth) ? previous.oauth : undefined
  const secret = record(oauth) ? storedValue(oauth.clientSecret, oldOAuth?.clientSecret) : undefined
  const settings = record(oauth)
    ? ({ ...oauth, clientSecret: secret } as Exclude<CustomMcpConfig, { type: "local" }>["oauth"])
    : oauth
  return {
    type: "remote",
    url: value.url,
    ...basic,
    headers: stringValues(value.headers, record(previous) ? previous.headers : undefined, true),
    oauth: settings as Exclude<CustomMcpConfig, { type: "local" }>["oauth"],
  }
}

function stringValues(value: unknown, previous: unknown, header = false) {
  if (value === undefined) return undefined
  if (!record(value) || Object.keys(value).length > 64) throw new Error("bb.error.mcpConfig")
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(key) || !text(item, 16384) || (header && /[\r\n]/.test(item)))
        throw new Error("bb.error.mcpConfig")
      return [key, storedValue(item, record(previous) && Object.hasOwn(previous, key) ? previous[key] : undefined)!]
    }),
  )
}
function storedValue(value: unknown, previous: unknown) {
  if ((value === MCP_STORED_VALUE || value === "") && typeof previous === "string") return previous
  if (value === MCP_STORED_VALUE) throw new Error("bb.error.mcpConfig")
  return value as string | undefined
}
function redactConfig(config: CustomMcpConfig): CustomMcpConfig {
  if (config.type === "local")
    return {
      ...config,
      environment: config.environment
        ? Object.fromEntries(Object.keys(config.environment).map((key) => [key, MCP_STORED_VALUE]))
        : undefined,
    }
  return {
    ...config,
    headers: config.headers
      ? Object.fromEntries(Object.keys(config.headers).map((key) => [key, MCP_STORED_VALUE]))
      : undefined,
    oauth: config.oauth
      ? { ...config.oauth, clientSecret: config.oauth.clientSecret === undefined ? undefined : MCP_STORED_VALUE }
      : config.oauth,
  }
}
function redactError(error: unknown, ...configs: unknown[]) {
  const secrets = configs
    .flatMap((config) =>
      record(config)
        ? [
            ...(record(config.environment) ? Object.values(config.environment) : []),
            ...(record(config.headers) ? Object.values(config.headers) : []),
            ...authorizationSecrets(config.headers),
            ...(record(config.oauth) ? [config.oauth.clientSecret] : []),
          ]
        : [],
    )
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((a, b) => b.length - a.length)
  return secrets
    .reduce(
      (message, value) =>
        message.split(value).join("[stored value]").split(JSON.stringify(value).slice(1, -1)).join("[stored value]"),
      error instanceof Error ? error.message : String(error),
    )
    .slice(0, 1000)
}

function authorizationSecrets(headers: unknown) {
  if (!record(headers)) return []
  return Object.entries(headers).flatMap(([name, value]) => {
    if (!/^(?:proxy-)?authorization$/i.test(name) || typeof value !== "string") return []
    const credential = /^\s*(Bearer|Basic)[ \t]+([^\s]+)\s*$/i.exec(value)
    if (!credential) return []
    const encoded = credential[2]
    if (credential[1].toLowerCase() === "bearer") return [encoded]
    // Decode only canonical standard Base64 and valid UTF-8 user:password.
    // Keep usernames and unrelated header fragments available in diagnostics.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return [encoded]
    const bytes = Buffer.from(encoded, "base64")
    const standard = bytes.toString("base64")
    if (encoded !== (encoded.includes("=") ? standard : standard.replace(/=+$/, ""))) return [encoded]
    const decoded = bytes.toString("utf8")
    if (!Buffer.from(decoded, "utf8").equals(bytes) || /[\u0000-\u001f\u007f]/.test(decoded)) return [encoded]
    const separator = decoded.indexOf(":")
    return separator < 0 ? [encoded] : [encoded, decoded, decoded.slice(separator + 1)]
  })
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && !value.includes("\0")
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
