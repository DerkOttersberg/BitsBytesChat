import { contextBridge, ipcRenderer } from "electron"
import type { API } from "./shared.js"
const api: API = {
  snapshot: () => ipcRenderer.invoke("snapshot"), start: () => ipcRenderer.invoke("start"),
  append: (id, sequence, pcm) => ipcRenderer.invoke("append", id, sequence, pcm),
  finish: (id, error) => ipcRenderer.invoke("finish", id, error), transcribe: id => ipcRenderer.invoke("transcribe", id),
  cancel: () => ipcRenderer.invoke("cancel"), importAudio: () => ipcRenderer.invoke("importAudio"),
  saveSettings: input => ipcRenderer.invoke("saveSettings", input), copy: id => ipcRenderer.invoke("copy", id),
  exportAudio: id => ipcRenderer.invoke("exportAudio", id), folder: () => ipcRenderer.invoke("folder"), remove: id => ipcRenderer.invoke("remove", id),
  audio: id => ipcRenderer.invoke("audio", id),
  onChange: callback => { const listener = () => callback(); ipcRenderer.on("changed", listener); return () => ipcRenderer.removeListener("changed", listener) },
  onClose: callback => { ipcRenderer.on("prepare-close", () => { void callback().finally(() => ipcRenderer.send("close-ready")) }) }
}
contextBridge.exposeInMainWorld("api", api)
