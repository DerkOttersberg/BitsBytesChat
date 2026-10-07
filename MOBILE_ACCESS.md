# Bits & Bytes Chat — mobile access

The phone connects to the **same engine and sessions on your Windows computer**. Messages sent on either device appear in the same conversation. The computer executes AI tools, transcribes uploaded recordings, creates documents and writes to the server share. Provider credentials remain on the computer. Each device keeps its own unsent drafts.

## First connection

1. Open **Start BitsBytesChat.cmd** or **Start BitsBytes Mobile.cmd**. Both launch the same **0.3.2** application with mobile access included. If an older desktop/mobile copy is still running, the launcher offers to close it first. Your existing `%LOCALAPPDATA%\BitsBytesChat` data and credentials are retained.
2. Open **Settings → Mobile access → Enable mobile access**. Connect both devices to the same Wi-Fi/LAN. If Windows prompts, allow the executable on the profile used by that Wi-Fi; Windows can classify it as Public even on a home network. The app does not alter firewall rules.
3. Choose **Pair a phone** and scan the QR code. The QR now prefers connected physical Wi-Fi/Ethernet adapters over VPNs and virtual networks. **Connection addresses** shows the adapter name and marks VPN/virtual choices. An explicitly selected address is remembered for renewed QR codes and subsequent app launches while that address remains available; after an IP change the current LAN address is selected instead. Windows route/interface metadata is read with a five-second limit and cached; a portable fallback ranks recognizable VPNs and point-to-point addresses last.
4. This local server uses a self-signed HTTPS certificate. On the phone, check the address and SHA-256 fingerprint shown in the desktop settings before accepting the browser's certificate warning. The app does not install system trust certificates. Fingerprints change when a certificate expires or must be regenerated for another network address.
5. Enter a device name on the phone, request pairing, and **Approve** it in desktop settings. The invitation works once and expires after five minutes. Bookmark the address for subsequent use; the device cookie lasts 30 days unless revoked.

Keep the computer awake with the mobile-enabled app running. It may be minimized. Closing the app, sleeping the computer or disconnecting its network disconnects the phone; reopening and reconnecting restores access. **Revoke** removes an individual device. **Disable mobile access** stops the listener.

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

This release provides **audio file uploads** on the phone. Direct phone microphone capture, the desktop terminal/browser panels, skill editing and remote access outside the LAN are not part of this mobile interface. Transcription accuracy benchmarking remains deferred. Use desktop settings to configure transcription models and providers. No router ports are forwarded and no cloud relay is installed.

## Storage and access

Mobile settings, hashed device tokens, the local HTTPS certificate and resumable upload journals live beneath `%LOCALAPPDATA%\BitsBytesChat\mobile`. The certificate password is encrypted using Electron's Windows credential encryption. The phone receives a Secure, HttpOnly, SameSite=Strict cookie; it never receives the engine password or AI-provider credentials. Only explicitly implemented mobile methods are exposed, with origin/host checks and a private-network address restriction.

The Windows executable is `packages\desktop\dist\0.3.2\win-unpacked\BitsBytesChat.exe`. Keep its accompanying files together. Desktop and mobile access share one build, **0.3.2**. Upstream auto-updates remain disabled. `dist\mobile` contains the historical separate build; both project launchers now target the regular application. The single-instance check protects the shared data profile across both executable names.

## Build and verification

Build from the project root with **Build Windows.ps1**. This creates one app with desktop and mobile access. The old `build-mobile.ts` entry point delegates to the regular build; separate `package-mobile.cjs` packaging is retired with an explicit migration message.

For package checks, run from `packages\desktop` in PowerShell:

```powershell
& ..\..\.tools\bun-windows-x64\bun.exe typecheck
& ..\..\.tools\bun-windows-x64\bun.exe run build
& ..\..\.tools\bun-windows-x64\bun.exe run package:win -- --publish never
```

The regular packaging configuration writes to the versioned `dist\0.3.2` directory. Earlier outputs remain available as historical builds.

The HTTPS integration tests run under Node, the runtime used by Electron. Bun's PFX handling differs from Node and is not used for these network tests:

```powershell
& ..\..\.tools\bun-windows-x64\bun.exe build src\main\bitsbytes-mobile.test.ts --target=node --outfile=..\..\.tools\mobile\mobile.test.mjs
node --test ..\..\.tools\mobile\mobile.test.mjs
```

`scripts\verify-mobile.mjs` uses the existing `.tools\qa` Playwright installation and installed Edge. It creates an isolated profile, uses a deterministic local provider and leaves the user's app, data, share and credentials untouched. Set `BB_MOBILE_EXECUTABLE` to `dist\0.3.2\win-unpacked\BitsBytesChat.exe` to exercise the unified packaged app. Results and screenshots are written under `.tools\mobile`.

The test coverage includes same-session messages in both directions, per-device drafts, frozen skill context, Word/PDF.js preview, HTML isolation, HTTPS pairing, origin/host rejection, credential redaction, upload retry/recovery, a 32 MB upload, restart persistence and device revocation. Live ChatGPT/OpenRouter inference, physical-phone Wi-Fi/firewall/certificate interaction and transcription quality require the user's actual environment; the local-provider tests do not claim to verify them.

## Third-party QR code library

The vendored `qrcode-generator` **1.4.4** library by Kazuhiko Arase is used only to generate pairing QR codes locally. Its MIT header is retained in `packages/desktop/resources/bitsbytes/mobile/vendor/qrcode.js`; the accompanying `LICENSE.qrcode-generator` contains the license. PDF.js reuses the app's existing `pdfjs-dist` dependency.
