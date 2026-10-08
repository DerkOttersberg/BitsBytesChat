import { ChatOrganization } from "@opencode-ai/core/chat-project"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { InvalidRequestError, SessionNotFoundError } from "@opencode-ai/protocol/errors"
import { Api } from "../api"

export const ChatProjectHandler = HttpApiBuilder.group(Api, "server.organization", (handlers) =>
  Effect.gen(function* () {
    const organization = yield* ChatOrganization.Service
    const invalid = (error: ChatOrganization.Invalid) => new InvalidRequestError({ message: error.message })
    return handlers
      .handle("organization.projects", () => organization.projects)
      .handle("organization.create", (ctx) => organization.create(ctx.payload).pipe(Effect.mapError(invalid)))
      .handle("organization.update", (ctx) =>
        organization.update(ctx.params.id, ctx.payload).pipe(Effect.mapError(invalid)),
      )
      .handle("organization.remove", (ctx) =>
        organization.remove(ctx.params.id).pipe(Effect.as(HttpApiSchema.NoContent.make())),
      )
      .handle("organization.chats", (ctx) => organization.chats(ctx.payload).pipe(Effect.mapError(invalid)))
      .handle("organization.chat", (ctx) =>
        organization
          .chat(ctx.params.sessionID, ctx.payload)
          .pipe(
            Effect.mapError((error) =>
              error._tag === "ChatOrganization.Missing"
                ? new SessionNotFoundError({ sessionID: error.sessionID, message: "organization.error.chatMissing" })
                : invalid(error),
            ),
          ),
      )
      .handle("organization.migrate", (ctx) =>
        organization.migrate(ctx.payload).pipe(Effect.as(HttpApiSchema.NoContent.make())),
      )
  }),
)
