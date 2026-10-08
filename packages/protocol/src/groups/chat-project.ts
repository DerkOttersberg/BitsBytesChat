import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { ChatProject } from "@opencode-ai/schema/chat-project"
import { SessionID } from "@opencode-ai/schema/session-id"
import { InvalidRequestError, SessionNotFoundError } from "../errors"

export const ChatProjectGroup = HttpApiGroup.make("server.organization")
  .add(
    HttpApiEndpoint.get("organization.projects", "/api/organization/projects", {
      success: Schema.Array(ChatProject.Info),
    }),
  )
  .add(
    HttpApiEndpoint.post("organization.create", "/api/organization/projects", {
      payload: ChatProject.Create,
      success: ChatProject.Info,
      error: InvalidRequestError,
    }),
  )
  .add(
    HttpApiEndpoint.patch("organization.update", "/api/organization/projects/:id", {
      params: { id: ChatProject.ID },
      payload: ChatProject.Update,
      success: ChatProject.Info,
      error: InvalidRequestError,
    }),
  )
  .add(
    HttpApiEndpoint.delete("organization.remove", "/api/organization/projects/:id", {
      params: { id: ChatProject.ID },
      success: HttpApiSchema.NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.post("organization.chats", "/api/organization/chats/query", {
      payload: ChatProject.ListInput,
      success: ChatProject.Page,
      error: InvalidRequestError,
    }),
  )
  .add(
    HttpApiEndpoint.patch("organization.chat", "/api/organization/chats/:sessionID", {
      params: { sessionID: SessionID },
      payload: ChatProject.ChatUpdate,
      success: ChatProject.Chat,
      error: [InvalidRequestError, SessionNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post("organization.migrate", "/api/organization/migrate", {
      payload: ChatProject.Migration,
      success: HttpApiSchema.NoContent,
    }),
  )
