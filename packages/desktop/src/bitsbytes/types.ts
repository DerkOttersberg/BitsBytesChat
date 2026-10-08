export type Engine = "parakeet" | "whisper" | "groq"
export type CustomMcpConfig = ({ type: "local"; command: string[]; environment?: Record<string, string> } | { type: "remote"; url: string; headers?: Record<string, string>; oauth?: false | { clientId?: string; clientSecret?: string; scope?: string; callbackPort?: number; redirectUri?: string } }) & { enabled?: boolean; timeout?: number }
export type CustomMcpEntry = { name: string; config?: CustomMcpConfig; status: string; error?: string }
export type CustomMcpState = { servers: CustomMcpEntry[]; error?: string; saved?: boolean }
export type Settings = {
  shareRoot: string
  intakeFolder: string
  templateName: string
  engine: Engine
  acceleration: "auto" | "cpu"
  provider: "chatgpt" | "openrouter"
  model: string
  browserControl: boolean
  computerControl: boolean
  questionAutoResolve?: boolean
  microphone: number | null
}
export type Artifact = { saved: boolean; path: string; used_fallback: boolean; verified_field_count?: number }
export type ArtifactVersion = { revision: number; hash: string; source: string; pdf: string; updated: number; turnID?: string }
export type SpreadsheetGrid = { sheets: string[]; sheet: string; rows: string[][]; formulas?: string[][]; total: number; columns?: number; offset: number; shortened?: boolean }
export type DocumentArtifact = { id: string; sessionID: string; turnID?: string; turnIDs?: string[]; filename: string; path: string; revision: number; hash: string; kind?: "document" | "presentation" | "spreadsheet" | "pdf" | "html" | "code" | "image"; mime?: string; source?: string; history?: ArtifactVersion[]; status: "queued" | "exporting" | "ready" | "error"; updated: number; pdf: string; error: string; image?: { width: number; height: number; provider: string; model: string; jobID: string } }
export type Segment = { start: number; end: number; text: string }
export type Job = {
  id: string; title: string; created: number; updated: number; status: string; duration: number
  skill: string; engine: Engine; transcript: string; recording: boolean; error: string
  chunks: { path: string; start: number; duration: number; done: boolean }[]
  segments: Segment[]; artifact?: Artifact; sessionID?: string; processingSeconds?: number; template?: string
}
export type Skill = {
  id: string; name: string; instructions: string; defaultPrompt: string; enabled: boolean
  template: string; output: string; revision: number; versions: number[]; files: string[]
}
export type Model = { id: string; name: string; context: number; efforts?: string[]; defaultEffort?: string }
export type ImageProviderState = { configured: boolean; available: boolean; model: string; models: readonly string[]; verifiedAt?: number; error?: string; revision: number }
export type State = {
  modelsUpdated: number; modelError: string; settings: Settings; jobs: Job[]; skills: Skill[]; models: Model[]; root: string
  workerReady: boolean; workerError?: string; account: string; planVerified: boolean; openrouterSet: boolean; groqSet: boolean
}
export type BBEvent = { type: "run"; sessionID: string } | { type: "access"; sessionID: string; mode: "ask" | "full" } | { type: "artifact"; artifact: DocumentArtifact; published?: boolean } | { type: "browser"; id: string; sessionID: string; url: string; title: string; loading: boolean; canBack: boolean; canForward: boolean; closed?: boolean } | { type: "refresh" } | { type: "job"; job: Job } | { type: "meter"; level: number } | { type: "duration"; id: string; duration: number } | { type: "notice"; message: string }
export type BBAPI = {
  call: <T = unknown>(method: string, args?: Record<string, unknown>) => Promise<T>
  subscribe: (listener: (event: BBEvent) => void) => () => void
}
