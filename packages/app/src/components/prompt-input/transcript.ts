import type { PromptSession } from "@/context/prompt"

// Capture the destination before recording starts, so changing chats cannot
// overwrite the new chat's draft or lose the original draft's attachments.
export function captureTranscriptDraft(target: ReturnType<PromptSession["capture"]>, describe: (id: string) => string) {
  return (transcript: { text: string; path: string; jobID: string; revision?: number }) => {
    if (!transcript.text.trim()) return
    target.context.add({
      type: "file", path: transcript.path,
      comment: describe(transcript.jobID),
      attachment: { kind: "transcript", id: transcript.jobID, name: "transcript.txt", ...(transcript.revision === undefined ? {} : { revision: transcript.revision }) },
    })
  }
}
