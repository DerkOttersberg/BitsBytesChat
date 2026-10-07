# Improvement and verification session — 7 October 2026

Work until approximately 11:00 Europe/Amsterdam. The user requested about two hours of testing, debugging and improvements, then specified Git backup as the first priority and added real AI conversations to the goal.

1. Create a private `DerkOttersberg/BitsBytesChat` repository and push the complete custom source checkpoint, retaining upstream history. Keep credentials, recordings, local test profiles, models and generated binaries outside Git.
2. Finish direct phone recording, including pause/resume, cancellation without sending, durable chunk recovery, resumable upload and attachment to the original chat draft.
3. Test actual app conversations with a cheaper GPT model by default. Use stronger models only for tests that require them; use existing authorized credentials and report availability errors honestly.
4. Exercise queue/steer/stop, simultaneous and side chats, permissions and Plan/Goal modes, compact attachments, document ownership/previews and mobile reconnection. Compare relevant choices with official Codex and Claude Code documentation.
5. Measure startup/composer/mobile performance, run focused regression checks and meaningful endurance/error tests. Prioritize stability and simplicity over adding unrelated features.
6. Package the Windows update, preserve existing user data, push subsequent verified changes and record measured results and remaining physical-device checks.

Dutch transcription accuracy benchmarking remains deferred at the user's request. Production performance comparisons must use comparable workloads. Tests use isolated app profiles and must not restart or close the user's running app.

## Completed verification

The private repository and verified 0.3.4 Windows release are published. Direct phone recording, durable recovery, preview revisions, admission recovery and terminal initialization fixes are included. Real app conversations used GPT-5.6 Luna throughout, covering context, tools, document skills, revisions, Plan, Goal, approvals, long source input and queue/steer/stop/resume. The final packaged run also verified natural ChatGPT token refresh and safely preserved the encrypted update. Stronger models were unnecessary.

The 65-minute recording and full upload/CPU processing passed. Controlled performance reports retain all samples, including slower runs. See `VERIFICATION.md` for the final checks and remaining physical iPhone, Dutch accuracy and unavailable-provider limitations. Runtime release tag `v0.3.4` remains tied to its packaged source commit; subsequent documentation and QA-script updates are on `main`.
