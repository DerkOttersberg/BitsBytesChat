# BitsBytes Transcription for Android

A standalone native Android recorder with the same Cream and Ink design as the
Windows app. No desktop server, browser companion, chat engine, FFmpeg, or account
with BitsBytes is required. Android 8.0 (API 26) or newer; one universal APK for
ARM, ARM64, x86, and x86_64 devices. A microphone, internet access for transcription,
and an OpenRouter API key with credits are required.

Download the signed APK from the
[Android release](https://github.com/DerkOttersberg/BitsBytesChat/releases/tag/transcription-android-v1.0.0).
Open it on your phone and allow installation from the browser or file manager
when Android asks. This is a directly distributed APK, not a Google Play listing.
Future updates must use the same application ID and signing certificate; install
over the existing app to preserve its data. Do not uninstall to update.

## Use

1. Save your OpenRouter API key in Settings. The default model is
   `elevenlabs/scribe-v2`. Language can be blank, `nl`, `en`, or another supported
   two-letter code.
2. Open Record. The microphone remains closed at 00:00 until Start recording.
   The people-icon switch enables speaker separation (Scribe v2 / v2 Medical).
3. Finish recording automatically saves and transcribes. Import audio copies
   the source to the app before preparing and transcribing it.
4. Open a recording to listen, copy the transcript, see progress/reported USD
   cost, export audio, or delete it. Save audio and Delete are text actions together.

Allow microphone access at Start. Notifications provide Finish/Stop controls
while the app is minimized. The microphone foreground service continues while
the screen is locked or you switch apps; leaving the screen does not finish a
recording. Tap Finish or use its notification action. Force stop, Android's
foreground-service Stop control, device shutdown, and manufacturer battery
restrictions can terminate it. The app does not secretly restart the microphone.

Speaker labels distinguish voices within one recording; they do not identify
people or match identities across recordings. Speaker mode uploads one compressed
M4A, capped at 24 MB, to keep labels consistent. Plain transcription uses five-minute
parts. No price is guessed: provider-reported USD usage is persisted with each
result; missing or partially reported costs are marked accordingly.

## Durability and privacy

- `AudioRecord` captures 16 kHz mono PCM. Each second is committed to an atomic,
  synced file in private app storage. Finish also commits the final partial second
  and creates a playable WAV. Native Android codecs prepare AAC/M4A for upload.
- A killed process can lose the current uncommitted second and pending disk writes.
  On reopening, saved chunks reconstruct duration; independently committed
  transcript parts reconstruct text, speaker turns, and costs, even if manifests
  are damaged. Interrupted jobs require explicit Resume. Reopening never uploads.
- Resume skips committed responses. A request interrupted before its response was
  committed might already have been charged; retrying that request can cost again.
- Received JSON is committed before transcript projection. Resume can finish
  projecting a valid saved response without another request, including after a crash
  between receiving the result and saving its transcript part.
- Original imports, PCM, compressed audio, and successful transcript parts remain
  available after errors and cancellation. The original imported file is only
  considered copied after flush and rename. Source formats depend on the Android
  device's installed decoders (WAV, MP3, M4A/AAC, FLAC, and supported Ogg variants).
- New jobs snapshot their model/language/speaker choice. Changing Settings does
  not silently change an existing job; updated API credentials are used on Resume.
- The API key is encrypted using AES-GCM and Android Keystore. It is never logged
  or included in recording metadata. Android cloud backup and device transfer are
  disabled; data remains private to this installation.
- **Export audio before uninstalling, clearing app data, or replacing the phone.**
  Android removes private app storage on uninstall, unlike the Windows app.
  Uninstalling or clearing data also removes the Keystore key.

Audio remains local while recording; Finish and completed imports send it over
HTTPS to OpenRouter and its selected provider. There is no paid transcription
credential bundled in the APK. Export uses Android's file picker and requires no
broad storage permission. Delete explicitly removes that recording's local data.

## Architecture

`MainActivity` owns phone navigation and playback, with safe system/keyboard insets
and scrollable layouts. `AudioService` owns microphone capture, notification
controls, wake lock, imports, and transcription across Activity lifetimes.
`BitsApp` maintains a single serialized worker; no concurrent capture/import jobs.
`Store` owns atomic local persistence/recovery. `AudioFiles` streams native
encode/decode/resampling without loading a full recording into memory.
`Transcriber` streams Base64 JSON to the fixed HTTPS endpoint, parses structured
speaker output, and commits each response. `Settings` owns Keystore encryption.
`Ink` adapts the unmodified Cream and Ink font/texture assets for native widgets.
There are no third-party runtime libraries; AndroidX is used only for tests.

## Build and verify

Install JDK 21, Android SDK platform 36 and build tools, and set `ANDROID_HOME`.
The checked-in Gradle wrapper pins Gradle 8.13 with its distribution SHA-256;
Android Gradle Plugin is 8.13.2. From this directory:

```powershell
./gradlew.bat assembleDebug lintDebug
# Start an Android emulator or attach an authorized test device:
./gradlew.bat connectedDebugAndroidTest
```

Tests exercise actual local storage, native codecs, upload JSON, speaker labels,
Keystore encryption, resuming without duplicate requests, and the installed UI's
Start → lock/background → Finish → automatic transcription → copy/playback flow.
Provider responses in these deterministic tests use an injected transport; they
do not spend OpenRouter credits or validate real-world speech accuracy.

To produce a release, set `BITSBYTES_ANDROID_KEYSTORE` and
`BITSBYTES_ANDROID_PASSWORD_FILE` to private files outside the repository. The
key alias is `bitsbytes`. Run `./Build-Android.ps1 -OutputDirectory <directory>`.
It checks release lint, verifies the APK signature, and emits the APK and checksum.
Keep an independent private backup of the keystore and its password: losing them
prevents normal updates for existing installations. Never upload either as a
GitHub release asset. Version name/code are in `app/build.gradle`; increment both
before shipping updates and update the script's artifact name.

Cream and Ink assets come from the existing vendored snapshot
`da4036afb1736878413720391d36f4d6ba5bfa65`; font licenses, notices, and original
asset checksums are bundled under `app/src/main/assets/`.
