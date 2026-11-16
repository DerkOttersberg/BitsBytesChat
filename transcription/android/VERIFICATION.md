# Android 1.3.0 verification - 16 November 2026

Native Java APK, application ID `nl.bitsbytes.transcription`, versionCode 2,
minSdk 26, targetSdk 36. No native ABI libraries, Google Play Services, or
separate runtime installation is required. ZXing is bundled for QR decoding.

## Checks performed

- Signed `assembleRelease` and `lintRelease` passed; lint has no errors.
- The 13 stability scenarios were validated on Android 8 / API 26 and Android
  16 / API 36 emulators, including separate picker reruns after test-selector
  fixes. They cover saved audio and corrupted manifests, retained text/costs,
  Keystore settings, durable encrypted pairing/outbox state, pause/recovery and
  append, searchable model/language choices, streamed Base64/options,
  cancellation, provider failure, and saved-response recovery without reupload.
- Real native codec testing encodes 301 seconds of PCM into AAC/M4A, splits
  plain-mode requests, decodes the audio, and checks duration and part reuse.
- The installed UI test verifies explicit Start, microphone capture across
  Home/lock, Pause/Resume, Finish, automatic transcription, clipboard and playback.
- Real phone-to-Windows integration passed on Android 8 and Android 16. It
  decodes the Windows-generated QR bitmap using ZXing, rejects an incorrect TLS
  pin, pairs with the actual receiver, and sends through the Send to PC button.
  The PC clipboard receives all 1,122,000 UTF-8 bytes of multilingual text. Saved
  acknowledgement state survives reopening, and retry does not overwrite a
  newer clipboard. Android 8 was tested against the packaged Windows executable.
- The emulator integration uses its host gateway for routing while retaining
  the real certificate pin. It does not prove physical camera focus, multicast
  routing, changing physical networks, or every router/firewall configuration.
- Final signed APK installed over the previous release on Android 8 and Android
  16. Version 1.3.0 opens successfully and existing recording libraries remain.
- The final Android 16 release UI was inspected for ready, paused, settings and
  saved recordings. Finish from Pause retains the recording and proceeds to
  automatic transcription; missing credentials leave audio saved for retry.
- APK Signature Scheme v2 verified with Android apksigner. Certificate SHA-256:
  `e223e3fcdde933d8c9cae2de4477e306365240f3d51ea50b18bd41088adb33f4`.
  This is the same signing identity as Android 1.0.0, allowing in-place updates.

## Limits

Tests use emulators, generated audio, and injected transcription responses. No
live paid-provider accuracy, physical microphone/camera matrix, or OEM battery
policy certification is claimed. Android can delay background retries in Doze,
under battery restrictions, and after force stop. Reopening attempts queued sends.

Send to PC requires a reachable PC on the same local network. It does not use an
internet relay. A 4 MiB UTF-8 transcript limit is checked before queueing; rejected
text remains in the recording. The UI displays long text in sections, while Send
reads the full saved transcript. The Android system clipboard may impose a lower
transaction limit; Send to PC does not depend on that clipboard transaction.

The APK is self-signed for direct distribution, not Play Store verified. Export
recordings before uninstalling or clearing app data, which removes private audio,
transcripts, pairing credentials and the Android Keystore key. The private release
key and password are outside the repository and are never public release assets.
