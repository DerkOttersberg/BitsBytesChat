# Android 1.0.0 verification — 2026-11-16

Native Java APK, application ID `nl.bitsbytes.transcription`, versionCode 1,
minSdk 26, targetSdk 36. No native ABI libraries or third-party runtime dependencies.

## Automated checks

- `assembleRelease`, `lintRelease`, and `lintDebug` passed. Lint has no errors;
  remaining warnings advertise newer versions of the test-only dependencies.
- All **10 instrumentation scenarios passed on Android 8.0 / API 26 and Android
  16 / API 36 x86_64 emulators**. The initial 9-scenario suite also passed on
  Android 15 / API 35 before the received-response cache test was added.
- Actual native codec testing encodes 301 seconds of PCM to AAC/M4A, splits it
  into two request parts, decodes the M4A back to PCM, and checks duration.
- Persistence tests recover audio after uncommitted manifest updates; reconstruct
  text and costs with both manifests corrupted; preserve missing-cost semantics;
  skip completed requests; and project a saved provider response after a simulated
  crash without another upload.
- Tests validate actual streamed Base64 request JSON and diarization options,
  structured speaker labels, encrypted settings through Android Keystore, and
  cancellation without an upload.
- Installed UI test: explicit Start at 00:00, recording across Home/lock/wake,
  Finish, automatic transcription, clipboard copy, and native playback.

The deterministic transcription tests inject a transport returning fixed provider
responses. No real user audio or OpenRouter credits were used. Live-provider
speech accuracy, speaker accuracy, and hardware microphone behavior remain
unverified; those depend on the phone, network, provider, and recording conditions.

## Signed APK checks

- APK Signature Scheme v2 verified using Android `apksigner`; suitable for the
  minimum Android version. Certificate subject: `CN=Derk Ottersberg,
  OU=BitsBytes Transcription`.
- Certificate SHA-256:
  `e223e3fcdde933d8c9cae2de4477e306365240f3d51ea50b18bd41088adb33f4`.
- Installed the signed release APK on Android 8 and Android 16 emulators.
- On Android 16, force-stopped the release app during capture, reopened it, and
  recovered three committed seconds. Export through the system document picker
  produced a valid 96,044-byte mono 16 kHz WAV with a RIFF header.
- Reinstalling over the same signed application preserved its recording library.
- The recording notification's Finish action worked while the Activity was
  backgrounded. Automatic preparation retained the recording and displayed the
  missing-key error with Resume available; no provider request was made.
- Android 8's microphone permission dialog appears at Start. Denying it leaves
  the app at 00:00 without beginning capture. The small-screen recorder was
  inspected at 320 dp width; system navigation/keyboard insets are handled.

These are emulator checks, not certification for every physical phone or OEM
battery policy. Export audio before uninstalling or clearing app data. The
release is directly distributed and self-signed; it is not Play Store verified.

The private release keystore/password are kept outside the repository. They are
not part of the APK, test report, source commit, or public release assets.
