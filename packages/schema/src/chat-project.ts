export * as ChatProject from "./chat-project"

import { Schema } from "effect"
import { Event } from "./event"
import { SessionID } from "./session-id"
import { AbsolutePath, NonNegativeInt, optional, PositiveInt } from "./schema"

export const ID = Schema.String.check(Schema.isPattern(/^cpr_[a-zA-Z0-9_-]+$/)).annotate({
  identifier: "ChatProject.ID",
})
export type ID = typeof ID.Type
export const Info = Schema.Struct({
  id: ID,
  name: Schema.String,
  directory: AbsolutePath.pipe(optional),
  pinned: Schema.Boolean,
  order: NonNegativeInt,
  created: NonNegativeInt,
  updated: NonNegativeInt,
  count: NonNegativeInt,
}).annotate({ identifier: "ChatProject.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Chat = Schema.Struct({
  id: SessionID,
  title: Schema.String,
  directory: AbsolutePath,
  projectID: ID.pipe(optional),
  projectName: Schema.String.pipe(optional),
  pinned: Schema.Boolean,
  order: NonNegativeInt,
  created: NonNegativeInt,
  updated: NonNegativeInt,
  archived: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "ChatProject.Chat" })
export interface Chat extends Schema.Schema.Type<typeof Chat> {}

export const ListInput = Schema.Struct({
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(100)).pipe(optional),
  cursor: Schema.String.pipe(optional),
  projectID: Schema.Union([ID, Schema.Null]).pipe(optional),
  archived: Schema.Boolean.pipe(optional),
  pinned: Schema.Boolean.pipe(optional),
  search: Schema.String.pipe(optional),
  sort: Schema.Literals(["updated", "created"]).pipe(optional),
}).annotate({ identifier: "ChatProject.ListInput" })
export interface ListInput extends Schema.Schema.Type<typeof ListInput> {}
export const Page = Schema.Struct({ data: Schema.Array(Chat), next: Schema.String.pipe(optional) }).annotate({
  identifier: "ChatProject.Page",
})
export interface Page extends Schema.Schema.Type<typeof Page> {}
export const Create = Schema.Struct({ name: Schema.String, directory: AbsolutePath.pipe(optional) }).annotate({
  identifier: "ChatProject.Create",
})
export interface Create extends Schema.Schema.Type<typeof Create> {}
export const Update = Schema.Struct({
  name: Schema.String.pipe(optional),
  directory: Schema.Union([AbsolutePath, Schema.Null]).pipe(optional),
  pinned: Schema.Boolean.pipe(optional),
  order: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "ChatProject.Update" })
export interface Update extends Schema.Schema.Type<typeof Update> {}
export const ChatUpdate = Schema.Struct({
  title: Schema.String.pipe(optional),
  projectID: Schema.Union([ID, Schema.Null]).pipe(optional),
  pinned: Schema.Boolean.pipe(optional),
  order: NonNegativeInt.pipe(optional),
  archived: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "ChatProject.ChatUpdate" })
export interface ChatUpdate extends Schema.Schema.Type<typeof ChatUpdate> {}
export const Migration = Schema.Struct({
  projects: Schema.Array(Schema.Struct({ directory: AbsolutePath, name: Schema.String.pipe(optional) })),
  defaultDirectory: AbsolutePath.pipe(optional),
}).annotate({ identifier: "ChatProject.Migration" })
export interface Migration extends Schema.Schema.Type<typeof Migration> {}

export const Changed = Event.define({ type: "organization.changed", schema: { timestamp: NonNegativeInt } })
export const ChatChanged = Event.define({
  type: "organization.chat.updated",
  durable: { aggregate: "sessionID", version: 1 },
  schema: { sessionID: SessionID, timestamp: NonNegativeInt, ...ChatUpdate.fields },
})
export const Definitions = Event.inventory(Changed, ChatChanged)
