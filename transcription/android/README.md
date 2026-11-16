# BitsBytes Transcription for Android

Android 8.0+ native recorder with the same Cream and Ink fonts, icons, dotted surfaces, and mint controls as Windows. Download the signed APK from the [unified release](https://github.com/DerkOttersberg/BitsBytes-Transcription/releases/tag/transcription-v1.3.0). No desktop server setup or Google Play Services is required.

Open Settings to save an OpenRouter API key and pick a model/language. The model picker refreshes from OpenRouter's transcription catalog and keeps a cached/bundled fallback. The searchable language picker includes Automatic. Language support varies by model. Scribe v2 and Scribe v2 Medical support the people-icon speaker toggle.

Record opens at 00:00 without microphone access. Start recording, use the small square Pause/Resume control, and Finish separately. Pausing commits the partial audio chunk, releases the microphone capture and wake lock, and excludes paused time from the recorded duration. Foreground notification controls work while the Activity is backgrounded or the phone is locked. Finish and completed imports automatically transcribe after saving audio. Recovered unfinished captures can resume recording before transcription.

To send a finished transcript, use **Send to PC**. First pair using **Settings → Link PC → Scan PC code**, with the Windows app's Link phone QR on the same local network. The text is saved to an outbox before delivery. Copied to PC clipboard is shown only after the PC acknowledges the exact complete text. Background network jobs retry queued work; reopening the app or Retry connection also attempts it. The link is direct LAN access, not a hosted internet relay. See the [protocol and reliability details](../LINK_PROTOCOL.md).

Audio, API credentials, and settings stay device-local. Only an explicitly sent transcript goes to the paired PC. Android Keystore protects API/pairing credentials; cloud backup and device transfer are disabled. **Export audio before uninstalling or clearing data**: Android deletes private recordings, outbox data, and Keystore entries on uninstall. Normal updates preserve them; install the new APK over the existing one, using the same signing key.

Captures use 16 kHz mono PCM committed every second, with the partial second also committed at Pause/Finish. Finished recordings retain WAV and native AAC/M4A, with original imports preserved. A killed process can lose the current uncommitted fraction. Startup reconstructs audio and transcript parts from committed files and never automatically re-uploads an interrupted transcription. Responses are saved before transcript projection, so a valid received response can finish locally on Resume without another paid request. An in-flight request not committed locally might already have been charged.

Long text is displayed in sections. Copy and Send use the full saved text. Android's clipboard transaction limit can be smaller than PC delivery; Send avoids that Android clipboard limit. The PC protocol accepts 4 MiB of UTF-8 text and never silently truncates it.

## Architecture and builds

`AudioService` owns microphone capture and work across Activity lifetimes. `Store` owns atomic recordings/recovery; `AudioFiles` streams native codec preparation; `Transcriber` saves provider responses and parts. `LinkStore` owns encrypted pairing metadata and durable outbox jobs; `LinkClient` owns pinned HTTPS and network discovery; `LinkDeliveryService` handles an immediate send and `LinkJobService` handles deferred work. `ScanActivity` uses the bundled ZXing QR reader, and `Catalog` supplies cached models/shared language choices. `MainActivity` owns navigation/playback and adapts safe system/keyboard insets.

Development requires JDK 21 and Android SDK platform 36 with `ANDROID_HOME` configured. The checked-in wrapper pins Gradle 8.13 by SHA-256, with AGP 8.13.2. From this directory run `./gradlew.bat assembleDebug lintDebug` and, with an owned emulator, `./gradlew.bat connectedDebugAndroidTest`. Tests use fixed provider responses and spend no OpenRouter credits. Actual network/clipboard integration is driven from `transcription/test/phone-desktop.ts` with `ADB`, `ANDROID_SERIAL`, and installed debug/test APKs on an emulator.

For a signed release, set `BITSBYTES_ANDROID_KEYSTORE` and `BITSBYTES_ANDROID_PASSWORD_FILE` to private files outside the repository, then run `./Build-Android.ps1 -OutputDirectory <directory>`. Alias: `bitsbytes`. The script checks lint, verifies signing, and emits the APK/checksum using the version in `app/build.gradle`. Increment versionCode/versionName for updates. Keep an independent private signing backup; never put its key/password in source or release assets.

Cream and Ink assets retain the vendored commit `da4036afb1736878413720391d36f4d6ba5bfa65`, Apache-licensed fonts, textures, and provenance. ZXing 3.5.4 is bundled under Apache 2.0. Notices are included in APK assets.
