import { createServer, type Server } from "node:https"
import type { IncomingMessage, ServerResponse } from "node:http"
import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto"
import { networkInterfaces } from "node:os"
import { mkdir, readFile, writeFile, rename, readdir, stat, open } from "node:fs/promises"
import { join, extname } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createRequire } from "node:module"
import { dirname } from "node:path"
import type { BitsBytes } from "./bitsbytes"
import type { Job } from "../bitsbytes/types"
import { mobileCopy } from "../bitsbytes/mobile-copy"
import { bbError } from "../bitsbytes/copy"
import { mobileAddresses, mobileLocalIP, type MobileAdapter } from "./bitsbytes-mobile-network"
import { readState, stateRecord } from "./bitsbytes-state"

type Device = { id: string; name: string; token: string; expires: number; seen: number }
type Pair = { id: string; secret: string; name: string; expires: number; status: "pending" | "approved" | "rejected" }
type Upload = {
  id: string
  device: string
  name: string
  size: number
  sessionID: string
  fingerprint: string
  chunks: { offset: number; length: number; hash: string }[]
  status: string
  jobID?: string
  error: string
}
type Host = Pick<
  BitsBytes,
  "root" | "assets" | "engineFetch" | "call" | "rpc" | "skills" | "artifacts" | "settings" | "runs"
>
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const safeID = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error(mobileCopy.invalid)
  return value
}
export class BBMobile {
  private server?: Server
  private enabled = false
  private port = 24483
  private error = ""
  private certificate = ""
  private devices: Device[] = []
  private pairs = new Map<string, Pair>()
  private invitation?: { hash: string; expires: number }
  private processing = new Set<string>()
  private uploadLocks = new Set<string>()
  private saving = Promise.resolve()
  private adapters: MobileAdapter[] = []
  private networkChecked = 0
  private networkPending?: Promise<void>
  private preferredAddress = ""
  constructor(
    private host: Host,
    private changed: () => void,
    private seal: (value: string) => string,
    private unseal: (value: string) => string,
  ) {}
  private folder() {
    return join(this.host.root, "mobile")
  }
  private ips() {
    return mobileAddresses(networkInterfaces(), this.adapters).map((row) => row.address)
  }
  private async refreshNetwork() {
    if (process.platform !== "win32" || Date.now() - this.networkChecked < 30000) return
    if (this.networkPending) return this.networkPending
    this.networkPending = promisify(execFile)(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(this.host.assets, "mobile/network.ps1")],
      { windowsHide: true, timeout: 5000, maxBuffer: 256000, encoding: "utf8" },
    )
      .then(({ stdout }) => {
        const value: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ""))
        if (!Array.isArray(value)) return
        this.adapters = value.filter((row): row is MobileAdapter =>
          typeof row?.name === "string" && typeof row.hardware === "boolean" && typeof row.up === "boolean" &&
          (row.metric === null || (typeof row.metric === "number" && Number.isFinite(row.metric))),
        )
      })
      // Network metadata is optional; the portable fallback still puts known VPNs last.
      .catch(() => undefined)
      .finally(() => {
        this.networkChecked = Date.now()
        this.networkPending = undefined
      })
    return this.networkPending
  }
  state() {
    const addresses = mobileAddresses(networkInterfaces(), this.adapters).map((row) => ({
      ...row,
      url: `https://${row.address}:${this.port}`,
    }))
    return {
      enabled: Boolean(this.server),
      port: this.port,
      error: this.error,
      fingerprint: this.certificate,
      urls: addresses.map((row) => row.url),
      addresses,
      preferredURL: addresses.find((row) => row.address === this.preferredAddress)?.url ?? addresses[0]?.url ?? "",
      devices: this.devices
        .filter((device) => device.expires > Date.now())
        .map(({ id, name, seen, expires }) => ({ id, name, seen, expires })),
      requests: [...this.pairs.values()]
        .filter((pair) => pair.status === "pending" && pair.expires > Date.now())
        .map(({ id, name }) => ({ id, name })),
    }
  }
  async start() {
    await mkdir(join(this.folder(), "uploads"), { recursive: true })
    const saved = await readState<{ port?: number; enabled?: boolean; address?: string; devices?: Device[] }>(this.folder(), "settings.json", {}, value => stateRecord(value)
      && (value.enabled === undefined || typeof value.enabled === "boolean")
      && (value.port === undefined || (Number.isInteger(value.port) && Number(value.port) > 0 && Number(value.port) <= 65535))
      && (value.address === undefined || typeof value.address === "string")
      && (value.devices === undefined || (Array.isArray(value.devices) && value.devices.every(device => stateRecord(device)
        && typeof device.id === "string" && typeof device.name === "string" && typeof device.token === "string"
        && Number.isFinite(device.expires) && Number.isFinite(device.seen)))))
    this.port = Number(saved.port) || this.port
    this.devices = saved.devices ?? []
    this.preferredAddress = typeof saved.address === "string" ? saved.address : ""
    if (saved.enabled) await this.refreshNetwork()
    if (saved.enabled)
      await this.listen().catch((error) => {
        this.error = String(error.message)
        this.changed()
      })
  }
  private save() {
    this.saving = this.saving
      .catch(() => undefined)
      .then(async () => {
        const target = join(this.folder(), "settings.json")
        await writeFile(
          target + ".tmp",
          JSON.stringify({ enabled: this.enabled, port: this.port, devices: this.devices, address: this.preferredAddress }),
        )
        await rename(target + ".tmp", target)
      })
    return this.saving
  }
  async call(action: string, args: Record<string, unknown> = {}) {
    if (action === "state") {
      if (this.server) void this.refreshNetwork()
      return this.state()
    }
    if (action === "enable") {
      const port = Number(args.port ?? this.port)
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(mobileCopy.invalid)
      this.close()
      this.port = port
      await this.refreshNetwork()
      await this.listen()
      await this.save()
    }
    if (action === "disable") {
      this.close()
      this.enabled = false
      await this.save()
    }
    if (action === "pair") {
      if (!this.server) throw new Error(mobileCopy.disabled)
      await this.refreshNetwork()
      const secret = randomBytes(32).toString("base64url")
      this.invitation = { hash: digest(secret), expires: Date.now() + 300000 }
      return { ...this.state(), token: secret, expires: this.invitation.expires }
    }
    if (action === "address") {
      const selected = this.state().addresses.find((row) => row.url === args.url)
      if (!selected) throw new Error(mobileCopy.invalid)
      this.preferredAddress = selected.address
      await this.save()
    }
    if (action === "approve" || action === "reject") {
      const pair = this.pairs.get(String(args.id))
      if (!pair || pair.expires < Date.now() || pair.status !== "pending") throw new Error(mobileCopy.expired)
      pair.status = action === "approve" ? "approved" : "rejected"
    }
    if (action === "revoke") {
      this.devices = this.devices.filter((device) => device.id !== args.id)
      await this.save()
    }
    this.changed()
    return this.state()
  }
  close() {
    this.invitation = undefined
    this.pairs.clear()
    this.server?.closeAllConnections()
    this.server?.close()
    this.server = undefined
  }
  private async listen() {
    const pfx = join(this.folder(), "host.pfx"),
      secrets = join(this.folder(), "tls.json")
    const saved = JSON.parse(await readFile(secrets, "utf8").catch(() => "null")) as { password: string } | null
    const password = saved ? this.unseal(saved.password) : randomBytes(32).toString("base64url")
    const certificate = await readFile(pfx + ".cer")
      .then((bytes) => new X509Certificate(bytes))
      .catch(() => undefined)
    if (
      !saved ||
      !certificate ||
      new Date(certificate.validTo).getTime() < Date.now() + 86400000 ||
      this.ips().some((ip) => !certificate.checkIP(ip))
    ) {
      await promisify(execFile)(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(this.host.assets, "mobile/certificate.ps1")],
        {
          windowsHide: true,
          env: {
            ...process.env,
            BITSBYTES_CERT_IPS: ["127.0.0.1", ...this.ips()].join(","),
            BITSBYTES_CERT_PATH: pfx,
            BITSBYTES_CERT_PASSWORD: password,
          },
          timeout: 30000,
        },
      ).catch(() => {
        throw new Error(mobileCopy.certError)
      })
      await writeFile(secrets, JSON.stringify({ password: this.seal(password) }))
    }
    this.certificate = new X509Certificate(await readFile(pfx + ".cer")).fingerprint256
    const server = createServer(
      { pfx: await readFile(pfx), passphrase: password, minVersion: "TLSv1.2" },
      (request, response) => {
        void this.handle(request, response).catch((error) => {
          if (!response.headersSent)
            this.json(response, { error: error instanceof Error ? error.message : mobileCopy.error }, 400)
          else response.end()
        })
      },
    )
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => reject(new Error(mobileCopy.portError)))
      server.listen(this.port, "0.0.0.0", resolve)
    })
    this.server = server
    this.enabled = true
    this.error = ""
    this.changed()
    for (const file of await readdir(join(this.folder(), "uploads")))
      if (file.endsWith(".json")) {
        const upload = JSON.parse(await readFile(join(this.folder(), "uploads", file), "utf8")) as Upload
        if (upload.status === "processing") void this.process(upload)
      }
  }
  private json(response: ServerResponse, value: unknown, status = 200) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
    response.end(JSON.stringify(value))
  }
  private async body(request: IncomingMessage, limit = 2e6) {
    const buffers: Buffer[] = []
    let size = 0
    for await (const buffer of request) {
      size += buffer.length
      if (size > limit) throw new Error(mobileCopy.tooLarge)
      buffers.push(buffer)
    }
    return Buffer.concat(buffers)
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("x-content-type-options", "nosniff")
    response.setHeader("referrer-policy", "no-referrer")
    response.setHeader("x-frame-options", "DENY")
    if (!mobileLocalIP(request.socket.remoteAddress ?? "")) {
      this.json(response, { error: mobileCopy.unauthorised }, 403)
      return
    }
    const host = request.headers.host ?? "",
      hostIP = host.split(":")[0]
    if (!["localhost", "127.0.0.1", ...this.ips()].includes(hostIP) || host.split(":")[1] !== String(this.port)) {
      this.json(response, { error: mobileCopy.unauthorised }, 403)
      return
    }
    const url = new URL(request.url ?? "/", `https://${host}`)
    if (request.method !== "GET" && request.headers.origin !== `https://${host}`) {
      this.json(response, { error: mobileCopy.unauthorised }, 403)
      return
    }
    if (
      request.method === "GET" &&
      (["/", "/app.js", "/audio.js", "/style.css", "/copy.js", "/pdf.mjs", "/pdf.worker.mjs"].includes(url.pathname) ||
        /^\/pdf-assets\/(cmaps|standard_fonts)\/[a-zA-Z0-9_.-]+$/.test(url.pathname))
    ) {
      response.setHeader("cache-control", "no-store")
      response.setHeader(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      )
      const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
      response.setHeader(
        "content-type",
        path.startsWith("pdf-assets/")
          ? "application/octet-stream"
          : path.endsWith("html")
            ? "text/html; charset=utf-8"
            : path.endsWith("css")
              ? "text/css"
              : "text/javascript",
      )
      const pdf = path.endsWith(".mjs") || path.startsWith("pdf-assets/")
      const source = pdf
        ? join(
            dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")),
            path.startsWith("pdf-assets/") ? path.slice(11) : "build/" + path,
          )
        : join(this.host.assets, "mobile", path)
      response.end(
        path === "copy.js"
          ? `window.BB_COPY=${JSON.stringify(mobileCopy).replaceAll("<", "\\u003c")}`
          : await readFile(source),
      )
      return
    }
    const input =
      request.method === "POST"
        ? (JSON.parse((await this.body(request)).toString() || "{}") as Record<string, unknown>)
        : {}
    if (url.pathname === "/pair" && request.method === "POST") {
      if (
        !this.invitation ||
        this.invitation.expires < Date.now() ||
        digest(String(input.token)) !== this.invitation.hash
      ) {
        this.json(response, { error: mobileCopy.expired }, 401)
        return
      }
      this.invitation = undefined
      const pair: Pair = {
        id: randomUUID(),
        secret: randomBytes(32).toString("base64url"),
        name: String(input.name || mobileCopy.phone).slice(0, 80),
        expires: Date.now() + 300000,
        status: "pending",
      }
      this.pairs.set(pair.id, pair)
      this.changed()
      this.json(response, { id: pair.id, secret: pair.secret })
      return
    }
    if (url.pathname.startsWith("/pair/") && request.method === "GET") {
      const pair = this.pairs.get(url.pathname.slice(6))
      if (!pair || pair.secret !== request.headers.authorization?.slice(7) || pair.expires < Date.now()) {
        this.json(response, { error: mobileCopy.expired }, 401)
        return
      }
      if (pair.status === "approved") {
        const token = randomBytes(32).toString("base64url")
        this.devices.push({
          id: pair.id,
          name: pair.name,
          token: digest(token),
          expires: Date.now() + 30 * 86400000,
          seen: Date.now(),
        })
        this.pairs.delete(pair.id)
        await this.save()
        response.setHeader(
          "set-cookie",
          `bb_mobile=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`,
        )
        this.changed()
      }
      this.json(response, { status: pair.status })
      return
    }
    const cookie = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("bb_mobile="))
      ?.slice(10)
    const device = cookie
      ? this.devices.find((device) => device.token === digest(cookie) && device.expires > Date.now())
      : undefined
    if (!device) {
      this.json(response, { error: mobileCopy.unauthorised }, 401)
      return
    }
    device.seen = Date.now()
    if (url.pathname === "/logout" && request.method === "POST") {
      await this.call("revoke", { id: device.id })
      response.setHeader("set-cookie", "bb_mobile=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0")
      this.json(response, {})
      return
    }
    if (url.pathname.startsWith("/upload")) {
      await this.upload(request, response, url, input, device)
      return
    }
    if (url.pathname.startsWith("/file/")) {
      await this.file(response, url)
      return
    }
    if (url.pathname.startsWith("/html/") && request.method === "GET") {
      const id = safeID(url.pathname.slice(6)),
        item = this.host.artifacts.items.find((item) => item.id === id)
      if (item?.kind !== "html") throw new Error(mobileCopy.missing)
      const content = (await this.host.artifacts.content(id, {
        revision: Number(url.searchParams.get("revision")) || undefined,
      })) as { text: string }
      response.setHeader("x-frame-options", "SAMEORIGIN")
      response.setHeader(
        "content-security-policy",
        "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
      )
      response.setHeader("content-type", "text/html; charset=utf-8")
      response.end(content.text)
      return
    }
    if (url.pathname !== "/api" || request.method !== "POST") {
      this.json(response, { error: mobileCopy.missing }, 404)
      return
    }
    this.json(response, await this.api(String(input.method), (input.args ?? {}) as Record<string, unknown>))
  }
  private async api(method: string, args: Record<string, unknown>) {
    const id = args.sessionID ? safeID(args.sessionID) : ""
    if (method === "overview") {
      const [chats, catalog, config, skills] = await Promise.all([
        this.host.engineFetch<{ id: string; title: string }[]>("/experimental/session?limit=1000"),
        this.host.engineFetch<{
          all: {
            id: string
            name: string
            models: Record<string, { id: string; name: string; variants?: Record<string, unknown> }>
          }[]
          connected: string[]
        }>("/provider"),
        this.host.engineFetch<{ model?: string }>("/config"),
        this.host.skills(),
      ])
      return {
        chats: chats.map((chat) => ({ id: chat.id, title: chat.title })),
        models: catalog.all
          .filter((provider) => catalog.connected.includes(provider.id))
          .flatMap((provider) =>
            Object.values(provider.models).map((model) => ({
              providerID: provider.id,
              provider: provider.name,
              id: model.id,
              name: model.name,
              variants: Object.keys(model.variants ?? {}),
            })),
          ),
        model: config.model,
        skills: skills
          .filter((skill) => skill.enabled)
          .map(({ id, name, revision, defaultPrompt }) => ({ id, name, revision, defaultPrompt })),
        engine: this.host.settings.engine,
      }
    }
    if (method === "create") {
      const chat = await this.host.engineFetch<{ id: string }>("/session", {
        method: "POST",
        body: JSON.stringify({ title: String(args.title || mobileCopy.newChat).slice(0, 100) }),
      })
      await this.host.call("access.set", { sessionID: chat.id, mode: "ask" })
      return chat
    }
    if (
      !id &&
      !["skill", "artifacts", "jobs", "transcript", "transcript-reference", "content", "preview-retry"].includes(method)
    )
      throw new Error(mobileCopy.invalid)
    if (method === "chat") {
      const session = await this.host.engineFetch<{ directory: string; title: string }>(`/session/${id}`)
      const [messages, status, access, permissions, questions] = await Promise.all([
        this.host.engineFetch<
          {
            info: Record<string, unknown>
            parts: { type: string; url?: string; synthetic?: boolean; ignored?: boolean }[]
          }[]
        >(`/session/${id}/message`, {}, session.directory),
        this.host.engineFetch<Record<string, unknown>>("/session/status", {}, session.directory),
        this.host.call("access.get", { sessionID: id }),
        this.host.engineFetch<{ sessionID: string }[]>("/permission", {}, session.directory),
        this.host.engineFetch<{ sessionID: string }[]>("/question", {}, session.directory),
      ])
      return {
        title: session.title,
        // The phone only needs visible message parts. Full attachment context stays
        // in the shared engine, rather than being retransmitted on every poll.
        messages: messages.map((row) => ({
          info: row.info,
          parts: row.parts.filter(
            (part) =>
              (part.type === "text" && !part.synthetic && !part.ignored) ||
              (part.type === "file" && part.url?.startsWith("bitsbytes://")),
          ),
        })),
        status: status[id],
        access,
        run: this.host.runs.get(id),
        permissions: permissions.filter((row) => row.sessionID === id),
        questions: questions.filter((row) => row.sessionID === id),
      }
    }
    if (method === "skill")
      return this.host.call("attachment.read", {
        uri: `bitsbytes://skill/${safeID(args.id)}?revision=${Number(args.revision)}`,
      })
    if (method === "jobs") {
      const jobs = await this.host.rpc<Job[]>("jobs")
      return jobs.map(({ id, title, status, duration, sessionID, error }) => ({
        id,
        title,
        status,
        duration,
        sessionID,
        error,
      }))
    }
    if (method === "transcript-reference") return this.host.call("transcript.snapshot", { id: safeID(args.id) })
    if (method === "transcript")
      return args.revision
        ? this.host.call("attachment.read", {
            uri: `bitsbytes://transcript/${safeID(args.id)}?revision=${Number(args.revision)}`,
          })
        : this.host.rpc<Job>("job", { id: safeID(args.id) }).then(({ transcript }) => ({ text: transcript }))
    if (method === "artifacts")
      return this.host.artifacts.items
        .filter((item) => !id || item.sessionID === id)
        .map(({ id, sessionID, filename, revision, kind, status, error, history, turnIDs, turnID }) => ({
          id,
          sessionID,
          filename,
          revision,
          kind,
          status,
          error,
          turnIDs,
          turnID,
          versions: history?.map(({ revision, turnID }) => ({ revision, turnID })),
        }))
    if (method === "content")
      return this.host.artifacts.content(safeID(args.id), {
        revision: Number(args.revision) || undefined,
        sheet: args.sheet,
        offset: Number(args.offset) || 0,
      })
    if (method === "preview-retry") return this.host.artifacts.retry(safeID(args.id))
    if (method === "access") return this.host.call("access.set", { sessionID: id, mode: args.mode })
    if (method === "stop") {
      const session = await this.host.engineFetch<{ directory: string }>(`/session/${id}`)
      await this.host.call("runs.stop", { sessionID: id })
      return this.host.engineFetch(`/session/${id}/abort`, { method: "POST" }, session.directory)
    }
    if (method === "resume") return this.host.call("runs.resume", { sessionID: id })
    if (method === "permission" || method === "question") {
      const session = await this.host.engineFetch<{ directory: string }>(`/session/${id}`)
      const endpoint = method === "permission" ? "permission" : "question"
      const pending = await this.host.engineFetch<{ id: string; sessionID: string }[]>(
        "/" + endpoint,
        {},
        session.directory,
      )
      if (!pending.some((row) => row.id === args.id && row.sessionID === id)) throw new Error(mobileCopy.missing)
      if (method === "permission" && args.reply !== "once" && args.reply !== "reject")
        throw new Error(mobileCopy.invalid)
      return this.host.engineFetch(
        `/${endpoint}/${safeID(args.id)}/reply`,
        {
          method: "POST",
          body: JSON.stringify(method === "permission" ? { reply: args.reply } : { answers: args.answers }),
        },
        session.directory,
      )
    }
    if (method === "send") return this.send(id, args)
    throw new Error(mobileCopy.invalid)
  }
  private async send(sessionID: string, args: Record<string, unknown>) {
    const session = await this.host.engineFetch<{ directory: string }>(`/session/${sessionID}`)
    const overview = (await this.api("overview", {})) as { models: { providerID: string; id: string }[] }
    const model = args.model as { providerID: string; modelID: string }
    if (!overview.models.some((row) => row.providerID === model?.providerID && row.id === model.modelID))
      throw new Error(mobileCopy.unknownModel)
    const text = String(args.text ?? "").trim(),
      parts: { type: string; text?: string; mime?: string; filename?: string; url?: string }[] = []
    if (text.length > 100000) throw new Error(mobileCopy.tooLarge)
    const skills = Array.isArray(args.skills) ? (args.skills as { id: string; revision: number }[]) : []
    const enabled = await this.host.skills()
    for (const skill of skills.slice(0, 8)) {
      if (!enabled.some((row) => row.id === skill.id && row.enabled)) throw new Error(mobileCopy.missing)
      const uri = `bitsbytes://skill/${safeID(skill.id)}?revision=${Number(skill.revision)}`
      await this.host.call("attachment.read", { uri })
      parts.push({ type: "file", mime: "text/plain", filename: skill.id, url: uri })
    }
    for (const raw of Array.isArray(args.transcripts) ? args.transcripts.slice(0, 8) : []) {
      const reference = raw as { id: string; revision: number }
      const uri = `bitsbytes://transcript/${safeID(reference.id)}?revision=${Number(reference.revision)}`
      await this.host.call("attachment.read", { uri })
      parts.push({ type: "file", mime: "text/plain", filename: mobileCopy.transcript + ".txt", url: uri })
    }
    const defaults = skills.length
      ? JSON.parse(
          await readFile(
            join(this.host.root, "skills", skills[0].id, ".versions", String(skills[0].revision), "skill.json"),
            "utf8",
          ),
        ).defaultPrompt
      : ""
    const request = text || defaults || (parts.length ? mobileCopy.transcript : "")
    if (!request) throw new Error(mobileCopy.invalid)
    parts.unshift({ type: "text", text: request })
    const messageID = safeID(args.id)
    if (!/^msg_[a-f0-9]{26}$/.test(messageID)) throw new Error(mobileCopy.invalid)
    return this.host.call("runs.admit", {
      delivery: args.delivery === "steer" ? "steer" : "queue",
      userText: request,
      prompt: {
        protocol: "v1",
        sessionID,
        directory: session.directory,
        id: messageID,
        text: request,
        agent: "build",
        model,
        variant: args.variant || undefined,
        legacyParts: parts,
      },
    })
  }
  private async file(response: ServerResponse, url: URL) {
    const item = this.host.artifacts.items.find((item) => item.id === safeID(url.pathname.slice(6)))
    if (!item) throw new Error(mobileCopy.missing)
    const revision = Number(url.searchParams.get("revision")) || item.revision,
      version = item.history?.find((row) => row.revision === revision)
    if (!version) throw new Error(mobileCopy.missing)
    const preview = url.searchParams.get("preview") === "1",
      image = item.kind === "image" && url.searchParams.get("inline") === "1"
    const bytes = preview ? await this.host.artifacts.read(item.id, revision) : await readFile(version.source)
    if (!bytes) throw new Error(mobileCopy.preparing)
    response.setHeader("cache-control", "no-store")
    response.setHeader("content-type", preview ? "application/pdf" : (item.mime ?? "application/octet-stream"))
    response.setHeader(
      "content-disposition",
      `${preview || image ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(preview ? item.filename + ".pdf" : item.filename)}`,
    )
    response.end(Buffer.from(bytes))
  }
  private async upload(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    input: Record<string, unknown>,
    device: Device,
  ) {
    const folder = join(this.folder(), "uploads")
    if (url.pathname === "/uploads" && request.method === "GET") {
      const rows = await Promise.all(
        (await readdir(folder))
          .filter((file) => file.endsWith(".json"))
          .map(async (file) => JSON.parse(await readFile(join(folder, file), "utf8")) as Upload),
      )
      this.json(
        response,
        rows.filter((row) => row.device === device.id),
      )
      return
    }
    if (url.pathname === "/upload" && request.method === "POST") {
      const size = Number(input.size),
        name = String(input.name).slice(0, 200),
        sessionID = safeID(input.sessionID)
      if (!Number.isSafeInteger(size) || size <= 0 || size > 1024 ** 3) throw new Error(mobileCopy.tooLarge)
      if (!/\.(mp3|wav|m4a|mp4|ogg|flac|webm)$/i.test(name)) throw new Error(mobileCopy.invalid)
      await this.host.engineFetch(`/session/${sessionID}`)
      const rows = await Promise.all(
        (await readdir(folder))
          .filter((file) => file.endsWith(".json"))
          .map(async (file) => JSON.parse(await readFile(join(folder, file), "utf8")) as Upload),
      )
      const previous = rows.find(
        (row) =>
          row.device === device.id &&
          row.status === "uploading" &&
          row.name === name &&
          row.size === size &&
          row.sessionID === sessionID &&
          row.fingerprint === input.fingerprint,
      )
      if (previous) {
        this.json(response, previous)
        return
      }
      const upload: Upload = {
        id: randomUUID(),
        device: device.id,
        name,
        size,
        sessionID,
        fingerprint: String(input.fingerprint),
        chunks: [],
        status: "uploading",
        error: "",
      }
      await writeFile(join(folder, upload.id + ".part"), "")
      await this.saveUpload(upload)
      this.json(response, upload)
      return
    }
    const id = safeID(url.pathname.split("/")[2])
    if (this.uploadLocks.has(id)) throw new Error(mobileCopy.uploadMismatch)
    this.uploadLocks.add(id)
    try {
      const upload = JSON.parse(await readFile(join(folder, id + ".json"), "utf8")) as Upload
      if (upload.device !== device.id) throw new Error(mobileCopy.unauthorised)
      if (request.method === "PUT") {
        if (upload.status !== "uploading") throw new Error(mobileCopy.uploadMismatch)
        const bytes = await this.body(request, 4 * 1024 ** 2),
          offset = Number(url.searchParams.get("offset")),
          committed = upload.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
        // A crash after writing audio but before committing its journal leaves a tail.
        // Discard only that uncommitted tail so the phone can retry the same chunk.
        const file = await open(join(folder, id + ".part"), "r+")
        try {
          const actual = (await file.stat()).size
          if (actual < committed) throw new Error(mobileCopy.uploadMismatch)
          if (actual > committed) await file.truncate(committed)
        } finally {
          await file.close()
        }
        const old = upload.chunks.find((chunk) => chunk.offset === offset)
        if (old && old.hash === digest(bytes) && old.length === bytes.length) {
          this.json(response, upload)
          return
        }
        if (offset !== committed || offset + bytes.length > upload.size || !bytes.length)
          throw new Error(mobileCopy.uploadMismatch)
        const output = await open(join(folder, id + ".part"), "a")
        try {
          await output.writeFile(bytes)
          await output.sync()
        } finally {
          await output.close()
        }
        upload.chunks.push({ offset, length: bytes.length, hash: digest(bytes) })
        await this.saveUpload(upload)
        this.json(response, upload)
        return
      }
      if (request.method === "POST" && url.pathname.endsWith("/finish")) {
        if (upload.status === "uploading") {
          if (upload.chunks.reduce((sum, chunk) => sum + chunk.length, 0) !== upload.size)
            throw new Error(mobileCopy.uploadMismatch)
          const source = join(folder, id + ".part"),
            target = join(folder, id + extname(upload.name).toLowerCase())
          const actual = await stat(source).catch(() => stat(target))
          if (actual.size !== upload.size) throw new Error(mobileCopy.uploadMismatch)
          await rename(source, target).catch(async (error) => {
            if (await stat(source).catch(() => undefined)) throw error
            if ((await stat(target)).size !== upload.size) throw new Error(mobileCopy.uploadMismatch)
          })
          upload.status = "processing"
          await this.saveUpload(upload)
        }
        if (upload.status === "error") {
          upload.status = "processing"
          upload.error = ""
          await this.saveUpload(upload)
        }
        void this.process(upload)
        this.json(response, upload)
        return
      }
      throw new Error(mobileCopy.invalid)
    } finally {
      this.uploadLocks.delete(id)
    }
  }
  private async saveUpload(upload: Upload) {
    const target = join(this.folder(), "uploads", upload.id + ".json"),
      temporary = target + "." + randomUUID() + ".tmp"
    await writeFile(temporary, JSON.stringify(upload))
    await rename(temporary, target)
  }
  private async process(upload: Upload) {
    if (this.processing.has(upload.id) || upload.status === "ready") return
    this.processing.add(upload.id)
    try {
      const path = join(this.folder(), "uploads", upload.id + extname(upload.name).toLowerCase())
      const previous = (await this.host.rpc<(Job & { importSource?: string })[]>("jobs")).find(
        (job) => job.importSource === path,
      )
      const job =
        previous ??
        (await this.host.rpc<Job>("import", { path, title: upload.name, engine: this.host.settings.engine }))
      upload.jobID = job.id
      await this.saveUpload(upload)
      await this.host.rpc("job.update", { id: job.id, values: { sessionID: upload.sessionID } })
      const transcribed = await this.host.call("transcribe", { id: job.id }) as Job
      if (!transcribed.transcript?.trim()) throw new Error("bb.error.transcriptEmpty")
      upload.status = "ready"
    } catch (error) {
      upload.status = "error"
      upload.error = error instanceof Error ? bbError(error) : mobileCopy.error
    } finally {
      this.processing.delete(upload.id)
      await this.saveUpload(upload)
    }
  }
}
