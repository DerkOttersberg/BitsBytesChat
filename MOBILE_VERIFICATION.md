# Mobile verification — 6 October 2026

**Current release: 0.3.2.** Mobile access is included in the regular `BitsBytesChat.exe`. Both CMD launchers open this same app. QR codes now prefer physical Wi-Fi/Ethernet over VPN interfaces, label their addresses and retain explicit selections across refreshes and renewed invitations. The separate package below is retained only as historical evidence. Current unified-build checks are recorded in `VERIFICATION.md`.

## Previous separate package (superseded)

Delivered executable: `packages/desktop/dist/mobile/win-unpacked/BitsBytesChat-Mobile.exe`.

Build: `0.3.0-mobile.1`, Electron `42.3.3`, Windows x64. Build and packaging completed successfully in the separate mobile output directory. The regular desktop launcher and build output were not replaced, and the user's app was not restarted.

## Completed checks

- Desktop package typecheck passed.
- Three Node HTTPS integration tests passed: pairing/authentication and credential redaction; upload retry/crash recovery and device revocation; a 32 MB upload using eight requests bounded to 4 MB each. Restart preserved the device connection. Cross-origin/invalid-host requests and permissions for another session were rejected.
- Ten end-to-end checks passed against the **packaged executable**, using an isolated profile and a deterministic local AI provider. Shared messages were verified in both directions against the actual OpenCode session database. Phone drafts remained independent per chat, and access mode changes reached the desktop host.
- Frozen skill attachments reached the model with their complete intended context while remaining compact in the visible phone chat.
- A real Word document was created in the isolated test profile, exported by Microsoft Word, served through the artifact registry and rendered by PDF.js on a 390 × 844 phone viewport.
- An interactive HTML artifact rendered in its sandbox; it could not modify the phone app or access its API.
- Phone reload reopened the same paired session, the page had no horizontal overflow, revocation disconnected it, and disabling mobile access closed the server.

The production UI test recorded **zero page errors** and three requests to the local fixture provider. Results and screenshots: `.tools/mobile/verification.json`, `mobile-chat.png`, and `mobile-document.png`.

## Checks remaining in the user's environment

Physical-phone Wi-Fi connectivity, Windows firewall prompts and first-use certificate handling still need a check on the user's phone. Live ChatGPT/OpenRouter inference was not used in these tests. Direct microphone recording on the phone is outside this release; audio file uploads are implemented. Dutch transcription accuracy benchmarking remains deferred.

## SHA-256

```text
BitsBytesChat-Mobile.exe
15ABA97E6D6B80EA52FD97C7CF3FA1102D1B4B0FA3AD3E34EE5157B08F744F00

resources/app.asar
D4A30E9F76461FA9B67F1E5459AB4099D38EF2302AB89277974E64C246A1B707
```
