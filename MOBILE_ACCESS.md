# Bits & Bytes Chat — mobile access

The phone connects to the **same engine and sessions on your Windows computer**. Messages sent on either device appear in the same conversation. The computer executes AI tools, transcribes uploaded recordings, creates documents and writes to the server share. Provider credentials remain on the computer. Each device keeps its own unsent drafts.

## First connection

1. Open **Start BitsBytesChat.cmd** or **Start BitsBytes Mobile.cmd**. Both launch the same **0.3.4** application with mobile access included. If an older desktop/mobile copy is still running, the launcher offers to close it first. Your existing `%LOCALAPPDATA%\BitsBytesChat` data and credentials are retained.
2. Open **Settings → Mobile access → Enable mobile access**. Connect both devices to the same Wi-Fi/LAN. If Windows prompts, allow the executable on the profile used by that Wi-Fi; Windows can classify it as Public even on a home network. The app does not alter firewall rules.
3. Choose **Pair a phone** and scan the QR code. The QR now prefers connected physical Wi-Fi/Ethernet adapters over VPNs and virtual networks. **Connection addresses** shows the adapter name and marks VPN/virtual choices. An explicitly selected address is remembered for renewed QR codes and subsequent app launches while that address remains available; after an IP change the current LAN address is selected instead. Windows route/interface metadata is read with a five-second limit and cached; a portable fallback ranks recognizable VPNs and point-to-point addresses last.
4. This local server uses a self-signed HTTPS certificate. On the phone, check the address and SHA-256 fingerprint shown in the desktop settings before accepting the browser's certificate warning. The app does not install system trust certificates. Fingerprints change when a certificate expires or must be regenerated for another network address.
5. Enter a device name on the phone, request pairing, and **Approve** it in desktop settings. The invitation works once and expires after five minutes. Bookmark the address for subsequent use; the device cookie lasts 30 days unless revoked.

Keep the computer awake with the mobile-enabled app running. It may be minimized. Closing the app, sleeping the computer or disconnecting its network disconnects the phone; reopening and reconnecting restores access. **Revoke** removes an individual device. **Disable mobile access** stops the listener.

The unreleased reliability branch keeps the composer available during a temporary startup failure and retries connection metadata. A metadata read that stalls for 15 seconds is cancelled so subsequent polls can reconnect. Delayed responses from an earlier visit cannot replace the latest chat after switching away and back. Large queued sources no longer enlarge every status poll; the host retains the full request for explicit Resume. Stop pauses follow-ups and releases stopped waiting state once the engine is idle, and queue errors show the existing recovery messages. Updates retain selection and focus in unchanged messages; artifact cards still offer their current saved revisions. Unsent drafts remain on the phone; this retry does not resend messages or upload audio.

Spreadsheet previews show row numbers and follow the rows actually returned. Large pages can contain fewer than 200 rows; Previous returns through visited pages. Long values/formulas carry a preview notice, and Download retains the complete saved revision. Paging controls wait for reads, and a failed read can be retried.

### If the phone times out

A VPN address such as a WireGuard tunnel's `10.x.x.x` address generally does not work from a phone on the computer's Wi-Fi. Select the physical Wi-Fi/Ethernet option and scan the QR again. On the laptop examined for this fix, the Wi-Fi URL was `https://192.168.11.242:24483`; this is a diagnostic example, not a hardcoded app default, and DHCP may change it. The old QR chose `10.77.77.2` because the VPN appeared first in OS enumeration. The running server returned its mobile page over the Wi-Fi URL and already had a Windows allow rule for the active Public profile.

If the correct address still times out, check that the phone is on the same LAN rather than a guest Wi-Fi, and that its VPN and the router permit local-network traffic. A certificate warning is a separate step after reaching the server. [Mozilla's Firefox for iOS instructions](https://support.mozilla.org/en-US/kb/certificate-warnings-firefox-ios) describe **Advanced** and the option to visit the site. Check this app's local address and displayed certificate fingerprint before proceeding; system trust settings are not changed.

## Available on the phone

- Open existing conversations across projects, create chats, send messages, queue messages, steer current work and stop execution. The phone reads and writes the same session IDs as the desktop, rather than syncing a second database.
- Select any connected provider/model and its available reasoning levels. Connections and keys are configured on the computer. Provider switching stays explicit.
- Share each conversation's Ask for approval / Full access setting; answer pending permissions and structured questions.
- Attach enabled skills using their frozen revisions. Read skill and transcript attachments without expanding source text into the visible message.
- Upload MP3, WAV, M4A, MP4, OGG, FLAC or WebM files up to 1 GB. Requests carry at most 4 MB of audio. Select the same original file again after an interrupted upload to resume verified chunks. Audio imports and transcription run on the computer using its selected Audio setting. Groq sends audio to Groq when selected; local engines process it on the computer.
- Attach completed transcripts and preview/download generated Word, PDF, presentation, spreadsheet, image, HTML and code artifacts. Word/PDF previews use the existing verified artifact registry and PDF.js. HTML previews execute in a separate sandbox with network and app access blocked.

Desktop layout and phone layout adapt to their screens. Unsent drafts stay on their originating device; model context, submitted messages, running work, permissions and artifacts are shared. The chat drawer shows the latest 1,000 unarchived sessions and refreshes periodically.

This release provides **direct phone microphone recording and audio file uploads**. Use the microphone in the composer. While recording, the square cancels, the middle control pauses/resumes, and the upward arrow finishes and attaches after transcription. Send remains a separate action. The paperclip chooses an existing audio file.

Keep the recording page in the foreground and the phone unlocked. iOS can interrupt microphone access when switching apps or locking the screen; this is not guaranteed background recording. Encoded chunks are saved progressively in this browser's IndexedDB. Cancel retains them on the phone without sending or uploading. **Audio uploads → Recordings on this phone** offers Finish, Download and Delete. A second tab cannot take over a live recording. Closing a tab preserves completed chunks, although the browser's final unflushed buffer may be lost. A very early AAC chunk can contain only a header; the laptop rejects files with no decodable audio. Clearing browser/site storage removes recordings that have not been uploaded.

Finish uses bounded, resumable requests above 25 MB. A lost acknowledgment retries the same server upload; a finished transcript attaches to the draft where recording began, even after changing chats. It never automatically sends a chat message. Once the upload is complete, the laptop continues transcription while the phone page is closed. Select local Parakeet, local Whisper or optional Groq in the laptop's **Settings → Audio**; Groq sends audio to that provider.

The desktop terminal/browser panels, skill editing and remote access outside the LAN remain desktop-only. Dutch transcription accuracy benchmarking remains deferred. No router ports are forwarded and no cloud relay is installed.

## Storage and access

Mobile settings, hashed device tokens, the local HTTPS certificate and resumable upload journals live beneath `%LOCALAPPDATA%\BitsBytesChat\mobile`. The certificate password is encrypted using Electron's Windows credential encryption. The phone receives a Secure, HttpOnly, SameSite=Strict cookie; it never receives the engine password or AI-provider credentials. Only explicitly implemented mobile methods are exposed, with origin/host checks and a private-network address restriction.

The Windows executable is `packages\desktop\dist\0.3.4\win-unpacked\BitsBytesChat.exe`. Keep its accompanying files together. Desktop and mobile access share one build, **0.3.4**. Upstream auto-updates remain disabled. `dist\mobile` contains the historical separate build; both project launchers now target the regular application. The single-instance check protects the shared data profile across both executable names.

## Build and verification

Build from the project root with **Build Windows.ps1**. This creates one app with desktop and mobile access. The old `build-mobile.ts` entry point delegates to the regular build; separate `package-mobile.cjs` packaging is retired with an explicit migration message.

For package checks, run from `packages\desktop` in PowerShell:

```powershell
& ..\..\.tools\bun-windows-x64\bun.exe typecheck
& ..\..\.tools\bun-windows-x64\bun.exe run build
& ..\..\.tools\bun-windows-x64\bun.exe run package:win -- --publish never
```

The regular packaging configuration writes to the versioned `dist\0.3.4` directory. Earlier outputs remain available as historical builds.

The HTTPS integration tests run under Node, the runtime used by Electron. Bun's PFX handling differs from Node and is not used for these network tests:

```powershell
& ..\..\.tools\bun-windows-x64\bun.exe build src\main\bitsbytes-mobile.test.ts --target=node --outfile=..\..\.tools\mobile\mobile.test.mjs
node --test ..\..\.tools\mobile\mobile.test.mjs
```

`scripts\verify-mobile.mjs` uses the existing `.tools\qa` Playwright installation and installed Edge. It creates an isolated profile, uses a deterministic local provider and leaves the user's app, data, share and credentials untouched. Set `BB_MOBILE_EXECUTABLE` to `dist\0.3.4\win-unpacked\BitsBytesChat.exe` to exercise the unified packaged app. Results and screenshots are written under `.tools\mobile`.

The test coverage includes same-session messages in both directions, per-device drafts, frozen skill context, Word/PDF.js preview, HTML isolation, HTTPS pairing, origin/host rejection, credential redaction, upload retry/recovery, a 32 MB upload, restart persistence and device revocation. Run `scripts/setup-qa.ps1` once for the pinned QA dependencies. `scripts/verify-phone-audio.mjs` exercises actual browser MediaRecorder with synthetic microphone audio and an API fixture; `BB_AUDIO_SOAK_MINUTES=65` enables the endurance check. `BB_MOBILE_AUDIO=1` enables the paired HTTPS microphone/CPU worker check; it requires installed Parakeet models. `BB_MOBILE_DAMAGED_STATE=1` checks startup recovery. Use Node.js 24 or later, from `packages/desktop`.

Live ChatGPT conversations have separate opt-in tests in `scripts/verify-live-ai.mjs`: set `BB_LIVE_AI=1`, and optionally `BB_LIVE_EXTENDED=1` for document skills, revisions and Plan, `BB_LIVE_CONTROLS=1` for actual approval/Goal tools, `BB_LIVE_LONG_SOURCE=1` for complete multi-part source processing, or `BB_LIVE_QUEUE=1` for Queue/Steer/Stop/Resume. Existing encrypted credentials are copied into an isolated profile, and actual token refreshes are preserved only when the user's credential file has not independently changed. Reports omit tokens and credentials. These consume authorized account usage and default to GPT-5.6 Luna. Use `BB_LIVE_EXECUTABLE` to select the packaged executable. `BB_QA_ROOT` and `BB_QA_RUNTIME` can point to canonical local directories when testing from a Windows Store process with redirected filesystem paths.

`BB_MOBILE_AUDIO_FILE` supplies a saved recording to the real paired HTTPS/CPU test; the 0.3.3 endurance run used the entire 65-minute browser recording. Optional `scripts/verify-phone-webkit.mjs` adds Windows WebKit layout and upload coverage (`BB_WEBKIT_EXECUTABLE` selects its pinned Playwright executable). Windows WebKit lacks microphone capture in this build and does not prove physical Safari behavior. Physical iPhone microphone/foreground behavior, firewall and certificate interactions still require that device; browser fixtures do not establish Dutch accuracy.

For spoken-audio functional checks, combine `BB_MOBILE_SPEECH=1` with `BB_MOBILE_AUDIO_FILE` and `BB_MOBILE_AUDIO=1`. This expects nonempty actual CPU transcription and verifies compact attachment, full text on click and complete engine context after explicit Send. Use `BB_MOBILE_REPORT` and `BB_LIVE_REPORT` to retain separately named reports for a new build. These checks do not measure language accuracy.

## Third-party QR code library

The vendored `qrcode-generator` **1.4.4** library by Kazuhiko Arase is used only to generate pairing QR codes locally. Its MIT header is retained in `packages/desktop/resources/bitsbytes/mobile/vendor/qrcode.js`; the accompanying `LICENSE.qrcode-generator` contains the license. PDF.js reuses the app's existing `pdfjs-dist` dependency.
