# Chat images, cursor and panel tabs

The 0.3.10 candidate addresses the three follow-ups to the Codex screenshot comparison.

## Findings and changes

1. **Image flicker.** The shipped 0.3.9 renderer reproduced eight byte reloads and eight placeholder resets across sixteen unchanged job/catalog broadcasts. The card cleared its source whenever metadata objects changed. Image contents now load by session, artifact ID and revision. Equal contents keep their decoded PNG and DOM mounted. A genuinely new revision decodes before replacing the displayed image. Invalid or delayed replies cannot erase a loaded image, and owned blob URLs are released when replaced or disposed. File cards also reconcile metadata by artifact ID, preserving their DOM and keyboard focus across catalog refreshes. This establishes a specific image reset defect; it does not establish every possible cause of a reported full-chat refresh.
2. **Cursor.** Desktop main and embedded chats explicitly use the arrow cursor. Editable text keeps the text cursor and a contrasting caret; links and generated-image zoom keep their action cursors. There was no deliberate `cursor: none` rule in the inspected source. The native fixture checks computed styles. Software screenshots do not capture a physical Windows pointer or establish the cause of an OS/driver visibility problem.
3. **Tabs.** Each close target is inside its tab's visual bounds and is revealed on hover or keyboard focus. Only the title's trailing edge fades. The button remains a separate interactive element, with the filename as its accessible description. Touch layouts retain a visible close target and reserve its space. Reduced-motion preferences remove the transition. The tab strip scrolls, automatically brings an active tab into view, and preserves header action space in narrow layouts. Closing an inactive tab preserves the selected panel. Keyboard close restores focus to a surviving tab or the main chat's panel toggle when the last tab closes.

## Verification workflow

Run the production desktop build and package from `packages/desktop`. Use owned isolated profiles and local fixture providers:

- `verify-image-chat.mjs` with `BB_QA_RENDERING=1`: unchanged-image broadcasts, real PNG decoding, replacement failures, delayed replies, URL disposal, file-card identity/focus, tab hover/focus geometry and closing, light/dark, narrow windows, 125% zoom and reduced motion. It also retains image approvals, reference bytes, downloads, reload/navigation, provider errors, Office previews and side-chat checks.
- `verify-transcript-presentation.mjs`: completed-work folding, expanded output, chat navigation, scrolling, drafts, file presentation and permission regressions.
- `verify-five-flows.mjs`: sidebar activity, large approvals, arbitrary uploads, responsive task progress and composer geometry regressions.
- `image-content.test.ts` and `chat-workspace-state.test.ts`: dependency identity, stale/disposed replies and persisted panel-state bounds.

The replacement fixture controls fake revision replies. Its handler suppresses asynchronous replies from the real artifact lookup for those nonexistent revisions; otherwise the real lookup can legitimately win with an unavailable-content result. The ordinary image-generation tests use the real desktop bridge and local HTTP provider. No paid image request is made. Hidden capture setup has a deadline so an unready QA document cannot leave the test waiting indefinitely.

Accepted results, package hashes and the production benchmark comparison are recorded in `VERIFICATION.md`. The running user installation and server are preserved.
