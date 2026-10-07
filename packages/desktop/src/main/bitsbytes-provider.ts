import { randomBytes, randomUUID, createHash } from "node:crypto"
import { readFile, writeFile, rename, mkdir } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import { safeStorage, shell } from "electron"
import { createRemoteJWKSet, jwtVerify } from "jose"
import type { Model } from "../bitsbytes/types"
import { bbt } from "../bitsbytes/copy"
import { planRequest, openrouterRequest } from "./bitsbytes-request"
import { catalogModels } from "./bitsbytes-models"
import { readState, stateRecord } from "./bitsbytes-state"

type Credentials = {
  host: string; client?: string; access?: string; refresh?: string; idToken?: string
  expires?: number; scopes?: string[]; subject?: string; email?: string; verified?: boolean
  openrouter?: string; groq?: string; providers?: Record<string, unknown>; nativeCredentials?: { id: string; integrationID: string; label: string; value: unknown }[]
}
const RESOURCE = "https://api.openai.com/v1"
const TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/token"

export class BBProvider {
  credentials: Credentials = { host: `urn:uuid:${randomUUID()}` }
  models: Model[] = []
  modelsUpdated = 0
  modelError = ""
  private saving = Promise.resolve()
  private discovering?: Promise<Model[]>
  private catalog: Partial<Record<"chatgpt" | "openrouter", Model[]>> = {}
  secret = randomBytes(32).toString("hex")
  url = ""
  private server?: ReturnType<typeof createServer>
  private refreshing?: Promise<string>
  private signing?: Promise<void>
  constructor(private root: string, private changed: () => void) {}

  async start() {
    const raw = await readFile(join(this.root, "credentials.bin")).catch(() => null)
    if (raw) this.credentials = JSON.parse(safeStorage.decryptString(raw))
    this.catalog = await readState(this.root, "model-catalog.json", {}, value => stateRecord(value)
      && Object.values(value).every(models => Array.isArray(models) && models.every(model => stateRecord(model)
        && typeof model.id === "string" && typeof model.name === "string" && Number.isFinite(model.context))))
    this.modelsUpdated = Number(await readFile(join(this.root, "model-catalog-time"), "utf8").catch(() => "0"))
    if (this.credentials.openrouter) this.credentials.providers = { openrouter: { type: "api", key: this.credentials.openrouter }, ...this.credentials.providers }
    await this.persist()
    this.server = createServer((request, response) => {
      void (async () => {
        if (request.headers.authorization !== `Bearer ${this.secret}`) { response.writeHead(401).end(); return }
        if (request.method !== "POST") { response.writeHead(405).end(); return }
        const route = request.url ?? ""
        if (!/^\/(chatgpt\/responses|openrouter\/(chat\/completions|responses))$/.test(route)) { response.writeHead(404).end(); return }
        const chunks: Buffer[] = []
        let size = 0
        for await (const data of request) {
          size += data.length
          if (size > 32 * 1024 * 1024) throw new Error("bb.error.fileTooLarge")
          chunks.push(data)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
        const chatgpt = route.startsWith("/chatgpt")
        const token = chatgpt ? await this.access() : this.credentials.openrouter
        if (!token) throw new Error("bb.error.providerMissing")
        const abort = new AbortController()
        response.on("close", () => { if (!response.writableEnded) abort.abort() })
        const upstream = await fetch(chatgpt ? `${RESOURCE}/responses` : `https://openrouter.ai/api/v1${route.slice(11)}`, {
          method: "POST", signal: abort.signal,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(chatgpt ? {} : { "X-Title": "BitsBytesChat" }) },
          body: JSON.stringify(chatgpt ? planRequest(body) : openrouterRequest(body)),
        })
        response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" })
        if (upstream.body) for await (const chunk of upstream.body) response.write(chunk)
        response.end()
      })().catch((error: Error) => {
        if (response.headersSent) { response.end(); return }
        response.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: error.message, type: "provider_error" } }))
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve))
    const address = this.server.address()
    if (!address || typeof address === "string") throw new Error("bb.error.invalidRequest")
    this.url = `http://127.0.0.1:${address.port}`
  }
  persist() {
    const next = this.saving.catch(() => undefined).then(() => this.writeCredentials())
    this.saving = next
    return next
  }
  private async writeCredentials() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows credential encryption is unavailable")
    await mkdir(this.root, { recursive: true })
    const target = join(this.root, "credentials.bin")
    const temp = target + "." + randomUUID() + ".tmp"
    await writeFile(temp, safeStorage.encryptString(JSON.stringify(this.credentials)))
    await rename(temp, target)
  }
  async keys(args: { openrouter?: string; groq?: string; providers?: Record<string, unknown>; nativeCredentials?: { id: string; integrationID: string; label: string; value: unknown }[] }) {
    if (args.openrouter?.trim()) {
      this.credentials.openrouter = args.openrouter.trim()
      this.credentials.providers = { ...this.credentials.providers, openrouter: { type: "api", key: args.openrouter.trim() } }
    }
    if (args.groq?.trim()) this.credentials.groq = args.groq.trim()
    await this.persist()
    this.changed()
  }
  async access(): Promise<string> {
    if (!this.credentials.scopes?.includes("chatgpt.tokens.use.direct")) throw new Error("bb.error.planPermission")
    if (this.credentials.access && (this.credentials.expires ?? 0) > Date.now() + 60000) return this.credentials.access
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      if (!this.credentials.refresh || !this.credentials.client) throw new Error("bb.error.providerMissing")
      const result = await fetch(TOKEN_ENDPOINT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: this.credentials.client, refresh_token: this.credentials.refresh, resource: RESOURCE }),
      })
      if (!result.ok) { this.credentials.verified = false; await this.persist(); this.changed(); throw new Error(`ChatGPT reconnect required (${result.status})`) }
      const data = await result.json()
      if (data.id_token) {
        const identity = await jwtVerify(data.id_token, createRemoteJWKSet(new URL("https://auth.openai.com/.well-known/jwks.json")), { issuer: "https://auth.openai.com", audience: this.credentials.client })
        if (identity.payload.sub !== this.credentials.subject) throw new Error("bb.error.authState")
      }
      this.credentials = { ...this.credentials, access: data.access_token, refresh: data.refresh_token ?? this.credentials.refresh,
        idToken: data.id_token ?? this.credentials.idToken, expires: Date.now() + data.expires_in * 1000,
        scopes: data.scope ? data.scope.split(" ") : this.credentials.scopes }
      await this.persist()
      return this.credentials.access!
    })().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }
  signIn() {
    if (this.signing) return this.signing
    this.signing = this.authorize().finally(() => { this.signing = undefined })
    return this.signing
  }
  private async authorize() {
    const state = randomBytes(32).toString("base64url")
    const nonce = randomBytes(32).toString("base64url")
    const verifier = randomBytes(48).toString("base64url")
    const pending = Promise.withResolvers<URL>()
    const listener = createServer((request, response) => {
      const url = new URL(request.url ?? "", "http://127.0.0.1")
      if (url.pathname !== "/auth/callback") { response.writeHead(404).end(); return }
      if (url.searchParams.get("state") !== state) { response.writeHead(400).end(); return }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(bbt("brand") + " — " + bbt("done"))
      pending.resolve(url)
    })
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
    const address = listener.address()
    if (!address || typeof address === "string") throw new Error("bb.error.authState")
    const redirect = `http://127.0.0.1:${address.port}/auth/callback`
    const authorization = new URL("https://auth.openai.com/api/accounts/authorize")
    const parameters: Record<string, string> = {
      client_id: this.credentials.client ?? "dynamic_agent_client", ext_agent_host_id: this.credentials.host,
      response_type: "code", redirect_uri: redirect, scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: RESOURCE, state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }
    if (!this.credentials.client) parameters.agent_name_hint = "BitsBytesChat"
    if (this.credentials.idToken) parameters.id_token_hint = this.credentials.idToken
    Object.entries(parameters).forEach(([key, value]) => authorization.searchParams.set(key, value))
    const timer = setTimeout(() => pending.reject(new Error("bb.error.authTimeout")), 180000)
    try {
      await shell.openExternal(authorization.toString())
      const callback = await pending.promise
      if (callback.searchParams.get("error")) throw new Error("bb.error.planPermission")
      const issued = callback.searchParams.get("client_id") ?? this.credentials.client
      if (!issued || issued === "dynamic_agent_client" || (this.credentials.client && issued !== this.credentials.client)) throw new Error("bb.error.authState")
      this.credentials.client = issued
      await this.persist()
      const response = await fetch(TOKEN_ENDPOINT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: issued, code: callback.searchParams.get("code") ?? "", code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE }),
      })
      if (!response.ok) throw new Error(`ChatGPT sign-in failed (${response.status})`)
      const tokens = await response.json()
      const identity = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL("https://auth.openai.com/.well-known/jwks.json")), { issuer: "https://auth.openai.com", audience: issued })
      if (identity.payload.nonce !== nonce || (this.credentials.subject && identity.payload.sub !== this.credentials.subject)) throw new Error("bb.error.authState")
      const scopes: string[] = (tokens.scope ?? "").split(" ")
      this.credentials = { ...this.credentials, access: tokens.access_token, refresh: tokens.refresh_token,
        idToken: tokens.id_token, expires: Date.now() + tokens.expires_in * 1000, scopes, subject: identity.payload.sub,
        email: String(identity.payload.email ?? identity.payload.sub), verified: false }
      await this.persist()
      if (!scopes.includes("chatgpt.tokens.use.direct")) throw new Error("bb.error.planPermission")
      await this.listModels("chatgpt")
      await this.verify()
    } finally { clearTimeout(timer); listener.close(); this.changed() }
  }
  async disconnect() {
    this.credentials = { host: this.credentials.host, openrouter: this.credentials.openrouter, groq: this.credentials.groq, providers: this.credentials.providers, nativeCredentials: this.credentials.nativeCredentials }
    delete this.catalog.chatgpt
    await writeFile(join(this.root, "model-catalog.json"), JSON.stringify(this.catalog))
    this.models = []
    await this.persist()
    this.changed()
  }
  listModels(provider: "chatgpt" | "openrouter", stale = false) {
    if (stale && !this.modelError && this.modelsUpdated > Date.now() - 5 * 60 * 1000 && this.models.length) return Promise.resolve(this.models)
    if (this.discovering) return this.discovering
    this.discovering = this.discover(provider).catch(error => {
      this.modelError = String(error.message ?? error)
      this.changed()
      throw error
    }).finally(() => { this.discovering = undefined })
    return this.discovering
  }
  catalogFor(provider: "chatgpt" | "openrouter") { return this.catalog[provider] ?? [] }
  private async discover(provider: "chatgpt" | "openrouter") {
    const token = provider === "chatgpt" ? await this.access() : this.credentials.openrouter
    if (!token) throw new Error("bb.error.providerMissing")
    const response = await fetch(provider === "chatgpt" ? `${RESOURCE}/models` : "https://openrouter.ai/api/v1/models", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`Model discovery failed (${response.status})`)
    const result = await response.json()
    this.models = catalogModels(provider, result)
    this.catalog[provider] = this.models
    this.modelError = ""
    this.modelsUpdated = Date.now()
    await writeFile(join(this.root, "model-catalog-time"), String(this.modelsUpdated))
    this.changed()
    await writeFile(join(this.root, "model-catalog.json"), JSON.stringify(this.catalog))
    return this.models
  }
  select(provider: "chatgpt" | "openrouter") { this.models = this.catalog[provider] ?? [] }
  async verify(refresh = false) {
    if (refresh) this.credentials.expires = 0
    const token = await this.access()
    const models = this.catalog.chatgpt ?? await this.listModels("chatgpt")
    const response = await fetch(`${RESOURCE}/responses`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: models[0]?.id, store: false, stream: true, input: [{ role: "user", content: "Reply with exactly: Connected." }] }), signal: AbortSignal.timeout(60000) })
    if (!response.ok) throw new Error(`ChatGPT verification failed (${response.status})`)
    const stream = await response.text()
    if (!stream.includes('"type":"response.completed"') && !stream.includes('"type": "response.completed"')) throw new Error("ChatGPT request did not complete; check account usage")
    this.credentials.verified = true
    await this.persist()
    this.changed()
    return { verified: true }
  }
  close() { this.server?.close() }
}
