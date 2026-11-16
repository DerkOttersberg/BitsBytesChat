# BitsBytes Transcription

A minimal Windows and Android app for recording, transcription, playback, and copying text. Built with [Cream and Ink UI](https://git.derkdev.nl/derk/cream-ink-ui). No chat window, desktop server installation, Python, Node.js, FFmpeg setup, or Google Play Services is required on the destination device; the apps bundle their runtime dependencies.

Download the Windows installer and signed Android APK together from the [1.3.0 release](https://github.com/DerkOttersberg/BitsBytes-Transcription/releases/tag/transcription-v1.3.0). Windows 10/11 x64 and Android 8.0+ are the supported targets. Windows is unsigned; Android updates retain the existing signing certificate and application ID.

## Phone → PC clipboard

1. Install both apps. In the Windows app choose **Link phone** (also available from its system tray menu).
2. In Android open **Settings → Link PC → Scan PC code**. Scan the Windows QR code and confirm the computer.
3. Record and transcribe on the phone, then tap **Send to PC**. The Windows window can stay closed in the tray.
4. **Copied to PC clipboard** means Windows saved the full transcript and verified the clipboard contents. Paste anywhere on that PC.

Both devices need to be able to reach each other on the same local network. Windows may ask to allow the app on private networks. Guest Wi-Fi/client isolation, VPN policy, sleeping PCs, firewalls, or different networks can prevent a direct connection. This is not a hosted internet relay. A queued send stays saved until the PC can be reached; delivery outside the shared network waits. Local address changes are handled by cached endpoints, DNS-SD, and UDP rediscovery without replacing the trusted PC identity.

The phone keeps a durable outbox. Windows saves an incoming transcript before copying it and acknowledges only after clipboard verification. Lost responses are retried with the same delivery ID; an already acknowledged retry does not overwrite a newer clipboard value. An explicit new Send copies again. Text is transferred as UTF-8 with a SHA-256 digest, with a **4 MiB UTF-8 limit** per transcript, well beyond normal hour-long conversations. Text is never silently truncated. The Windows recording library keeps the received text; audio, API keys, and settings remain on their original device.

Windows starts in the background at user sign-in by default. Closing its window hides it to the tray and keeps recording, transcription, and phone delivery running. Use the tray to open it, link a phone, change Start with Windows, or Quit. Quit during an active audio task saves work before closing. Windows shutdown can still interrupt the current uncommitted audio fraction; opening the app recovers saved data.

## Recording and settings

Save an OpenRouter API key with credits in Settings. Pick a transcription model from the live OpenRouter catalog and choose a language from the list (Automatic is the default). Both apps cache model choices and include a bundled fallback. Language support depends on the selected provider/model. Scribe v2 is the default; the people-icon switch enables speaker separation for Scribe v2 and Scribe v2 Medical. Speaker labels distinguish voices within a recording; they do not identify real people.

New recording opens at 00:00 without opening the microphone. Press Start. On Android, the small square pause button pauses and resumes the same recording; Finish remains a separate button. Pause commits the partial audio chunk, stops microphone capture, and excludes the pause from the recording duration. Recovered unfinished Android captures can be resumed as recordings before transcription.

Finish automatically saves and transcribes. Import copies the source locally before transcription. Audio stays local during capture, then goes over HTTPS to OpenRouter and the selected provider. Completed transcript parts and provider-reported USD costs are retained. Missing costs remain marked as unknown. Speaker separation uses one compressed recording to preserve a single speaker namespace; plain transcription uses five-minute parts. A request interrupted before its response was committed may already have been charged; Resume is an explicit retry.

## Storage and recovery

- Windows data: `%LOCALAPPDATA%\BitsBytesTranscription`. Updating/uninstalling preserves this folder. The per-PC TLS identity and paired phones survive normal updates.
- Android data is private to the app. **Export audio before uninstalling, clearing data, or replacing the phone.** Android removes private app data and its Keystore key on uninstall.
- Capture saves 16 kHz mono PCM in synced atomic files every second. Finish/Pause also commit the final partial second. A force stop or power loss can lose the current uncommitted fraction and pending disk writes.
- Startup reconstructs audio duration and transcript progress from committed files, even if manifests are damaged. Opening an interrupted recording does not automatically upload audio.
- Finished Windows captures retain WAV and compressed MP3; Android uses native AAC/M4A and WAV. Original imports are retained. No destination-device codec setup is needed for recording; imported formats depend on the bundled Windows decoder or Android's installed codecs.
- The API key uses Windows DPAPI / Android Keystore. Phone pairing uses pinned TLS and per-phone credentials; no API credential is shared between devices.
- Phone sends remain durable through app/process restarts. Android's system scheduler retries pending work; force stop and battery restrictions can defer retries until the app is opened. Pausing a recording releases its wake lock while retaining foreground notification controls.
- Long phone transcripts are displayed in sections so the UI remains responsive. Copy and Send use the complete saved transcript, not the displayed section. Android's system clipboard can impose a smaller limit than PC transfer; Send to PC avoids that clipboard transaction.

## Source and building

The default branch is `transcription-only`. The former `main` is preserved as `legacy-chat-main`; the active branch has no `main` branch. The application lives in `transcription/`, with the native Android app in `transcription/android/`. Historical chat sources are not packaged into either app.

For Windows development, install Node.js, then run `Build Windows.ps1`, or from `transcription/` run `npm ci`, `bun typecheck`, `npm test`, `npm run build`, `npm run test:desktop`, and `npm run package:win`. Android build/signing instructions are in [the Android README](transcription/android/README.md). These are development requirements, not requirements for installed apps.

See [the link protocol](transcription/LINK_PROTOCOL.md), [Windows verification](transcription/VERIFICATION.md), and [Android verification](transcription/android/VERIFICATION.md). GitHub Actions remains disabled at repository level; releases are built and verified locally rather than enabling the historical monorepo workflows.
