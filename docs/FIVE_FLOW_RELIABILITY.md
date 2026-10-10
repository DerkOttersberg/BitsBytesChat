# Chat activity, approvals, attachments, task progress and audio

The 0.3.9 candidate implements the five requested follow-ups to the Codex comparison. The completed-turn presentation and file-card changes from 0.3.8 remain included.

## Plan and changes

1. **Sidebar activity.** Each main or side chat reads the shared server state. Working and retrying chats have an animated ring; chats awaiting approval or input have a labelled waiting indicator. Idle decorative dots are removed. Unread emphasis and chat actions remain usable, and reduced-motion preferences retain a static status.
2. **Large approvals.** The 0.3.8 production package reproduced the problem with 100 multiline command scopes in a 1080 × 600 window: Stop, Deny, Allow always and Allow once were below the viewport. Request contents now scroll inside a bounded chat-height container. Decision controls remain outside that scrolling area and wrap in narrow side chats. This confirms a layout defect; it does not establish the cause of the user's historical stuck chat.
3. **All file types.** Desktop picker and drop flows accept arbitrary file types. Images, PDF and text retain their existing model input path. Other files are saved as exact bytes with a stable managed reference and a usable local source path. Office files get a bounded text preview; archives get a bounded entry list. Models and tools can inspect the original source. The existing 20 MiB per-message budget has a clear explanation, including multiple-file and concurrent-picker cases. Acceptance does not promise that every model understands every binary format directly.
4. **Task progress.** A compact checklist and completed/total counter live in each chat's upper-right header. The disclosure shows real pending, active, completed and cancelled steps, supports keyboard dismissal, wraps long text and scrolls within the available space. Main and side chats use independent state. Completed progress remains available through idle and reload. Hidden or inert chat panels close their disclosures. The former desktop composer dock is removed. Saved todos load under the newer protocol, and live updates win over older fetch responses.
5. **Transcription.** Readiness checks dependencies rather than merely the existence of a process. First use prepares cloud audio components automatically and reuses the encrypted OpenRouter connection. A bounded key check fails before recording when the key is missing or rejected, with connection-specific messages that do not claim audio was already saved. Capture negotiates the microphone's supported rate and channel count, then resamples to durable 16 kHz mono audio. Provider failures retain the recording and offer Retry at the original composer. The recovery controls render outside the composer's clipping area, fit the chat width, and remain usable at narrower sizes. The new-chat layout now adapts to its height: short windows reserve room for the composer, and taller content can scroll. This prevents transcript attachments from pushing microphone/send controls off-screen. Cancelling preparation prevents a late capture. A settings connection check, explicit progress, bounded control requests and additional speaker-ID handling make failures easier to recover from.

## Verification

Native upload checks cover both composer implementations. They exposed a remaining extension filter in the newer composer and a legacy model-conversion defect that forwarded private managed file URLs as provider media inputs. Both are corrected: the original MIME/filename/reference remains in the transcript, while the provider receives the resolved source context. Binary, audio, Office and archive conversion regressions are covered separately.

First-use audio setup also handles an interpreter that started before its component libraries were installed: the health check activates the newly created library directory, and the initial dependency check has a longer bounded timeout than an already-ready check. The worker regression suite covers this ordering explicitly.

The final candidate passes 233 scoped unit tests and 64 native verification groups with zero renderer errors. Package hashes, exact suite counts and input/layout measurements are recorded in `VERIFICATION.md`. Native tests use owned isolated profiles, local provider fixtures and synthetic microphone samples. They do not submit paid image or speech requests or record a physical microphone. The automatic component setup test downloads the actual audio runtime into an owned fresh profile. These tests exercise transport, capture conversion, persistence and recovery; they do not measure a real provider's speech-recognition accuracy.

The app and server in the user's existing session are not restarted, closed or replaced by this workflow. The 0.3.9 installer is a separate candidate for the user to install.

## API references

- [OpenRouter transcription API](https://openrouter.ai/docs/api/api-reference/stt/create-transcription)
- [OpenRouter authentication](https://openrouter.ai/docs/api_reference/authentication)
- [ElevenLabs on OpenRouter](https://openrouter.ai/blog/announcements/elevenlabs-on-openrouter/)
