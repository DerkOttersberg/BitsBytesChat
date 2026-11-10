# BitsBytes Transcription

The `transcription-only` branch is a small Windows recorder and transcription app
using [Cream and Ink UI](https://git.derkdev.nl/derk/cream-ink-ui). The installed app contains recordings,
transcripts, a Copy transcript button, and Settings. It runs no chat engine,
agents, document tools, mobile server, terminal, or Python installation.

Download the Windows x64 installer from the
[transcription release](https://github.com/DerkOttersberg/BitsBytesChat/releases/tag/transcription-v1.2.0).
It installs as **BitsBytes Transcription**, alongside the original BitsBytesChat.
The installer is unsigned.

## Use

1. Open Settings. Save an OpenRouter API key, a transcription model, and optionally
   a language (`nl`, `en`, or blank for automatic detection) and microphone.
   The default model is `elevenlabs/scribe-v2`.
2. Use the people-icon toggle beside New recording to enable speaker separation.
   It is also available in Settings and supports Scribe v2 and Scribe v2 Medical.
3. Choose New recording, then Start recording on the 00:00 ready screen. New recording
   does not open the microphone. Finish recording starts transcription automatically
   after audio is saved. Importing audio also starts transcription after copying.
4. Read, listen, and copy the saved transcript, including speaker labels when enabled.

Audio stays local during recording. Finish, the recorder's close button, and
completed imports automatically upload it for transcription. Closing the entire
app saves without starting a new upload. Interrupted work requires explicit Resume.
OpenRouter transcription uses OpenRouter credits. Settings apply to new recordings;
existing recordings retain their model, language and speaker-separation choice. The API key is protected
with Windows DPAPI and is never sent to the renderer or stored in plaintext.

The sidebar starts with the recording controls. Listen and Copy are in the top
toolbar; the text-only Save audio action sits beside Delete at the bottom.
Each Start clears the waveform history and displays live microphone RMS levels.
Transcription shows preparation, request part and save stages. Reported USD costs
are committed with transcript parts and survive reopening. Scribe estimates use
the live OpenRouter per-second rate, cached for one day; unsupported pricing units
and missing historical costs are shown as unavailable rather than guessed.

## Installation and supported PCs

The finish page offers Start app and Add a desktop shortcut, both checked by
default. Uncheck either option before Finish to decline it. A Start menu entry is
also installed. Silent installation creates the default shortcut without launching
the app. Updating and uninstalling preserve recordings.

This installer targets **Windows 10/11 x64**. Electron, FFmpeg, fonts and capture
code are bundled; Node.js, Python and a GPU are not required on the destination PC.
Recording requires a working microphone and Windows microphone permission.
Transcription requires internet access to OpenRouter, an API key and credits.
Windows 11 x64 is the tested platform; Windows 10 and ARM emulation have not been
independently validated. This is not a Windows 7/8, 32-bit, macOS or Linux installer.
Unsigned-app warnings and managed-PC security policies can still block execution.

## Recovery and storage

- Recordings live in `%LOCALAPPDATA%\BitsBytesTranscription\recordings`.
- Capture commits 16 kHz mono PCM to disk every second, with a flushed file and
  atomic rename before acknowledging the write. A normal Finish also saves the
  final fraction of a second. Abrupt termination can lose the current uncommitted
  second and audio still waiting for disk. Keep the computer awake while recording.
- Startup reconstructs duration and transcript progress from actual audio and
  committed part files, including recovery when both manifests are damaged.
  Interrupted work is visible; opening the app never retries an upload.
- Imports are copied into the app's own recording directory. The original file
  need not remain in Downloads or on an attached drive after import completes.
- Audio is retained after success, errors, cancellation, and closing. Finish saves
  a playable WAV automatically; transcription also retains an MP3.
- With speaker separation off, audio is transcribed in five-minute parts. Every completed
  part is committed separately. Resume skips completed parts, including a crash
  between saving the final response and saving the completion status.
- Speaker separation uploads one compressed mono MP3 for the whole recording,
  preserving one speaker namespace across the conversation. It requests Scribe's
  word timestamps and diarization, saves structured speaker turns, and copies
  Speaker 1 / Speaker 2 labels into text. These labels distinguish speakers within
  one recording; they do not identify real people or link identities across recordings.
  Uploads are limited to 24 MB (roughly 100 minutes at 32 kbps); larger audio is
  retained with an actionable error. A completed speaker response is never resubmitted
  on Resume or restart. Unsupported/missing labels are not shown as successful separation.
- An interrupted request may already have been processed and charged. Resume
  explicitly retries the unfinished part. There are no automatic upload retries.
- Closing during capture asks to save and close, flushes the renderer, and waits
  for disk writes, without starting transcription during app shutdown. A renderer
  crash preserves audio acknowledged by main.
- Uninstalling or upgrading does not delete recordings. Deletion is an explicit,
  confirmed action. Copy transcript also supports Ctrl+Shift+C.

## Architecture and development

All production code for this flavor is in [`transcription`](transcription).
It builds independently of the inherited OpenCode monorepo. Earlier source is
retained for reference and excluded from this installer's payload.

- `src/main/storage.ts`: durable audio, manifests, transcript commits and recovery.
- `src/main/transcriber.ts`: bundled FFmpeg process and bounded OpenRouter requests.
- `src/main/ipc.ts`: validated IPC and application state; API keys remain in main.
- `src/main/pricing.ts`: cached catalog estimates with explicit pricing units.
- `src/main/index.ts`: single-instance/window/shutdown lifecycle and audio protocol.
- `src/preload.ts`: narrow bridge into a sandboxed, isolated renderer.
- `src/renderer`: native DOM interface and AudioWorklet capture, no UI framework.
- `src/copy.ts`: centralized product copy and recoverable error messages.
- `src/speakers.ts`: supported-model checks, speaker turn parsing and copied labels.

The recording strip uses an actual microphone waveform with stop and close
controls. Both controls finish, save and start transcription. Cream and Ink's local fonts,
textures, decoration layers and interaction helper are preserved as a pinned
vendor snapshot with its asset checksums and notices; no remote assets load.

Install Node.js 22+ and run `Build Windows.ps1`, or:

```powershell
cd transcription
npm ci
.\scripts\ensure-electron.ps1
npm run typecheck
npm test
npm run build
npm run test:desktop
npm run package:win
```

The installer is created in `transcription/release`. `Start Transcription.cmd`
opens the unpacked build, or the development app. The included Windows workflow
runs the same checks and tests the packaged executable when GitHub Actions is
enabled; Actions is currently disabled in this repository. Local tests use generated audio and isolated data.
Provider contract tests use injected responses, not a paid account; live provider
accuracy is not asserted. With speaker separation off, five-minute boundaries can
split sentences. Disk/hardware failure cannot be prevented.

See [verification](transcription/VERIFICATION.md). The original app remains on `main`.
