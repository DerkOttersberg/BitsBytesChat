import type { ServerConnection } from "./context/server"

export type ConversationWindowTarget = {
  server: ServerConnection.Key
  sessionID: string
  directory: string
}
