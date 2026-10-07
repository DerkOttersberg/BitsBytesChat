# Bits & Bytes Chat 0.3.2 — verification

## 0.3.2 phone connection and QR address selection

The reported iPhone failure was a timeout. On the actual running 0.3.1 app, OS enumeration placed two WireGuard interfaces before Wi-Fi; the QR blindly chose the first private IP (`10.77.77.2`). The physical Wi-Fi interface was `192.168.11.242/24` with gateway `192.168.11.1`. Mobile access was already listening on `0.0.0.0:24483`, and the executable had an enabled inbound Windows firewall allow rule for both Private and Public profiles. A direct HTTPS request to the Wi-Fi address returned HTTP 200 and the mobile page; its certificate includes that address. No firewall, network-category, trust-store or running-app changes were made.

The QR now ranks connected physical adapters using Windows route/interface metrics, places VPN/virtual interfaces last, and omits disconnected adapters. Metadata collection has a five-second limit and a cached portable fallback. Settings labels addresses with adapter names and marks non-LAN choices. Explicit choices are validated against the app's own current addresses, persisted, and retained when renewing the invitation; unavailable saved IPs fall back to the current LAN selection. Options retain stable URL identities across periodic refreshes so the visible selection matches the QR, and the picker has an explicit accessible label. Existing paired devices and settings are retained. The firewall guidance now acknowledges the active Wi-Fi's Windows network profile, including Public.

Desktop typecheck passed. Four network-selection regression tests passed, including this laptop's real VPN-first ordering with and without Windows metadata, renamed physical adapters, misleading virtual names, route priority and address filtering. All three Node HTTPS integration tests passed, including pairing/origin/host protections, persisted manual address selection, revocation and resumable uploads exceeding 25 MB. Physical iPhone reachability still requires the user's result; a local request is not proof of Wi-Fi client-to-client reachability.

The final compiled UI and the final packaged **0.3.2** executable each passed **eleven mobile interface checks with zero page errors**, using three requests to a local deterministic provider. The packaged build selected the actual Wi-Fi address ahead of both WireGuard interfaces and Hyper-V. The test checks the displayed QR URL, labelled choices, a manual switch, renewal of the invitation and selection stability after the settings' polling interval. Pairing/approval, actual shared-session messages in both directions, independent drafts, frozen skill context, Word/PDF.js and sandboxed HTML previews, reconnection and revocation remain covered. These use a local Edge phone viewport with certificate exceptions enabled, not a physical iPhone. An initial UI test exposed the option-identity reset; the final picker preserves URL identities and the final run passes.

All six CMD launcher checks passed for 0.3.2: declining the existing app, recovering only an owned disposable helper, clearing inherited Electron flags, current-window forwarding, the Mobile alias and preserving every pre-existing user process. The launcher now excludes child Node/MCP helpers from its list of app instances. Desktop chat/session execution code is unchanged; no new performance or transcription claims are made. Dutch accuracy benchmarking remains deferred.

Evidence: `.tools/qa/results/mobile-032.json`, `mobile-032-source.json`, `launcher-032.json` and their `.tools/qa` run logs. The Windows network-detection script in the packaged resources matches the source. Delivery: `packages/desktop/dist/0.3.2/win-unpacked/BitsBytesChat.exe`, product version **0.3.2.0**; installer `packages/desktop/dist/0.3.2/BitsBytesChat-win-x64.exe`, **177,759,968 bytes**, SHA-256 `3317b85cd83fdf7f1d4f719eee089e8e9942ae2046f76a82ef1706f631d3e1ee`. Both existing launcher names target this same release. The user's original 0.3.1 app stayed running, so they can test the existing address dropdown immediately or switch builds when ready. A new executable path can prompt Windows to allow network access again; choose the profile currently used by the Wi-Fi.

## 0.3.1 startup recovery and one desktop/mobile release

The regular build already contained mobile access, but a separately packaged earlier mobile executable and launcher made the releases confusing. Both `Start BitsBytesChat.cmd` and `Start BitsBytes Mobile.cmd` now launch **the same 0.3.1 executable**. The shared launcher reads the main package version, recognizes older desktop and mobile processes, offers explicit close/recovery choices and retains startup logs. The old mobile build script delegates to the main build; separate mobile packaging is retired. Older binaries remain historical outputs.

The actual Explorer installation had a worker `pyvenv.cfg` pointing at an absent `cpython-3.12-windows-x86_64-none` directory, while the compatible pinned **3.12.11** interpreter existed. The original startup awaited this failed audio initialization before creating any window, and the main Effect failure was not surfaced. Codex's Microsoft Store filesystem redirection exposed a different, healthy runtime to earlier tests. This diagnosis was checked against the normal Windows files through the loopback administrative share; it does not alter the app's data path or require that share for operation.

Startup now repairs a missing compatible Python home, preserves installed packages and backs up the original configuration. Artifact helpers receive the same repair. Component setup refreshes existing environments with `uv venv --allow-existing` using the pinned interpreter. Audio health initialization has a deadline; a failed audio worker leaves chat and mobile settings available with a visible Audio recovery message. Fatal startup failures show a dialog and retain the data, and startup logs identify the service stage.

Verified against the final packaged main executable:

- **Desktop typecheck passed**, including renderer, app and session UI. **12 focused tests passed with 46 assertions**, covering the existing durable host and four new runtime-repair cases: compatible recovery, retained packages/configuration, idempotence, valid existing homes, incompatible minor versions and absent components.
- **Five startup checks passed** using a copy of the normal Explorer settings, encrypted credential/key context, skills and worker. A deliberately missing local Python home reproduces the physical installation's failure despite Store redirection. The packaged app repaired it, created its chat window, retained the selected Whisper setting and connected account, and answered health/jobs/microphone discovery. A separate broken runtime without a compatible interpreter showed its Audio recovery message while chat and Mobile access settings still opened.
- **A live ChatGPT token refresh and completed subscription request passed** with that copied connection. The verified refreshed encrypted credentials were retained in the normal app's store only after checking that its encryption context matched and its original file had not changed; an encrypted original backup was kept. Chats, recordings, transcripts, skills and selected provider/model were not reset.
- **All six actual CMD checks passed** through Windows PowerShell 5.1, including a different working directory, inherited Electron flags, declining the user's existing process, recovering an owned disposable helper, opening a real 0.3.1 window, forwarding repeated launches and verifying the Mobile CMD reaches the same running instance. The user's stuck 0.3.0 process was left running for their close choice.
- **All ten mobile interface checks passed** against this same main executable: unified settings, HTTPS invitation/approval and secure cookie, shared desktop/phone session messages, per-chat phone drafts, shared access modes, frozen skills, Word/PDF.js preview, sandboxed HTML, reconnection, revocation and disable. Zero page errors; three requests to the local deterministic provider.
- **All eleven packaged desktop checks passed with zero renderer errors**, covering queue/steer/stop/resume, side chats, read-only Plan and saved revisions, Goal controls, multiple document tabs and revision cards, spreadsheet/code/HTML previews, terminal, Git review, browser controls and native V2 context admission. The engine/session renderer implementation is unchanged by this startup fix; the earlier performance evidence remains below.

Evidence: `.tools/qa/results/startup-031.json`, `launcher-031.json`, `mobile-031.json`, `release-031.json` and the corresponding desktop screenshots. Reproduction: `.tools/qa/startup-probe-prepare.mjs` (set `BITSBYTES_PROBE_SOURCE` to the normal profile when testing from a Store app), `startup-unified.mjs`, `launcher-03.mjs`, `release-03.mjs` with `BB_QA_EXECUTABLE`/`BB_QA_REPORT`, and `packages/desktop/scripts/verify-mobile.mjs` with `BB_MOBILE_EXECUTABLE` pointing to the main binary.

An automatic approval review rejected deletion of temporary copied credential/key files with the generic reason “blocked by policy.” The safer cleanup succeeded: the six encrypted test files were moved out of the OneDrive project into `%LOCALAPPDATA%\BitsBytesChat\tests\startup-backups`, preserving them locally instead of deleting them. Original user files were not removed.

Delivery: `packages/desktop/dist/0.3.1/win-unpacked/BitsBytesChat.exe`, product version **0.3.1.0**. Installer: `packages/desktop/dist/0.3.1/BitsBytesChat-win-x64.exe`, **177,754,654 bytes**, SHA-256 `6cf9f394f7d3fa966d7f0b215710a7dd7c425cc6bead4d9a58d79305b6622971`. Build/package logs: `.tools/qa/build-031.log` and `package-031.log`. Physical-phone Wi-Fi/firewall/certificate acceptance remains for the user's device; the mobile tests used a browser phone viewport. Phone audio uploads are supported; direct phone microphone capture is unchanged and remains outside the mobile release. Dutch accuracy benchmarking remains deferred.

## Previous release: 0.3.0

6 October 2026. The release keeps the existing data directory, chats, recordings, skills and encrypted credentials. It does not restart the user's running app. Reference research and the distinction between the Codex desktop, consumer ChatGPT and Claude are recorded in `REFERENCE_ANALYSIS.md`.

## Verified source behavior

- Desktop type checking, including app/session-ui, core type checking and engine type checking passed. The complete production engine, main process, preload and renderer build passed.
- **46 focused TypeScript tests passed (141 assertions):** 8 durable host tests, 14 request/attachment tests and 24 transcript, provider, protocol, side-chat and timeline tests. They cover exact retry IDs, unknown admission, retained queue edits, ordering/deletion, restart pause, frozen context/model, selected plan revisions, goal evidence and budget/quota stops without paid fallback.
- **All 11 source interaction checks passed with zero renderer errors.** Tests use an isolated local profile, fictional files and a deterministic local provider. They cover background queues, Enter/Ctrl+Enter/Stop/Resume, empty side chats, read-only Plan even under Full access, editing and implementing a saved revision, multiple MCP-generated files, automatic panel opening/unread tabs, document corrections and original-version cards, isolated HTML, generated code, one native terminal, Git review, browser inspection/click/close, goal completion and stalled continuation. Separate native V2 API checks cover prompt/context admission and Plan's synthetic context and command guard.
- **3 artifact-worker tests passed** with installed Word, Excel and PowerPoint: valid Word/slides PDF exports, rendered pages, Excel formula values 20 and 96 with no formula errors, source hashes unchanged, PDF/CSV/HTML/code creation, and rejection of an invalid Word file and unsafe filename. Word, spreadsheet and both slide pages were visually reviewed. Worker evidence: `%TEMP%\bitsbytes-artifacts-qa-n00hlh5p\results.json`.
- Seven original artifact skills are bundled beside the preserved intake package. Generic templates are optional; intake alone uses its specialized 13-field helper. Artifact dependencies are pinned in a separate Python environment. Transcription requirements are unchanged.
- Existing mobile code changed during packaging and was preserved in the final rebuild. Its **3 Node protocol tests passed**, covering HTTPS pairing, shared session/permission boundaries, credential filtering, resumable uploads above 25 MB, exact retries, interruption recovery and revocation. The test entry is bundled for Node before `node --test`; an initial Bun invocation did not initialize these Node hooks and was not counted as a pass. This is protocol-fixture evidence, not a physical-phone evaluation.
- Visual checks cover the plan card/tab, document PDF toolbar and sheet grid. The shipped composer uses native checked reasoning menus rather than the ChatGPT slider. Full access retains the muted orange exclamation indicator. The permanent panel toggle remains beside context usage; the panel + exists only beside its tabs.

Reproduction: `.tools/qa/release-03.mjs`, `packages/desktop/src/main/bitsbytes-runs.test.ts`, the focused app test files and `packages/desktop/resources/bitsbytes/test_artifacts.py`. Source reports/screenshots are `.tools/qa/results/release-03-source*`.

## Packaged delivery and performance

### Launcher recovery check

The reported silent CMD launch was reproduced: the user's v0.2.3 process was still running without a visible window, and v0.3.0 stopped immediately at Electron's shared single-instance lock. The CMD now calls its accompanying PowerShell launcher. It identifies the conflicting version/profile, offers an explicit close choice, prefers a normal window close, asks separately before forcing an unresponsive visible app to close, and retains startup diagnostics. It also clears inherited Electron CLI flags and sets the executable's working directory. The existing user process and data were left intact during this fix.

**All five launcher integration checks passed**, using the actual CMD through Windows PowerShell 5.1 from another working directory: conflict explanation and declining to close the user's copy; confirmed recovery of a disposable headless Electron helper; a real v0.3.0 application window despite inherited CLI/ASAR flags; forwarding another launch to that same window; and preservation of every original user app process. Reproduction: `.tools/qa/launcher-03.mjs`; report: `.tools/qa/results/launcher-03.json`. The app executable and installer were not changed. The first test's cleanup reported unsupported termination of nested Windows console hosts after the QA app had exited; cleanup was changed to close its test window normally, and the final run exited successfully. A real replacement of the user's running copy still awaits their close choice in the launcher.

The final **packaged Windows 0.3.0 executable passed all 11 interaction checks with zero renderer errors**. The packaged run additionally opens the proposed-plan card controls, checks the Full access menu/indicator, edits a goal budget in its tab and verifies that Resume gives a readable budget recovery action. Reports/screenshots: `.tools/qa/results/release-03-packaged*`. These results use the packaged engine and its native terminal binary, not the development renderer.

Launcher: `Start BitsBytesChat.cmd` with `Start BitsBytesChat.ps1` beside it. Executable: `packages/desktop/dist/0.3.0/win-unpacked/BitsBytesChat.exe`, product version **0.3.0.0**. Installer: `packages/desktop/dist/0.3.0/BitsBytesChat-win-x64.exe`, **177,754,553 bytes**, SHA-256 `766972fce9c535da4bc203bc4678514f6fcd1420fd381acbd49c985296e6da5d`. This personal build is unsigned. Use the launcher to load 0.3.0 and confirm its close choice if an old or invisible copy is running. Existing taskbar pins may still point at 0.2.3.

The final production composer comparison uses the unchanged 0.2.3 executable and final 0.3.0 executable, the same isolated profile, fonts ready, warm-up input, five samples and 55,000 characters. Both windows are hidden with background throttling disabled; no AI request is sent. Median: **20.9 ms before**, **20.8 ms after**, a **−0.1 ms** difference, within the noise of this small test. This is a rendering stress test, not a general speed guarantee; no performance improvement is claimed. Raw final reports: `composer-0.3-final-before-isolated.json` and `composer-0.3-final-after-isolated.json` under `.tools/qa/results`.

The earlier build measured **20.7 → 26.1 ms (+5.4 ms)**. Both raw reports are retained as `composer-0.3-before-isolated.json` and `composer-0.3-after-isolated.json`. The final pair was repeated because mobile source files changed during packaging and the app was rebuilt, not to discard that slower result. The original pre-change visible-window baseline, 20.4 ms, is also retained in `composer-0.3-before.json` and is not substituted into the isolated comparisons.

## Remaining verification and practical limits

The default shipped engine remains V1. The native V2 prompt/context path is tested separately; the unfinished upstream standalone V2 MCP implementation is not claimed as equivalent to V1. Artifact scripts use approved local access, not an OS sandbox. Office previews need installed Word/Excel/PowerPoint. Token budgets use reported input/output and are enforced at turn boundaries, so the active turn can exceed a remaining budget. The goal no-progress guard conservatively stops a continuation with no tool calls or repeated tool results. Goal completion evidence is an agent report, not independent proof of all outcomes.

New 0.3 live ChatGPT/OpenRouter/Google/Anthropic/OpenAI completion checks were not run. Earlier 0.2 live ChatGPT results remain historical below. The latest successful account catalog omitted GPT-6.1 Sol; the app preserves honest discovery and refresh behavior. Real subscription-limit exhaustion and Groq quota exhaustion were not triggered. A new 60–120 minute microphone run, GPU execution, share outage/retry and a fresh Explorer installation were not rerun for this interface release. Dutch speech accuracy remains deferred by request. Existing Mobile connection code was preserved, with its QR module's bundling corrected; actual Android/iOS pairing, long mobile recording and physical-phone upload were not evaluated in these checks.

## Previous release: Bits & Bytes Chat 0.2.3

6 October 2026. This release preserves the existing data directory, chats, skills, recordings and encrypted credentials. Source remains based on OpenCode v1.18.34. The app has its own identity and upstream updates are disabled.

## 0.2.3 permanent chat panel toggle

- Removed the side-panel + and its portal from the top bar. The panel toggle beside context usage is available even when the chat has no panel tabs. It opens an empty panel containing the add-tab +; the same toggle collapses it.
- Closing the last tab leaves the panel open and usable. Explicit open/closed state is persisted independently of the tab count. Older saved tabs, active selections, widths and collapsed states are preserved; older empty panels migrate to closed.
- Desktop type checking (including app/session-ui), the production build and packaging passed. Source and packaged UI checks cover the empty panel, the + appearing only inside it, toggle alignment/icon, keyboard activation, collapse after reload, closing the final tab, empty-panel persistence, adding tabs again and independent main/side drafts. Both final runs reported zero renderer errors. Verification targets chat pages with a context indicator; the separate welcome/draft screen has no context indicator. Initial smoke attempts were corrected to target that chat page and use the actual Close tab label.
- The production 55,000-character composer comparison used the same isolated profile, fonts ready, warm-up input and five samples: **17.7 ms before (0.2.2)** and **22.2 ms after (0.2.3)**, a **+4.5 ms** median difference. These small samples are diagnostics, not a general performance guarantee. Reports and screenshots: `.tools/qa/results/always-toggle-*`; timings: `composer-always-toggle-before.json` and `composer-always-toggle-after.json`.

Windows build: `packages/desktop/dist/0.2.3/win-unpacked/BitsBytesChat.exe`. Installer: `packages/desktop/dist/0.2.3/BitsBytesChat-win-x64.exe` (149,621,939 bytes), SHA-256 `8c27ad95974a80ec00f1f38165e19572104087d2fc08020944769d35c28da166`. Product version: **0.2.3.0**. The launcher targets 0.2.3. The user's running app was not restarted; close it and use the updated launcher. This patch does not change message queuing, modes, skills, providers or document processing.

## Previous release: 0.2.2 panel toggle

- Moved the shared panel toggle beside the context-window indicator in the main chat header. It uses upstream OpenCode's V2 `sidebar-right` icon and button styling, a pressed state while open, and localized Collapse/Expand tooltips and accessible labels.
- The + remains beside panel tabs. A new chat without a header retains its top-bar control. Embedded side chats do not duplicate the shared panel toggle.
- Desktop type checking (including app/session-ui) and the production build passed. Both source and packaged UI checks passed: matching header alignment, no duplicate top-bar toggle, collapse/reopen, keyboard activation, persisted collapse after reload, and separate main/side drafts. Zero renderer errors. The first packaged reload check acted before the newly selected chat finished mounting; waiting for the exact chat ID corrected the test synchronization. No source change was needed for that test correction.
- The final executable reports version **0.2.2**, Windows product version **0.2.2.0**. Source and packaged screenshots/reports are under `.tools/qa/results/panel-toggle-*`.
- The required production comparison used the same isolated profile, 55,000 characters, fonts ready, warm-up input and five samples. Median: **14.0 ms before (0.2.1)** and **14.7 ms after (0.2.2)**. Raw results: `composer-panel-toggle-before.json` and `composer-panel-toggle-after.json`. This small +0.7 ms difference is not a general performance guarantee.

Windows build: `packages/desktop/dist/0.2.2/win-unpacked/BitsBytesChat.exe`. Installer: `packages/desktop/dist/0.2.2/BitsBytesChat-win-x64.exe` (149,614,863 bytes), SHA-256 `14b571f262137e11b4fe153590f516d82d9a4d928adbb80d5a762070ecf016e3`. The launcher targets 0.2.2. Close the old app and use the updated launcher to load this version; the user's running app was not restarted. Chats, recordings, skills and credentials use the existing data directory. This patch does not change providers, transcription or document processing; those broader checks were not rerun.

## Previous release: 0.2.1 interface refinements

- Removed Documents & storage from the unified Settings dialog. Skills retain their template and output-folder fields; legacy destination values are preserved for existing skills.
- Panel + is beside its tabs; the collapsed/empty panel exposes its opener in the top bar. Collapse sits at the far right of the chat-tab bar. The separate review toggle is removed; Code review remains in the panel menu.
- `/side` creates a full engine fork through the last completed turn, with an empty-looking timeline and independent draft. The model receives the inherited context. A persisted display boundary hides only inherited turns, including after reopening. New responses remain visible; undo still hides later turns.
- Ask/Full access uses the native styled radio menu, with an orange exclamation indicator for Full. Model/reasoning controls are on the right. Main and side permissions remain independent.
- Explicit publication selects the document and opens a collapsed panel, including when Browser is selected. PDF export status events do not repeatedly change focus. Old previews remain visible while a revision exports. Preview uses styled page, Fit width and zoom controls without the native percentage dropdown.
- Direct read-only live model discovery returned HTTP 200 at 2026-10-06 16:59:52 UTC. The complete response omitted `gpt-6.1-sol`, including hidden entries. The listable catalog contains GPT-6 Astra, GPT-5.6 Sol/Terra/Luna and Daybreak Blue. The model picker now explains the missing model and offers refresh. No unsupported model is advertised as available.
- Desktop, app and session-ui type checks pass. 24 timeline/context tests (49 assertions) and 5 provider tests (38 assertions) pass. The first raw timeline test invocation needed the repository's `--conditions=solid` configuration; the correctly configured run passed.
- Interaction tests use an isolated profile, a local test provider and fictional documents. This release's tests do not modify user chats, credentials, recording files or the live server share. A real network model catalog lookup is recorded separately; no new live AI completion is claimed for this patch.

The final **packaged v0.2.1 executable** passed all **12 interaction checks**, with zero renderer errors. These cover settings removal, access styling and independent modes, `/side` context and new responses, panel controls, narrow composers, automatic document selection, collapsed-panel reopening, export focus, Fit width and reopening chats. Test provider labels deliberately use a long model name to exercise the real composer layout; responses come from the local fixture, not a live GPT request.

Performance on the unchanged v0.2.0 executable versus v0.2.1, using the same isolated profile and a 55,000-character composer input (five samples):

| Measurement | v0.2.0 median | v0.2.1 median |
|---|---:|---:|
| Immediately after startup | 21.1 ms | 39.9 ms |
| After fonts, warm-up input and 1.5 seconds settling | 20.7 ms | 16.1 ms |

The initial startup sample was slower; the settled comparison did not reproduce a typing slowdown. These small samples are diagnostics, not a general speed guarantee. All four raw timing files are retained. Dutch transcription accuracy remains deferred and the transcription engines are unchanged.

Final Windows output: `packages/desktop/dist/0.2.1/win-unpacked/BitsBytesChat.exe` and `packages/desktop/dist/0.2.1/BitsBytesChat-win-x64.exe`. The project launcher targets this release. The existing running v0.2.0 was not restarted; close it and use the updated launcher to load v0.2.1. Versioned packaging avoids overwriting the running executable. Existing taskbar pins to the old executable may continue to open that old build; launch this version and repin it if needed.

Installer size: 149,613,454 bytes. SHA-256: `5e27335f84e2a12a0365b5b92209c50918d0434538e572e5cbd8c61f5bf107a3`.

Reproduction: `.tools/qa/refinements.mjs`, `model-catalog-live.mjs`, and `composer-benchmark.mjs`. Result files are under `.tools/qa/results`.

An automatic approval review rejected cleanup of the temporary `.tools/qa/catalog-local/BitsBytesChat/desktop/Local State` file with the generic reason “blocked by policy.” That temporary test-profile file remains. It is an OS-encrypted profile-key copy, not an exported token or API key. The original profile was not modified.

## Earlier 0.2.0 release checks (historical)

- Packaged Windows app: unified settings and v0.2.0 footer; all 227 engine providers available, including Google, Anthropic, OpenRouter, OpenAI and ChatGPT plan.
- Side chat forks with the parent's access mode, then keeps its own draft and mode. Main draft survives side chat interactions.
- Real short microphone capture: pause, resume and square Cancel; recoverable audio retained; no prompt submitted; side chat does not inherit recording controls.
- Browser WebContentsView: navigation, back, typing, clicking, scrolling, inspection and PNG screenshot. Checked Node disabled, sandbox enabled and no preload bridge. A live ChatGPT tool call inspected the originating chat's browser; inspection from a different chat was rejected.
- Multiple verified Word files: separate PDF.js tabs; browser focus retained; duplicate publish idempotent; a changed file increments its revision and refreshes the same tab. Preview publication returns before Word export completes. Terminal and Git review use this same panel.
- Slash-selected intake skill becomes a chip and opens its frozen instructions. V1 messages retain compact file references and separate synthetic model context. V2 durable admission and exact retries preserve transcript/skill revisions even after the original recording changes.
- A synthetic long source was reconstructed from every numbered part, including its final passage. Document creation before reading the parts was rejected. This verifies data handling, not speech accuracy.
- Live ChatGPT token refresh, model discovery and completed inference passed. Live AI file-writing tests confirmed Ask waits for approval, Full does not prompt, simultaneous chats have independent modes, and returning to Ask prompts again. An Always response did not become a stored automatic approval.
- Provider settings survive an Audio settings save. Native credential set/remove uses the encrypted desktop broker. Other provider connections were not exercised without their keys.
- Desktop (including app/session-ui), core and engine type checks passed. Focused tests: 18 prompt/attachment tests (68 assertions), 5 provider transformation/catalog tests (38 assertions), all passed.

Reports and reproduction scripts are in `.tools/qa`: `unified.mjs`, `context.mjs`, `permissions.mjs`, `browser-live.mjs`, `composer-benchmark.mjs`, and their JSON results. Tests use temporary chats and fictional data; they do not write intake results to the live server folder. Initial test failures exposed a panel-menu stacking issue and test synchronization/selectors; these were corrected and the packaged suite passed.

## Provider availability and remaining checks

The successful account-specific ChatGPT catalog currently contains five models and does **not** expose `gpt-6.1-sol`. The picker refreshes from the public `/v1/models` endpoint, keeps cached choices on failure and shows the refresh error. It will include Sol when that endpoint exposes it for this account. No paid provider fallback occurs.

Live OpenRouter, Google, Anthropic and OpenAI API requests need their corresponding credentials. Groq quota and real subscription-limit exhaustion were not triggered. Dutch accuracy benchmarking remains deferred by request. A 60–120 minute live microphone endurance run, actual GPU execution, and a fresh Explorer-installed environment remain separate checks; earlier hour-long import and recovery tests are recorded below. Real pause/cancel, source delivery, Word export and live agent permissions were checked in this release. No accuracy percentage is claimed.

## Delivered build and performance

The final executable identifies as BitsBytesChat 0.2.0 (Windows product version 0.2.0.0). The final packaged UI suite passed all eight checks with zero renderer errors. The source/engine context suite passed eight checks, live permission suite three, and live browser ownership one.

Installer: `packages/desktop/dist/BitsBytesChat-win-x64.exe`, 149,601,438 bytes. SHA-256: `6ed2275329b1d4c8f9297aef3613421c69dfdb7e537ee2d08fb3775b5cdda04a`. This personal build is unsigned. Launcher: `Start BitsBytesChat.cmd`. The installer and unpacked application contain the same final production renderer and engine.

The production benchmark inserts 55,000 characters into a temporary composer and measures two animation frames over five samples. Before: 15.5 ms median. After: 24.0 ms median (**+8.5 ms**, slower). Raw samples are retained in the JSON reports. Cold-start samples varied considerably; this is a small stress test, not a latency guarantee. No performance improvement is claimed. The recording workflow now keeps source text outside the composer and uses one attachment chip. A first after-run during build activity was repeated once with the build finished; the final reported run still shows the regression.

## Previous-release evidence (0.1.x)

The following measurements and tests predate 0.2.0 and document the unchanged transcription/document foundations. Their old interface descriptions and installer checksum are historical.

# Verification — 6 October 2026

This is a runnable personal Windows build, not a completed endurance or Dutch speech-accuracy evaluation. Source is based on OpenCode v1.18.34 (`aec0b9a6d8898f68f923aaf08b7306d931fd9d76`), with its own application identity and disabled upstream updates.

## Composer update — 0.1.1

The custom toolbar and workflow selector are removed. The chat composer now contains the microphone, inline waveform/timer, pause/resume, cancel and Stop controls. Audio transcription provider selection lives in Settings. Stop creates a draft; skill execution happens when the user sends a chat request. Imported recordings and existing transcripts can also be added to the draft from Recordings.

The production renderer passed nine focused integration checks with zero renderer errors: composer placement, saved Parakeet/Whisper/Groq settings and upload disclosure, real microphone capture with pause/resume/minimization, cancellation, Stop completing local transcription without AI/document execution, cancellation during Stop followed by a fresh recording, complete 120,000+ character transcript insertion without sending, retained intake skill management, and authenticated document-tool creation with a per-job template snapshot and actual Word/PDF preview in an isolated test folder. These checks use short microphone captures and synthetic transcript fixtures; they are not a Dutch accuracy or endurance test. No AI request was submitted during these UI checks.

Three additional draft tests pass (9 assertions), covering preservation of typed requests and attachments, the original destination after changing chats, and empty speech. All 11 worker tests pass, and desktop/app/session-ui package type checks pass. Settings/configuration changes are serialized to prevent overlapping skill-copy operations. Cancelling a finishing transcription cannot append an obsolete transcript to a new recording's draft.

The enabled runtime copy of a skill contains app bindings for configured paths and document helpers; editable skill packages and the original Codex intake skill are preserved. Template selection is bound when document creation is requested, so recording no longer depends on template availability.
## Measured transcription speed

On this laptop (Intel Core i5-12500H; Parakeet v3 int8 through ONNX-ASR **on CPU**):

| Measurement | Result |
| --- | --- |
| Real imported MP3 duration | 63 minutes 29.234 seconds |
| Decode/import | 8.469 seconds |
| Transcription | 712.526 seconds — 11 minutes 52.526 seconds |
| Completed chunks | 127 of 127 |
| Transcript length | 55,130 characters |

This was the supplied **English** motivational recording. Startup/VAD loading and concurrent build activity were included in transcription time. This is one observed run, not a speed guarantee. The transcript was retained locally. Dutch accuracy testing was explicitly skipped at the user's request; no accuracy percentage or Dutch word-error rate is claimed.

## Passed checks

- Desktop and embedded OpenCode engine type checks.
- Eleven Python worker tests: all 13 intake fields, blank fields and text identifiers; unchanged template; numbered corrections; preserving other fields in partial corrections; idempotent repeated corrections; verified fallback/retry; repeated offline retry without extra local copies; template changes/unknown-field rejection; interrupted 60-minute chunk journal recovery; interrupted imports; committed-chunk crash recovery; concurrent document calls; crash immediately after document write; generic table corrections; stdio import without the Windows native-library deadlock.
- CPU transcription with the real hour-long file. GPU decode failure → CPU retry and Groq HTTP 429 behavior were tested with fault injection.
- Provider request transformation test: seven assertions for complete history, namespaced local tools, streaming/nonstored requests and removal of unsupported fields.
- Four existing OpenCode global HTTP API tests.
- Packaged app initialization, retained chat composer, default intake selection and local worker/microphone discovery.
- Complete skill export/import including attached template; imported package disabled; full version restoration.
- Engine streaming tool call → local MCP → 13-field verified Word intake; repeated job call reused its artifact; chat correction created a numbered revision.
- Actual Microsoft Word PDF export displayed through PDF.js. The generated fictional intake preview was visually inspected.
- Actual configured share template inspection and temporary write/read/delete access probe. Fictional intakes were saved in isolated local test folders, not the live intake folder.
- Live ChatGPT sign-in/model discovery/completed verification; token refresh plus another completed subscription request; live intake tool call with fictional Dutch source. The participant name and telephone were retained, an accompanying person stayed out of the formal contact field, and a transcript instruction attempting to change that role was ignored.
- Real microphone capture with pause/resume, minimization, Stop and durable audio. A separate short capture saved 3.0 seconds without errors.

The Windows-MCP check exposed OpenCode's indefinitely cached global configuration: writing settings and disposing sessions did not refresh MCP enablement. The fork now invalidates that cache as part of global disposal. Final focused checks are recorded in `.tools/qa/results/final.json`.

The initial 0.1.0 packaged build passed all six focused checks with **zero renderer errors**: Windows-MCP connects immediately on enable, disables immediately on disable, an explicit unconnected provider switch shows the connection gate, restoring the ChatGPT model updates the running engine, retained chat icons have usable dimensions, and a live AI skill test produces a verified document only beneath the local tests folder. The account remained verified with five discovered models; the user's selected `gpt-6-astra` and disabled computer-control setting were preserved.

The delivered NSIS installer is `packages/desktop/dist/BitsBytesChat-win-x64.exe` (0.1.1; 149,664,204 bytes). SHA-256: `2455A44B62D35979887FEB1D4226CE9CB27A0D5CFEB1DF49B798ED5FF737296A`. The runnable unpacked application is next to it under `win-unpacked`.

## Remaining acceptance checks

- A full 60–120 minute **live microphone** endurance run. An hour-long imported file and a simulated hour-long recording journal were tested; these do not establish microphone endurance, sleep behavior or power-loss recovery.
- Dutch speech comparison against manually checked passages — skipped by request.
- Actual GPU execution/failure on supported acceleration libraries. The installed default is CPU; hardware-failure recovery was simulated.
- Live Groq transcription/chunk quota handling with the user's key and live OpenRouter chat/tool calls with the user's key. Implementations exist, but no keys were supplied for these live checks.
- Real subscription usage-limit errors. No quota was deliberately exhausted.
- Windows control actions and their permission/cancellation prompts; only MCP connection is tested, with control restored to the user's original setting.
- A fresh Explorer-launched installation outside Codex's Microsoft Store data virtualization. The installer is unsigned. First use may require the component/model downloads and sign-in again.
- Additional real intake conversations, ambiguous role cases and larger/multipage templates. The supported 13-field intake and one fictional Dutch role/instruction case were checked; human review remains part of real use.

Reproduction scripts and raw metrics are under `.tools/qa`. Worker tests are under `packages/desktop/resources/bitsbytes/test_worker.py`. The initial packaged integration run passed thirteen checks before the cached Windows-MCP setting failed; the focused final run verifies the fix rather than concealing that initial failure.
