export * as DurableEventManifest from "./durable-event-manifest"

import { Event } from "./event"
import { SessionEvent } from "./session-event"
import { SessionV1 } from "./session-v1"
import { ChatProject } from "./chat-project"

export const SessionDurable = {
  definitions: Event.durable(SessionEvent.DurableDefinitions),
  schema: SessionEvent.Durable,
} as const

export const Durable = Event.durable([
  ChatProject.ChatChanged,
  ...SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined),
  ...SessionEvent.DurableDefinitions,
])
