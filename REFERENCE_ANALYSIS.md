# Interface research and implementation

## Supplied queue screenshot — 8 October 2026

The user supplied a 750×156 reference image and a comparison image from this fork. This enables a direct comparison of the collapsed queue state: 13px composer inset, 32px row, 33px exposed strip, 16px queue corners, an overlapping 20px composer, bold message text, and Steer/trash/more controls. The fork uses Segoe UI to match the Windows capture. Sampled dark fills are `#2d2d2d` for the queue and `#363636` for the composer, with a `#3b3b3b` queue border and `#969696` actions. The implementation replaces the separated card and count heading with that arrangement. Actual [dark](docs/screenshots/035-queue-reference-dark.png) and [light](docs/screenshots/035-queue-reference-light.png) renders retain this fork's model, access and microphone controls.

This supersedes the queue appearance described below and the earlier lack of a reference screenshot for this particular state. The supplied images do not show the reference's open menu or editing transitions, so those continue to follow the existing verified interaction contract. Font rasterization can differ between native renderers; measured geometry and colors, rather than whole-image pixel identity, are verified.

The subsequent user feedback restores the six-dot reorder grip on hover, keyboard focus and while dragging, using the existing leading icon slot so the text does not shift. Queue reordering uses a separate native drag type rather than plain text, and both composer implementations exclude it from attachment handling. Drops outside the owning queue cannot insert its ID or reorder messages. Dark mode keeps the reference's `#363636` composer fill across idle, active and queued states; light mode remains unchanged. These mechanics are requested refinements beyond what the original still image can establish.

The next refinement replaces native HTML drag-and-drop with a pointer-captured reorder preview. Neighboring rows slide into their prospective positions during the gesture; the selected row follows the pointer within its owning list and settles on release. The host receives one reorder after the drop, while Escape, capture loss, chat closure or a changed queue cancel the gesture. A long list scrolls at its edges. This avoids the native blocked-drop cursor and preserves the visual order while the host acknowledges it.

The additional 724×184 interrupted-state image establishes a 33px pause header above the message row, its pause glyph, the exact notice “Queue paused because you interrupted,” a right-aligned play glyph and Resume label, and a divider inside the existing tray. Sampled fills remain `#2d2d2d` / `#363636`; the divider is `#363636`. The implementation uses the host's saved `user-stop` reason for that notice; recovery/storage pauses use the generic “Queue paused.” Actual [dark](docs/screenshots/035-queue-paused-dark.png) and [light](docs/screenshots/035-queue-paused-light.png) captures show the ordinary idle composer with the paused queue retained.

## User-directed simplification — 8 October 2026

The follow-up removes the Goal hours form and Goal panel, including restored panel tabs. `/goal` keeps a composer chip and the prompt supplies the objective and constraints. The compact status row keeps Pause/Resume/Clear. Queued editing restores the request in the ordinary composer without an editing banner, Undo or Cancel buttons; Send still replaces the same durable reservation.

A hidden visit to the current ChatGPT guest page confirmed that it did not expose queued-message editing during a response. No authenticated ChatGPT or Codex reference surface was available through browser control. Exact pixel matching, including dimensions and location against a new reference screenshot, remains unverified. The fork screenshots are actual isolated QA captures, never presented as ChatGPT screenshots. Public queue behavior is documented in [Prompting](https://learn.chatgpt.com/docs/prompting).

These changes supersede the Goal editor and queued-edit banner descriptions and screenshots below.

## Implemented interaction contract — 8 October 2026

The 0.3.5 candidate uses **Codex desktop** as the primary interaction reference and ChatGPT's per-message hover actions as the branching reference. The local Codex desktop bundle was inspected for control structure and optional-question clock behavior; public product documentation supplies the externally documented contract. Authenticated ChatGPT screens were not available for a new pixel comparison. The resulting patch reproduces the observed mechanics with this fork's design tokens and engine; it does not claim pixel identity or copy private application code.

This section supersedes the older descriptions below, including persistent `/side` forks, top-right Fork, the earlier narrower queue proposal, and a two-minute Recommended auto-answer. Those were replaced by the accepted implementation refinements. [TODO_RESOLUTION.txt](TODO_RESOLUTION.txt) maps every requested item to the final behavior.

| Interaction | Steps and visible state | Ownership/recovery contract |
|---|---|---|
| Idle Send | The submitted request appears directly as one user row; the composer clears after admission. An idle chat has no queue flash. | Optimistic and durable rows share one ID. A stale renderer busy flag is reconciled against the engine before presentation. Failed or unknown admission retains recovery. |
| Follow-up queue | While busy, Enter adds a compact row above the composer. Grip, Steer, actions and delete remain accessible. The full-width rail has 16px corners and a 30dvh scrolling limit. | Queue waits for the current drain to become idle. Steer is admitted separately and applied at the next safe provider/tool boundary, never as a rewrite of an already-running HTTP request. |
| Edit queued input | Actions → Edit removes its visible row/count and restores text, attachments, model, agent and reasoning in the main composer. Edit status and Undo remain available. Send replaces the reservation; Cancel restores the earlier draft when safe. | A durable hidden reservation keeps the same ID and increments its revision on replacement. Reload and late A → B → A responses cannot erase a newer independent draft. Attempted/uncertain admissions cannot be edited destructively. |
| Stop and later Send | Square Stop pauses follow-ups and Goal. Controls settle after provider/tool finalizers join. A later ordinary Send releases pending inputs in order; Goal stays paused. | The stopping gate prevents old cancellation from touching later work. Stop settles only that chat's detached questions/approvals. Storage/recovery pauses and uncertain delivery still require explicit intervention. |
| Question card | Shows one question, header and 1/n progress. Choices are numbered with descriptions and a Recommended badge when supplied. Keyboard numbers/arrows work; IME input is preserved. A single choice advances after 180ms; multiple choices require Next. Back/custom answers restore earlier choices; the final action submits. Skip advances with `[]`. | Recommended is initially focused, never submitted automatically. Required Dismiss stops the chat; optional Dismiss answers every preference with `[]`. Failed replies retain selections for explicit Retry. |
| Optional timer | Toggle in Settings → General. Foreground inactivity is 60 seconds followed by a 90-second countdown; a background chat uses 90 seconds. The counter is visible only in the last minute. Foreground conversation activity resets inactivity; card interaction snoozes this request. | Applies only to `isBlocking: false`. Expiry sends empty answer arrays. Required questions and permissions wait indefinitely for the user. Wait time is excluded from Goal work. The engine owns expiry across desktop/phone views. |
| Goal | `/goal` arms an objective chip. The compact row exposes status and active work with Edit/Pause/Resume/Clear. Edit opens the objective, token budget and explicit minimum hours, plus Save/Revert and retained reason/evidence. Achieved is dismissed after the next accepted ordinary message. | Goal identity survives edits. A monotonic active-time accumulator excludes paused, blocked, restarted and human-waiting periods. Completion needs evidence and the configured minimum; budgets and genuine blockers still apply. No filler is authorized to satisfy a duration. |
| `/side` | Opens only a side-panel tab while the parent chat/composer remain mounted. A fresh diagnostic conversation receives bounded current parent context for each input. `parent_progress` returns a fresh timestamped phase, objective, recent tools/messages, queue and blockers. | Only read/glob/grep/parent_progress are exposed, even under Full access. No copied parent transcript, Goal, commands, writes, tasks or MCP. Close/navigation archives only the owned child; legacy independent forks remain intact. Late creation/loading results are closed after navigation, including A → B → A. |
| Hover Branch | Hover/focus a user message or completed assistant response. Text messages show Copy; Branch in new chat also works for attachment-only input. There is no top-right Fork item. Branch navigates to a durable main chat containing the selected boundary. | The HTTP handler forwards an inclusive boundary. Recorded attachments and model/access are retained; execution receipts and Goal ownership are not inherited. Copy QA uses an owned buffer without changing the player's clipboard. |
| Read/edit/source/image | Existing tool rows show actual read/edit/apply-patch results. Recorded provider Sources form numbered pills and a Sources list. URL pills open an in-app browser. A successful image read says Viewed image with a 64×48 thumbnail and enlarged preview. | Sources require actual URL/document metadata; the renderer does not invent citation offsets. Images use bytes recorded in the successful tool result, surviving later file changes. A delayed source cannot leak its browser into a later chat visit. |

The engine now separates durable admission from execution through receipts recording input ID, revision, frozen-content fingerprint, stage and owning turn. Exact retries reconcile; conflicting ID reuse returns a typed 409. Explicit Resume continues the existing input without appending a duplicate user message. Both V1 and V2 obey the shared ownership contract while retaining their native runners.

The native checks use a controlled provider and the real renderer, HTTP API, tools and host journal. Paired phone checks cover the same wizard, reload recovery, failed reply and exact explicit retry. Software offscreen paints verify current light/dark/narrow layouts without showing a native window; a two-hour hidden normal-renderer run checks repeated cancellation/restart recovery. These are evidence for this fork, not an exhaustive test of all private reference features or physical iOS behavior.

Current candidate screenshots use fictional QA content. The image enlargement uses a fresh deterministic 640×400 fixture; the test changes its source afterward and verifies that the preview still shows the recorded bytes. Captures wait for settled layout and subsequent paints and record the actual viewport/theme.

| Visible steps | Candidate evidence |
|---|---|
| Question wizard | [Light](docs/screenshots/035-question-light.png), [860×620](docs/screenshots/035-question-narrow.png), [multiple choices](docs/screenshots/035-question-multiple.png), [last-minute optional timer](docs/screenshots/035-question-timer-dark.png), [paired phone](docs/screenshots/035-phone-question.png) |
| Queue editing | [Queued](docs/screenshots/035-queue.png), [reserved in composer](docs/screenshots/035-queue-edit.png), [Cancel restores the previous draft](docs/screenshots/035-queue-cancel.png), [Send runs the changed input once](docs/screenshots/035-queue-sent.png) |
| Goal and message controls | [Goal editor in dark theme](docs/screenshots/035-goal-dark.png), [Copy/Branch hover](docs/screenshots/035-hover-branch.png), [temporary diagnostic Side chat](docs/screenshots/035-side.png) |
| Tool results and references | [Read](docs/screenshots/035-read.png), [edit/apply patch](docs/screenshots/035-patch.png), [recorded Sources](docs/screenshots/035-sources.png), [recorded image enlargement](docs/screenshots/035-image-enlarged.png) |

Reference sources: [Codex Queue/Steer and remote engineering](https://developers.openai.com/blog/mastering-codex-remote-for-engineering), [Goals cookbook](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex), [Goal use cases](https://learn.chatgpt.com/docs/reference/slash-commands/developer-settings/use-cases/follow-goals), plus local Codex desktop 26.930.7945.0 (`bootstrap-C8gUBg5L.js`) for the observed optional timer and card structure. [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode) supplies a public comparison for interruption and queued follow-ups. Exact validation and current delivery status are in [VERIFICATION.md](VERIFICATION.md).

## Historical analysis

The dated sections below retain the original comparison and earlier implementation decisions. Where they differ, the implemented interaction contract above applies.

## Reliability follow-up — 7 October 2026

The public [Codex remote engineering guide](https://developers.openai.com/blog/mastering-codex-remote-for-engineering) separates Queue from Steer and emphasizes intervening in ongoing work. [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode) documents interruption and queued-message controls. For this fork, the practical requirement is that a user's Stop, Delete, edit or reorder must still take effect while the host waits for engine status. Delayed-inspection tests exposed violations of that requirement; the unreleased host now validates the current queue selection before admission and checks Stop again before dispatch.

The phone remains a control surface for the same Windows engine. Its recovery changes address temporary startup failure, stalled metadata polling and responses arriving after navigation. They do not expand background microphone support or imply physical Safari verification. Controlled local measurements are effectively unchanged; the intent of this batch is predictable controls and recovery. Exact checks, retained samples and practical limits are recorded in `VERIFICATION.md`.

Long histories also matter during background queue control. The host previously reread the entire transcript on every busy poll. It now uses status-only reads while a never-sent normal request waits, retaining full history for steering, uncertain admission/retry reconciliation and Goal evidence. A local 128-message comparison removes 20 history downloads per 20 busy polls in both engine protocols; idle completion still retrieves the complete history. The performance figures and their scope are recorded in `VERIFICATION.md`.

The same principle now applies to document tools: a long source should remain available without requiring one oversized tool response. Large inspections produce numbered parts from a saved snapshot, while ordinary templates keep their structured inspection. Tests verify exact reconstruction and stable source identity across later tool calls. The actual engine/MCP fixture exercises this under Ask access. This improves source handling; it does not imply that a model has read parts it never requested or gained a larger context window.

Intervention also needs a clear failure contract. Actual storage-fault checks reproduced Stop leaving a provider connected and rejected saves later admitting work automatically. Stop now attempts interruption despite its save error, while failed durable writes pause automatic work and retain their error. Explicit Resume remains required. Earlier uncertain delivery timestamps survive a stopped retry so engine reconciliation can find the original admission.

Review should keep the source the user selected. Historical Plan review now survives unrelated run updates; Revert restores that revision and Save creates a new one. Plan/Goal reads preserve current content after a failed or delayed response. Their compact read model omits unrelated frozen prompts while full queue editing and recovery stay available. Saved layouts, draft images and Plan/Goal metadata are validated before reaching the interface; damaged originals remain recoverable. These are locally verified usability and recovery choices, not claims of private reference implementation parity.

## Morning review — 7 October 2026

The comparison uses public behavior and local tests. It does not reproduce private ChatGPT, Codex or Claude internals.

| Area | Reference behavior | Bits & Bytes choice and verification |
|---|---|---|
| Follow-ups | Codex separates Queue from Steer. Claude Code can deliver queued messages inside an ongoing turn and offers Send now. | Enter waits for engine idle; Ctrl+Enter steers at the next supported boundary. Stable IDs reconcile uncertain admission. Queue, edit and steer were exercised in the production app. |
| Stop | Claude Code's Esc interrupts and then sends pending messages. | Stop pauses pending inputs and active goals. Resume is explicit, preventing a canceled operation from immediately continuing through a queued request. |
| Side questions | Codex offers context-connected side chats. Claude Code's `/btw` is a tool-free overlay that does not enter the main history. | `/side` is a persistent independent conversation with inherited context and an initially empty visible history. A real GPT-5.6 Luna request retrieved the parent's codeword. |
| Plans and permissions | Planning separates investigation from execution; harness permission modes have different policies. | Plan remains read-only under Full access. The real model produced the plan card without creating its proposed file; deliberate forbidden-command tests checked engine enforcement separately. |
| Recovery | Claude Code checkpoints editing-tool changes; shell and external changes have limitations, and Git remains useful for durable history. | Artifact snapshots retain explicit revisions; Git backs up the fork. This is not a universal filesystem rewind. Concurrent publications retain both versions, and missing versions are rejected. Damaged optional state preserves original bytes; valid neighboring queues/artifacts remain usable. |
| Phone | Codex remote access keeps desktop work available through phone controls. | The paired LAN page shares laptop sessions and tools; durable phone recording is original functionality. The laptop owns transcription, credentials and documents. Phone recording is tested with actual browser MediaRecorder, while physical iOS background capture remains unverified. |

Sources: [Codex remote engineering](https://developers.openai.com/blog/mastering-codex-remote-for-engineering), [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode), [Claude Code permissions](https://code.claude.com/docs/en/permissions), and [Claude Code checkpoints](https://code.claude.com/docs/en/checkpointing).

For recording, [MDN's MediaRecorder guidance](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/dataavailable_event) explains why timeslices are not an elapsed-time clock. The app uses an independent timer and persists encoded chunks. Safari's AAC/MP4 support is documented by [WebKit](https://webkit.org/blog/11353/mediarecorder-api/). Closing a tab can lose unflushed audio; header-only recordings are rejected. No Dutch accuracy percentage is inferred from synthetic microphone tests.

Reference date: 6 October 2026. The reference in this conversation is the Codex desktop chat interface. Consumer ChatGPT has a different set of controls. The file/artifact reference is Claude. This fork implements the useful behavior on its own OpenCode engine; it does not copy private application code or promise identical server internals.

## Messages during work

The reference separates a follow-up that waits from one that steers current work. Its primary send control is an upward arrow, Steer uses a bent arrow, and Stop uses a square. Labels and keyboard shortcuts explain the difference without a reasoning slider or a large workflow bar.

Bits & Bytes defaults to Enter = Queue, Ctrl+Enter = Steer, Shift+Enter = newline. While working, the composer shows the alternate action beside Stop. Settings → General can change the default follow-up action. Queue rows have edit, reorder, delete, retry and side-chat actions. Editing holds the original until the replacement is submitted; canceling the edit restores the previous draft. Stop pauses pending follow-ups as well as a saved goal. Resume is explicit.

The Electron host, rather than the mounted composer, owns a persisted per-chat journal. Main and side chats can drain independently while minimized or while another chat is visible. Stable message IDs reconcile an ambiguous acknowledgment against engine history before another message is dispatched. Restart pauses unfinished work for review. An uncertain delivery stays visible for retry; it is not silently duplicated. Stop cancels that chat's preparation/admission signal. Cancellation before its prompt POST retains an unsent request; cancellation after the POST begins retains uncertainty until the original ID is reconciled. Local source I/O already in progress may finish, but cannot then admit the stopped prompt.

Journal acknowledgement waits for the snapshot containing a request, including repeated admission IDs after a write failure. Overlapping queue changes can share one write; changes arriving while it is in flight wait for the next snapshot. This keeps earlier acknowledgements independent of later traffic while retaining the restart pause.

Delivery history belongs to the saved request across retries. If a new preparation is stopped or fails before its POST, an earlier possibly admitted attempt remains uncertain and still requires reconciliation. Only the admission boundary can classify a first preparation failure as proven unsent. This distinction keeps source recovery available without letting Resume silently replay uncertain work.

OpenCode V2 admits Steer at its next safe provider-turn boundary. It cannot rewrite a tool action already executing. Legacy sessions use the retained legacy admission path. OpenAI's documented Responses steering has transport-specific behavior; this app's subscription adapter uses streaming HTTP, so these controls do not claim to expose every native OpenAI WebSocket steering behavior.

Sources: [Prompting](https://learn.chatgpt.com/docs/prompting), [Responses steering](https://developers.openai.com/api/docs/guides/steering), and the installed desktop interface, inspected read-only.

## Plan mode

The reference uses a lightbulb chip and a planning placeholder. Questions remain part of the conversation. An assistant proposal becomes a named, expandable card with an implementation action. A panel lets the user inspect or edit the proposal before implementation.

`/plan` enables the native Plan agent in this fork. The host snapshots that mode with each submitted message. Engine authorization denies changes, commands, write-capable MCP tools and subagent execution even under Full access. Read tools and native structured questions remain available. This boundary is enforced independently of the agent's instructions.

Only assistant Plan output containing a top-level `<proposed_plan>` block becomes an actionable card. Tags in fenced examples remain text. Streaming proposals can be read but cannot be implemented until complete. The Plan tab supports Edit, Save, Revert, revision selection and Markdown export. Implement submits the exact selected saved revision, returns to Build and keeps a compact visible request. Native V2 keeps the detailed instruction context in a local attachment rather than expanding it into the visible user message.

Source: [Slash commands](https://learn.chatgpt.com/docs/reference/slash-commands) and the installed desktop interface. Local revision storage and permission enforcement are this fork's implementation choices.

## Goal mode

The reference uses a target chip and a compact goal row, with status, objective and usage/time information. A goal is an ongoing objective rather than just an agent name. It needs a durable lifecycle and explicit stop/resume controls.

`/goal` arms the next request as a saved objective. Replacing unfinished work requires confirmation. The row opens a Goal tab for editing the objective and optional token budget. The host stores active, paused, blocked, usage-limited, budget-limited and achieved states. Completion requires a nonempty verification-evidence report from the agent. This is an evidence requirement, not an independent proof that every possible outcome is correct.

Continuation waits for engine idle, user follow-ups and pending interaction. It uses the same provider and current permissions. The conservative no-progress guard stops a continuation with no tool calls, or repeated tool results, as blocked. A quota error or reported token budget stops continuation visibly. Budgets use reported input/output tokens and are checked at turn boundaries, so an in-flight turn can exceed the remaining budget. Restart requires Resume. There is no automatic switch to a paid provider.

Sources: [Long-running work](https://learn.chatgpt.com/docs/long-running-work), [Goals cookbook](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex), and the installed desktop interface.

## Skills and document tools

The public skill pattern is a focused `SKILL.md` package with task instructions and supporting resources. Private OpenAI skills and an exhaustive hidden skill catalog are not available to reproduce. This release supplies original local packages using established libraries:

| Skill | Main helpers | Preview |
|---|---|---|
| Documents | python-docx; template inspection and precise edits | Word PDF export / PDF.js |
| PDFs | reportlab, pypdf, pdfplumber, PyMuPDF | PDF.js and rendered page images |
| Spreadsheets | openpyxl, pandas; Excel recalculation | Sheet grid with formula tooltips |
| Presentations | python-pptx | PowerPoint PDF export / PDF.js |
| Data analysis | pandas, matplotlib | Published data, charts and reports |
| Code / HTML | Retained file tools or artifact scripts | Code viewer; isolated HTML Preview/Source |
| Skill creator | Guided drafting and `save_skill` | Editable local package, tests and revisions |

The existing Bits en Bytes intake package remains separate. Arbitrary new skills are not forced into its 13-field Word-table helper. Templates are optional and destinations belong to individual skills. Creation and test chat use the engine's selected model/provider. Newly created skills remain drafts until enabled.

The artifact Python environment is separate from transcription, with pinned dependencies. The workflow is inspect → create/edit → validate → render/review → publish. `create_artifact` covers common structured files, `run_artifact_script` supports advanced edits, `inspect_artifact` reads real contents, `read_artifact_pages` returns preview images to the model, and `publish_artifact` validates files made by other tools. The existing intake helper retains its formatting and verified-save behavior. Long recording sources require every numbered part to be read before artifact creation/publication.

Sources: [Build skills](https://learn.chatgpt.com/docs/build-skills), [OpenAI document tooling examples](https://developers.openai.com/cookbook), and [openpyxl formula documentation](https://openpyxl.readthedocs.io/en/latest/simple_formulae.html). openpyxl does not calculate formulas; the app uses Excel for cached formula values.

## Multiple files and artifact panels

Claude's public artifact pattern separates conversation from a named preview, with downloadable files and versions. Its create/edit-files capability covers documents, spreadsheets, slides and PDFs. This app follows that interaction pattern using local files and the existing right panel.

Each validated output has a stable ID, originating chat/turn, file type, content hash and immutable revision snapshot. A response can publish several files; cards in chat open the corresponding tab. The first output of a response opens a collapsed panel. Later outputs create unread tabs without repeatedly taking focus. Background chat outputs remain attached to their own chat. Revisions update the existing tab and preserve earlier snapshots. Earlier chat cards open the revision published by that response; the preview also offers the latest revision and version history.

Word and slides are previews, edited through chat or their installed Office app. PDF export is queued in a separate process and does not block transcription or the agent's next step. Spreadsheets show rows in pages of 200 and the first 100 columns, with a visible notice for wider sheets. Code files use the retained file viewer. HTML has Preview and Source, an isolated iframe, no privileged app bridge, and blocked network connections from scripts. Office, PDF, data, image and HTML panels share Save copy, Open in app, Show in folder and retry controls.

Sources: [Claude artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them), [Create and edit files](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude), and [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view).

## Practical limits

This remains a local Windows application with online chat providers. It does not import account history or private ChatGPT/Claude account context. Artifact scripts run with the chat's approved local access; they are not an operating-system sandbox. Word, Excel and PowerPoint previews depend on installed Office applications. Live provider checks, Dutch transcription accuracy and long microphone recordings are documented separately in the verification notes rather than inferred from a local test provider.

The shipped desktop uses the existing V1 engine with the updated composer. The host also supports the native V2 prompt/context API, tested separately for admission and Plan permissions. The upstream standalone V2 engine still has unfinished MCP integration; this release does not switch the default engine or claim complete V2 MCP parity.
