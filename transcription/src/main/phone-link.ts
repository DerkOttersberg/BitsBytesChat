import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto"
import { createServer } from "node:https"
import type { Server } from "node:https"
import { createSocket } from "node:dgram"
import type { Socket } from "node:dgram"
import { mkdir, readdir } from "node:fs/promises"
import { hostname, networkInterfaces } from "node:os"
import path from "node:path"
import { Bonjour } from "bonjour-service"
import { generate } from "selfsigned"
import { toDataURL } from "qrcode"
import type { LinkSnapshot, Pairing } from "../shared.js"
import { atomicWrite, readJSON } from "./storage.js"

export const MAX_TEXT_BYTES = 4 * 1024 * 1024
export const DISCOVERY_PORT = 47832
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
type Peer = { id: string; hash: string; expires?: number; phoneId?: string; name: string; lastSeen?: string }
type Identity = { id: string; cert: string; key: string; peers: Peer[] }
export type Delivery = { id: string; recordingId: string; phoneId: string; title: string; text: string; sha256: string; duration: number }
type Inbox = Delivery & { peerId: string; deviceName: string; received: string; copied?: string }
type Receipt = Omit<Inbox, "text"> & { copied: string }
type Options = {
  protect(text: string): string; unprotect(text: string): string;
  receive(delivery: Delivery, peer: { id: string; name: string }): Promise<void>;
  clipboard(text: string): Promise<void>; changed(): void;
}

/** TLS identity stays with the installation. A QR authorizes one phone; neither API keys nor audio are transferred. */
export class PhoneLink {
  private identity?: Identity
  private server?: Server
  private udp?: Socket
  private bonjour?: Bonjour
  private monitor?: NodeJS.Timeout
  private serial: Promise<unknown> = Promise.resolve()
  private writes: Promise<void> = Promise.resolve()
  private pending = 0
  private addresses = ""
  private port = 0
  private pin = ""
  private error?: string
  private received = 0
  constructor(private root: string, private options: Options) {}
  snapshot(): LinkSnapshot {
    return { enabled: !!this.server?.listening, desktopId: this.identity?.id ?? "", name: hostname(), port: this.port,
      addresses: this.hosts(), error: this.error, peers: this.identity?.peers.filter(peer => !!peer.phoneId).map(peer => ({ id: peer.id, name: peer.name, lastSeen: peer.lastSeen })) ?? [], received: this.received }
  }
  private hosts() {
    return [...new Set(Object.values(networkInterfaces()).flatMap(rows => rows ?? []).filter(row => !row.internal && (row.family === "IPv4" || !row.address.startsWith("fe80:"))).map(row => row.address))].slice(0, 12)
  }
  private save() {
    const data = JSON.stringify(this.identity)
    this.writes = this.writes.catch(() => undefined).then(async () => {
      const file = path.join(this.root, "phone-link.json")
      const previous = await readJSON<Identity>(file)
      if (previous) await atomicWrite(path.join(this.root, "phone-link.backup.json"), JSON.stringify(previous))
      await atomicWrite(file, data)
    })
    return this.writes
  }
  async start(port = 47831, discovery = true) {
    await mkdir(path.join(this.root, "inbox"), { recursive: true })
    this.identity = await readJSON<Identity>(path.join(this.root, "phone-link.json")) ?? await readJSON<Identity>(path.join(this.root, "phone-link.backup.json"))
    if (!this.identity) {
      const pems = await generate([{ name: "commonName", value: "BitsBytes Transcription" }], { keySize: 2048, algorithm: "sha256", notAfterDate: new Date(Date.now() + 20 * 365.25 * 86400000) })
      this.identity = { id: randomUUID(), cert: pems.cert, key: this.options.protect(pems.private), peers: [] }
      await this.save()
    }
    const certificate = new X509Certificate(this.identity.cert)
    this.pin = createHash("sha256").update(certificate.publicKey.export({ type: "spki", format: "der" })).digest("hex")
    this.server = createServer({ cert: this.identity.cert, key: this.options.unprotect(this.identity.key), minVersion: "TLSv1.2" }, (request, response) => {
      void (async () => {
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("Content-Type", "application/json")
        const route = /^\/v1\/peers\/([a-f0-9-]{36})\/(pair|deliver|status)$/.exec(request.url ?? "")
        const peer = route && this.identity?.peers.find(peer => peer.id === route[1])
        const auth = request.headers.authorization
        const hash = typeof auth === "string" && /^Bearer [a-zA-Z0-9_-]{43}$/.test(auth) ? createHash("sha256").update(auth.slice(7)).digest("hex") : ""
        if (request.method !== "POST" || !peer || !hash || !timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(peer.hash, "hex"))) { response.writeHead(401).end('{"error":"unauthorized"}'); return }
        if (peer.expires && peer.expires < Date.now()) { response.writeHead(410).end('{"error":"expired"}'); return }
        if (this.pending >= 4) { response.writeHead(503).end('{"error":"busy"}'); return }
        this.pending++
        try {
          const buffers: Buffer[] = []; let bytes = 0
          for await (const value of request) {
            const buffer = Buffer.from(value); bytes += buffer.length
            if (bytes > 28 * 1024 * 1024) { response.writeHead(413).end('{"error":"too_large"}'); request.destroy(); return }
            buffers.push(buffer)
          }
          let body: Record<string, unknown>
          try { body = JSON.parse(Buffer.concat(buffers).toString("utf8")) as Record<string, unknown> } catch { response.writeHead(400).end('{"error":"invalid"}'); return }
          if (!body || typeof body.phoneId !== "string" || !UUID.test(body.phoneId)) { response.writeHead(400).end('{"error":"invalid"}'); return }
          if (route![2] === "pair") {
            if (peer.phoneId && peer.phoneId !== body.phoneId) { response.writeHead(403).end('{"error":"bound"}'); return }
            peer.phoneId = body.phoneId; peer.name = typeof body.name === "string" ? body.name.replace(/[\x00-\x1f]/g, "").slice(0, 100) : "Android"
            this.identity!.peers = this.identity!.peers.filter(existing => existing.id === peer.id || existing.phoneId !== peer.phoneId)
            peer.lastSeen = new Date().toISOString(); delete peer.expires
            await this.save(); this.options.changed()
            response.end(JSON.stringify({ desktopId: this.identity!.id, name: hostname(), status: "linked", peerId: peer.id })); return
          }
          if (!peer.phoneId || peer.phoneId !== body.phoneId) { response.writeHead(403).end('{"error":"unlinked"}'); return }
          if (route![2] === "status") { response.end(JSON.stringify({ desktopId: this.identity!.id, name: hostname(), status: "ready" })); return }
          const delivery = this.validate(body)
          if (!delivery) { response.writeHead(400).end('{"error":"invalid"}'); return }
          const operation = this.serial.catch(() => undefined).then(() => this.accept(delivery, peer))
          this.serial = operation
          const result = await operation
          response.end(JSON.stringify(result))
        } finally { this.pending-- }
      })().catch(() => { if (!response.headersSent) response.writeHead(503); response.end('{"error":"retry"}') })
    })
    this.server.requestTimeout = 60000; this.server.headersTimeout = 10000; this.server.keepAliveTimeout = 3000; this.server.maxConnections = 12
    this.server.on("tlsClientError", () => undefined)
    await new Promise<void>((resolve, reject) => {
      const failed = (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && port !== 0) { port = 0; this.server!.listen(0); return }
        reject(error)
      }
      this.server!.on("error", failed); this.server!.once("listening", () => { this.server!.removeListener("error", failed); this.server!.on("error", () => { this.error = "Phone receiver unavailable"; this.options.changed() }); resolve() }); this.server!.listen(port)
    })
    const address = this.server.address(); this.port = address && typeof address !== "string" ? address.port : 0
    if (discovery) {
      this.advertise()
      this.udp = createSocket({ type: "udp4", reuseAddr: true })
      this.udp.on("error", () => undefined)
      this.udp.on("message", (data, remote) => {
        if (data.length > 256 || data.toString() !== "BitsBytes-Transcription discovery 1") return
        this.udp?.send(JSON.stringify({ v: 1, id: this.identity!.id, pin: this.pin, port: this.port }), remote.port, remote.address, () => undefined)
      })
      this.udp.bind(DISCOVERY_PORT)
      this.addresses = this.hosts().join("|")
      this.monitor = setInterval(() => { if (this.addresses !== this.hosts().join("|")) { this.addresses = this.hosts().join("|"); this.advertise(); this.options.changed() } }, 10000)
      this.monitor.unref()
    }
    void this.resumeInbox()
    this.options.changed()
  }
  advertise() {
    this.bonjour?.destroy()
    this.bonjour = new Bonjour({}, () => undefined)
    this.bonjour.publish({ name: `BBT-${this.identity!.id}`, type: "bbtranscript", port: this.port, txt: { id: this.identity!.id, pin: this.pin, v: "1" } })
  }
  async pairing(): Promise<Pairing> {
    if (!this.server?.listening || !this.identity) throw new Error("receiver unavailable")
    this.identity.peers = this.identity.peers.filter(peer => peer.phoneId || (peer.expires ?? 0) > Date.now())
    if (this.identity.peers.length >= 64) throw new Error("too many phones")
    const token = randomBytes(32).toString("base64url"); const expires = Date.now() + 10 * 60000
    const peer: Peer = { id: randomUUID(), hash: createHash("sha256").update(token).digest("hex"), expires, name: "Android" }
    this.identity.peers.push(peer); await this.save()
    const code = "bitsbytes://link/" + Buffer.from(JSON.stringify({ v: 1, id: this.identity.id, name: hostname(), peerId: peer.id, token, pin: this.pin, port: this.port, addresses: this.hosts() })).toString("base64url")
    return { code, expires, qr: await toDataURL(code, { margin: 3, width: 512, errorCorrectionLevel: "M" }) }
  }
  async revoke(id: string) { if (!this.identity) return; this.identity.peers = this.identity.peers.filter(peer => peer.id !== id); await this.save(); this.options.changed() }
  private validate(body: Record<string, unknown>): Delivery | undefined {
    if (typeof body.id !== "string" || !UUID.test(body.id) || typeof body.recordingId !== "string" || !UUID.test(body.recordingId) || typeof body.text !== "string" || !body.text.trim() || Buffer.byteLength(body.text, "utf8") > MAX_TEXT_BYTES || typeof body.sha256 !== "string" || createHash("sha256").update(body.text, "utf8").digest("hex") !== body.sha256 || typeof body.title !== "string" || body.title.length > 512 || typeof body.duration !== "number" || !Number.isFinite(body.duration) || body.duration < 0 || body.duration > 1e8) return
    return { id: body.id, phoneId: body.phoneId as string, recordingId: body.recordingId, text: body.text, sha256: body.sha256, title: body.title, duration: body.duration }
  }
  private async accept(delivery: Delivery, peer: Peer) {
    const file = path.join(this.root, "inbox", delivery.id + ".json")
    const previous = await readJSON<Inbox | Receipt>(file)
    if (previous && (previous.sha256 !== delivery.sha256 || previous.phoneId !== delivery.phoneId)) throw new Error("conflicting delivery")
    if (previous?.copied) return { desktopId: this.identity!.id, id: delivery.id, sha256: delivery.sha256, status: "copied" }
    if (!this.identity!.peers.includes(peer) || !peer.phoneId) throw new Error("revoked")
    const saved: Inbox = { ...delivery, ...(previous && "text" in previous ? previous : {}), peerId: peer.id, deviceName: peer.name, received: previous?.received ?? new Date().toISOString() }
    if (!previous || previous.peerId !== peer.id) await atomicWrite(file, JSON.stringify(saved))
    await this.options.receive(saved, { id: peer.phoneId, name: peer.name })
    await this.options.clipboard(saved.text)
    const { text, ...metadata } = saved
    const receipt: Receipt = { ...metadata, copied: new Date().toISOString() }; await atomicWrite(file, JSON.stringify(receipt))
    peer.lastSeen = receipt.copied; await this.save(); this.received++; this.options.changed()
    return { desktopId: this.identity!.id, id: saved.id, sha256: saved.sha256, status: "copied" }
  }
  private async resumeInbox() {
    for (const name of await readdir(path.join(this.root, "inbox"))) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
      const saved = await readJSON<Inbox | Receipt>(path.join(this.root, "inbox", name))
      if (!saved || saved.copied || !("text" in saved)) continue
      const peer = this.identity!.peers.find(peer => peer.id === saved.peerId && peer.phoneId === saved.phoneId)
      if (!peer || !this.validate(saved)) continue
      this.serial = this.serial.catch(() => undefined).then(() => this.accept(saved, peer))
      await this.serial.catch(() => undefined)
    }
  }
  async close() {
    if (this.monitor) clearInterval(this.monitor)
    this.bonjour?.destroy(); this.bonjour = undefined
    try { this.udp?.close() } catch { /* discovery may not have bound */ }
    if (this.server) { const closed = new Promise<void>(resolve => this.server!.close(() => resolve())); this.server.closeAllConnections(); await closed }
    await this.serial.catch(() => undefined); await this.writes.catch(() => undefined)
  }
}
