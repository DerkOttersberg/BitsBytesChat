# Transcription 1.2.0 verification

Validated on Windows 11 x64 on 10 November 2026, using Node 24.16.0,
Electron 42.3.3 and the bundled FFmpeg 6.1.1 binary.

## Automated checks

- TypeScript strict type checking passed.
- Eighteen persistence/transcription/pricing tests passed. They exercise acknowledged audio
  idempotency, altered/gapped writes, stale/corrupted manifests, final partial
  seconds, independent transcript commits, copied imports, real MP3 encoding,
  real five-minute segmentation of a 301-second import, provider failures,
  explicit cancellation, completed-part reuse and confirmed deletion storage.
- Cost tests cover committed per-part usage, reconstruction without double-counting,
  unknown historical fees, reported zero, cached live Scribe rates and rejection of
  token/hour models as per-second estimates. Preparation/request/save progress is checked.
- Speaker tests cover word/segment parsing, punctuation, unknown speakers, rejected
  invalid timestamps/missing labels, a single 301-second diarization request,
  speaker identity beyond five minutes, response persistence, no reupload on
  restart and refusal of oversized speaker audio before any upload.
- A desktop provider fixture exercises the production application service and UI
  with an injected provider response: icon toggle on/off, frozen recording choice,
  automatic speaker/plain transcription after Finish/close, copied speaker labels,
  automatic imports, audio saved before requests, unsupported-model toggle state,
  and restart without another upload.
- Desktop checks passed against the source build and packaged Windows executable:
  recording, final flush, WAV playback, missing-key error, force-killing/reopening
  the actual main process, clipboard, encrypted settings, second-instance focus,
  saving on Close, repeated reopening and a 780-pixel window.
- New recording is verified to show 00:00 without creating a recording or opening
  the capture UI. Start is explicit. Successive sessions verify a cleared waveform
  canvas before new microphone history fills it. Branding removal is checked.
- The NSIS installer was silently installed into an isolated test directory. The
  installed executable passed the same desktop lifecycle checks, and the test
  installation was successfully uninstalled afterwards.
- A separate native observer launches the same compiled application without a
  browser debugger, kills its actual renderer process, and verifies a replacement
  renderer, the same main process, recovered duration/state and a playable WAV.
  This observer uses Electron's development preload; the packaged executable is
  covered by the desktop lifecycle checks above.
- Installer archive inspection found no chat engine, mobile,
  Python worker, sidecar or document preview payload. Both fonts, all three masks,
  upstream CSS/JavaScript and licenses are present.
- All five Cream and Ink font/texture checksums match upstream assets.json at
  commit da4036afb1736878413720391d36f4d6ba5bfa65. The vendor files are unmodified.
- Screenshots were inspected for empty, settings, saved, recovered, transcript,
  ready screen, busy/cost display, active waveform and narrow-window states. The waveform uses microphone samples;
  there is no progress/filling meter. Stop and Close both save the recording.

## Practical limits

Tests use generated audio and injected provider responses. No paid OpenRouter
account or live speech-recognition accuracy is claimed. Requests have bounded
timeouts, retain audio on errors, and never retry automatically. An uncertain
in-flight request may already have been processed or charged by the provider.

The installer is unsigned. Capture survives ordinary app interruptions through
acknowledged one-second disk commits; an abrupt kill can lose the current second
and any queued uncommitted samples. Hardware/storage failure remains outside that
guarantee. Windows sleep suspends capture. WAV export uses standard RIFF and is
bounded at 4 GiB; original PCM chunks remain retained beyond that boundary.
Speaker separation uses one whole-recording request, bounded at 24 MB; speaker
identity is scoped to that recording. The provider can still time out on long
audio, with the MP3 retained for explicit retry. Plain mode uses five-minute parts.

GitHub Actions is disabled in this repository, so the included Windows workflow
has not run remotely. The checks above were performed locally on Windows.

The separate app identity is nl.bitsbytes.transcription. Its installer and data
directory do not replace the original BitsBytesChat installation or recordings.

The distribution target is Windows 10/11 x64, with Windows 11 x64 validated locally.
No clean Windows 10/ARM/microphone-driver matrix has been run, so universal PC
compatibility is not claimed. Runtime/capture/FFmpeg/fonts are bundled. OpenRouter
connectivity, credentials, credits and Windows microphone permission are required.
