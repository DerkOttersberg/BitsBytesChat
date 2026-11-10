import { app, BrowserWindow, dialog, ipcMain, Menu, net, powerMonitor, powerSaveBlocker, protocol } from "electron"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Application } from "./ipc.js"
import { copy } from "../copy.js"

const base = path.dirname(fileURLToPath(import.meta.url))
protocol.registerSchemesAsPrivileged([{ scheme: "bb-audio", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
app.setName(copy.app)
app.setAppUserModelId("nl.bitsbytes.transcription")
// This flavor has its own identity and data; installing it never replaces BitsBytesChat.
const root = process.env.BITSBYTES_TEST_DATA || path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "BitsBytesTranscription")
app.setPath("userData", root)
let window: BrowserWindow | undefined
let service: Application | undefined
let closing = false
let allowClose = false
let blocker: number | undefined

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on("second-instance", () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus() })
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    window = new BrowserWindow({ width: 1140, height: 780, minWidth: 760, minHeight: 540, backgroundColor: "#171717", title: copy.app, show: false, autoHideMenuBar: true, icon: path.join(base, "../../assets/icon.png"), webPreferences: { preload: path.join(base, "../preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    window.webContents.on("will-navigate", event => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window?.webContents && permission === "media" && "mediaTypes" in details && details.mediaTypes?.every(type => type === "audio") === true))
    window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => contents === window?.webContents && permission === "media" && details.mediaType !== "video")
    service = new Application(root, window, app.getVersion())
    await service.initialize(); service.register()
    protocol.handle("bb-audio", request => {
      const url = new URL(request.url)
      const id = url.pathname.slice(1)
      const file = url.hostname === "recording" && /^[0-9a-f-]{36}$/.test(id) ? service?.audioFiles.get(id) : undefined
      if (!file) return new Response(null, { status: 404 })
      return net.fetch(pathToFileURL(file).toString(), { headers: request.headers })
    })
    const originalChanged = service.changed.bind(service)
    service.changed = () => {
      originalChanged()
      if (service?.activeId && blocker === undefined) blocker = powerSaveBlocker.start("prevent-app-suspension")
      if (!service?.activeId && blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined }
    }
    window.on("close", event => {
      if (allowClose) return
      event.preventDefault()
      if (closing) return
      closing = true
      void (async () => {
        if (!window || !service) return
        if (service.activeId || service.busyId) {
          const recording = !!service.activeId
          const answer = await dialog.showMessageBox(window, { type: "question", title: recording ? copy.closeTitle : copy.quitTitle, message: recording ? copy.closeTitle : copy.quitTitle, detail: recording ? copy.closeBody : copy.quitBody, buttons: recording ? [copy.closeKeep, copy.closeFinish] : [copy.stay, copy.quit], defaultId: 0, cancelId: 0, noLink: true })
          if (answer.response !== 1) { closing = false; return }
          service.willClose = true
          if (service.activeId) {
            // The renderer flushes its sub-second tail before acknowledging the close.
            const acknowledged = new Promise<void>(resolve => {
              const timeout = setTimeout(resolve, 5000)
              const ready = (event: Electron.IpcMainEvent) => {
                if (event.sender !== window?.webContents) return
                clearTimeout(timeout); ipcMain.removeListener("close-ready", ready); resolve()
              }
              ipcMain.on("close-ready", ready)
              setTimeout(() => ipcMain.removeListener("close-ready", ready), 5100)
            })
            window.webContents.send("prepare-close")
            await acknowledged
          }
        }
        await service.shutdown()
        allowClose = true; window.destroy(); app.quit()
      })().catch(() => { closing = false; if (service) service.willClose = false; dialog.showErrorBox(copy.app, copy.errors.storage) })
    })
    window.webContents.on("render-process-gone", () => {
      void (async () => {
        await service?.shutdown().catch(() => undefined)
        if (!closing && window && !window.isDestroyed()) window.webContents.reload()
      })().catch(() => { if (window && !window.isDestroyed()) window.webContents.reload() })
    })
    powerMonitor.on("suspend", () => { window?.webContents.send("prepare-close", "recovered") })
    app.on("before-quit", event => { if (!allowClose && window && !window.isDestroyed()) { event.preventDefault(); window.close() } })
    app.on("window-all-closed", () => app.quit())
    await window.loadFile(path.join(base, "../renderer/index.html"))
    window.show()
  }).catch(() => { dialog.showErrorBox(copy.fatalTitle, copy.fatalBody); allowClose = true; app.quit() })
}
