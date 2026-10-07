import { randomUUID } from "node:crypto"
import { BrowserWindow, WebContentsView, session } from "electron"
import type { BBEvent } from "../bitsbytes/types"

type Tab = { id: string; sessionID: string; view: WebContentsView; window: BrowserWindow }
export class BBBrowser {
  private tabs = new Map<string, Tab>()
  constructor(private emit: (event: BBEvent) => void) {}
  private target(id: string, sessionID?: string) {
    const tab = this.tabs.get(id)
    if (!tab || (sessionID && tab.sessionID !== sessionID)) throw new Error("bb.error.browserMissing")
    return tab
  }
  private url(value: string) {
    const url = new URL(value.includes("://") ? value : `https://${value}`)
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("bb.error.browserURL")
    return url.href
  }
  private state(tab: Tab) {
    const web = tab.view.webContents
    return { type: "browser" as const, id: tab.id, sessionID: tab.sessionID, url: web.getURL(), title: web.getTitle(), loading: web.isLoading(), canBack: web.navigationHistory.canGoBack(), canForward: web.navigationHistory.canGoForward() }
  }
  async open(sessionID: string, url: string, windowID?: number, signal?: AbortSignal) {
    if (!sessionID) throw new Error("bb.error.browserMissing")
    const window = (windowID ? BrowserWindow.fromId(windowID) : BrowserWindow.getAllWindows()[0])
    if (!window) throw new Error("bb.error.browserMissing")
    const profile = session.fromPartition("persist:bitsbytes-browser")
    profile.setPermissionRequestHandler((_web, _permission, callback) => callback(false))
    profile.setPermissionCheckHandler(() => false)
    const view = new WebContentsView({ webPreferences: { session: profile, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
    const tab: Tab = { id: randomUUID(), sessionID, view, window }
    this.tabs.set(tab.id, tab)
    window.contentView.addChildView(view)
    view.setVisible(false)
    view.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void view.webContents.loadURL(url); return { action: "deny" } })
    view.webContents.on("will-navigate", (event, url) => { if (!/^https?:\/\//.test(url)) event.preventDefault() })
    view.webContents.on("will-redirect", (event, url) => { if (!/^https?:\/\//.test(url)) event.preventDefault() })
    view.webContents.on("did-navigate", () => this.emit(this.state(tab)))
    view.webContents.on("did-navigate-in-page", () => this.emit(this.state(tab)))
    view.webContents.on("page-title-updated", () => this.emit(this.state(tab)))
    view.webContents.on("did-start-loading", () => this.emit(this.state(tab)))
    view.webContents.on("did-stop-loading", () => this.emit(this.state(tab)))
    window.once("closed", () => this.close(tab.id))
    const abort = () => view.webContents.stop()
    signal?.addEventListener("abort", abort, { once: true })
    try { signal?.throwIfAborted(); await view.webContents.loadURL(this.url(url || "https://www.google.com")) }
    finally { signal?.removeEventListener("abort", abort) }
    this.emit(this.state(tab))
    return this.state(tab)
  }
  close(id: string) {
    const tab = this.tabs.get(id)
    if (!tab) return
    this.emit({ ...this.state(tab), closed: true })
    if (!tab.window.isDestroyed()) tab.window.contentView.removeChildView(tab.view)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    this.tabs.delete(id)
  }
  async call(action: string, args: Record<string, unknown>, sessionID?: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (action === "open") return this.open(sessionID ?? String(args.sessionID), String(args.url ?? ""), Number(args.windowID) || undefined, signal)
    if (action === "list") return [...this.tabs.values()].filter(tab => !sessionID || tab.sessionID === sessionID).map(tab => this.state(tab))
    if (action === "promote" && !sessionID) { for (const tab of this.tabs.values()) if (tab.sessionID === args.from) { tab.sessionID = String(args.to); this.emit(this.state(tab)) }; return { saved: true } }
    const tab = this.target(String(args.id), sessionID)
    const web = tab.view.webContents
    if (action === "close") { this.close(tab.id); return { closed: true } }
    if (action === "bounds") {
      const rect = args.bounds as { x: number; y: number; width: number; height: number }
      if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) throw new Error("bb.error.invalidRequest")
      tab.view.setBounds({ x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) })
      tab.view.setVisible(Boolean(args.visible))
    }
    if (action === "hide") tab.view.setVisible(false)
    if (action === "navigate") {
      const abort = () => web.stop()
      signal?.addEventListener("abort", abort, { once: true })
      try { await web.loadURL(this.url(String(args.url))) }
      finally { signal?.removeEventListener("abort", abort) }
    }
    if (action === "back" && web.navigationHistory.canGoBack()) web.navigationHistory.goBack()
    if (action === "forward" && web.navigationHistory.canGoForward()) web.navigationHistory.goForward()
    if (action === "reload") web.reload()
    if (action === "stop") web.stop()
    if (action === "inspect") return { ...this.state(tab), page: await web.executeJavaScript(`(() => {
      const visible = e => !!(e.getBoundingClientRect().width && e.getBoundingClientRect().height);
      const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')].filter(visible).slice(0, 500);
      const token = Date.now().toString(36);
      const controls = elements.map((e,i) => { const ref = token + '-' + i; e.setAttribute('data-bb-ref',ref); return {ref,tag:e.tagName,role:e.getAttribute('role'),label:e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||e.getAttribute('name'),href:e.getAttribute('href'),type:e.getAttribute('type')}; });
      return {text:document.body.innerText.slice(0,60000), truncated:document.body.innerText.length > 60000, controls};
    })()`) }
    if (action === "screenshot") return { content: [{ type: "image", mimeType: "image/png", data: (await web.capturePage()).toPNG().toString("base64") }] }
    if (action === "click" || action === "type") {
      const ref = String(args.ref)
      if (!/^[a-z0-9]+-\d+$/.test(ref)) throw new Error("bb.error.invalidRequest")
      await web.executeJavaScript(`(() => { const e=document.querySelector('[data-bb-ref="${ref}"]'); if(!e)throw new Error('Reference expired; inspect the page again'); e.scrollIntoView({block:'center'}); e.focus(); ${action === "click" ? "e.click();" : ""} })()`)
      if (action === "type") { if (args.replace !== false) { web.selectAll(); } web.insertText(String(args.text ?? "")) }
    }
    if (action === "scroll") await web.executeJavaScript(`window.scrollBy(${Math.max(-4000, Math.min(4000, Number(args.x) || 0))},${Math.max(-4000, Math.min(4000, Number(args.y) || 0))})`)
    return this.state(tab)
  }
}
