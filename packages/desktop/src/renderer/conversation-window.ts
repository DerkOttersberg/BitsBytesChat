import type { ConversationWindowTarget } from "@opencode-ai/app/conversation-window"
import { base64Encode } from "@opencode-ai/core/util/encode"

export function conversationWindowURL(target: ConversationWindowTarget | null | undefined, restored: string) {
  return target ? `/server/${base64Encode(target.server)}/session/${target.sessionID}` : restored
}
