export type Status = "recording" | "saved" | "transcribing" | "complete" | "interrupted" | "error"
export type Preferences = { model: string; language: string; microphone: string }
export type Settings = Preferences & { hasKey: boolean; storagePath: string }
export type Recording = {
  id: string; title: string; created: string; rate: number; duration: number;
  status: Status; error: string; transcript: string; completedParts: number;
  preferences: Preferences; source?: string
}
export type Snapshot = { recordings: Recording[]; settings: Settings; activeId?: string; busyId?: string; version: string }
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
export type API = {
  snapshot(): Promise<Reply<Snapshot>>;
  start(): Promise<Reply<Recording>>;
  append(id: string, sequence: number, pcm: ArrayBuffer): Promise<Reply<number>>;
  finish(id: string, error?: string): Promise<Reply<void>>;
  transcribe(id: string): Promise<Reply<void>>;
  cancel(): Promise<Reply<void>>;
  importAudio(): Promise<Reply<string | undefined>>;
  saveSettings(settings: Preferences & { key: string }): Promise<Reply<void>>;
  copy(id: string): Promise<Reply<void>>;
  exportAudio(id: string): Promise<Reply<void>>;
  audio(id: string): Promise<Reply<string>>;
  folder(): Promise<Reply<void>>;
  remove(id: string): Promise<Reply<void>>;
  onChange(callback: () => void): () => void;
  onClose(callback: () => Promise<void>): void;
}
declare global { interface Window {
  api: API
  CreamInk: { mount(root: HTMLElement): void; unmount(root: HTMLElement): void }
} }
