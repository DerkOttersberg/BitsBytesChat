# Transcription 1.3.0 verification

Validated locally on Windows 11 x64, 16 November 2026. Electron 42.3.3,
Node 24.16.0, bundled FFmpeg 6.1.1. Distribution target: Windows 10/11 x64.

## Checks performed

- Strict TypeScript checking passed through `bun typecheck`.
- All 19 storage, transcription, speaker, pricing, and link tests passed.
  They cover interrupted/corrupt manifests, acknowledged audio, real MP3
  encoding and 301-second segmentation, independently committed transcript
  parts, retained audio on errors, explicit retry, and reported/unknown costs.
- Real HTTPS tests verify QR generation, hashed credentials, phone binding,
  digest validation, concurrent duplicate sends, retained received transcripts,
  persisted identity, acknowledgement retry after restart, and revocation.
- Desktop lifecycle checks passed against development and packaged executables:
  explicit Start at 00:00, cleared microphone waveform, audio recovery after
  process termination, native clipboard, encrypted settings, playback, second
  instance, closing to the tray, and reopening. Explicit Quit saves capture.
- The native renderer-crash check passed with the receiver still listening,
  capture retained, and a replacement renderer. This uses the development
  preload; packaged lifecycle behavior is covered separately.
- Automatic transcription and speaker UI tests passed with injected provider
  responses. Provider responses commit before completion; restart skips saved
  responses instead of uploading again. Model and language selects are exercised.
- Android 8 and Android 16 sent 1,122,000 UTF-8 bytes to the real Windows
  clipboard through the actual Send to PC UI. Android 8 used the packaged
  Windows executable. The whole Unicode content matched SHA-256
  `99ad1dafe14da1cb204c96aa73b21544685b6418d4da366f6e1f0bb42e1cb5b9`.
  The PC window stayed hidden. An acknowledged retry preserved a newer
  clipboard value instead of copying the old text again.
- Packaged startup registration was verified with a disposable Windows Run
  value containing the executable path and `--background`, then removed.
  The test does not alter the user's real startup preference. An actual
  Windows sign-out/reboot was not performed.
- The NSIS installer built successfully with default-enabled shortcut/launch
  choices and sign-in startup registration. The packaged executable passed
  lifecycle checks. A fresh clean-PC install/uninstall was not repeated for 1.3.0.
- Runtime dependency audit: zero known vulnerabilities (`npm audit --omit=dev`).
- Android ready, paused, settings and recording-library screens were inspected;
  desktop screenshots were inspected. Icons, Cream and Ink assets and licenses
  are bundled. There is no chat payload or external runtime setup in the installer.

## Limits

This is direct encrypted local-network transfer, not a hosted relay. The devices
must be mutually reachable. Guest Wi-Fi isolation, firewall/VPN policy, a sleeping
PC, or different networks may prevent delivery. Address rediscovery is implemented;
physical multi-router/network-change behavior has not been certified. Android
background policy can delay queued sends. Reopening the app retries pending work.

Up to 4 MiB of UTF-8 text is accepted without truncation. Sent text is retained in
the PC recording library; audio and API settings are not synchronized. See
[LINK_PROTOCOL.md](LINK_PROTOCOL.md) for delivery and crash semantics.

The Windows installer remains unsigned; Unknown publisher/SmartScreen warnings
can appear. No clean Windows 10/ARM or physical microphone/driver matrix was run.
Live paid OpenRouter transcription and speaker accuracy were not tested: provider
responses are injected, with real codecs, persistence, UI and network transfer.
An uncertain interrupted provider request may already have been charged.

Audio is committed every second and on normal Finish. Abrupt termination can
lose the uncommitted fraction or queued writes; disk/hardware failure remains
outside that guarantee. Windows sleep suspends capture. WAV export is bounded
at 4 GiB, with original PCM retained. Plain transcription uses five-minute parts;
speaker mode uses a single compressed request bounded at 24 MB.

GitHub Actions remains disabled. Builds and verification above were local.
