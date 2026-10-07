# Bits & Bytes Chat 0.3.4

This final morning patch includes every improvement in [0.3.3](RELEASE_NOTES_0.3.3.md): direct phone microphone recording, durable recovery, compact attachments, lighter mobile startup, document preview caching and safe revision history.

An engine acknowledgement that never appears in history now stops showing an indefinite busy state after its timeout. The original request remains visible and recoverable, with no automatic duplicate. A late acknowledgement reconciles by the same message ID. Real app tests use GPT-5.6 Luna, including queue/steer/stop/resume, approvals, Plan/Goal and document creation.

Opening the terminal now creates one initial shell even when retained panels initialize together. Explicit additional terminals keep distinct numbers. Retrying an older document preview regenerates a missing or damaged cached PDF from that revision's source, keeping the latest document intact.

Use **Start BitsBytesChat.cmd** or **Start BitsBytes Mobile.cmd**; both open **0.3.4**. An existing older app stays running until you choose to close it in the launcher. All user data and encrypted connections retain their existing location. Phone pairing is under **Settings → Mobile access**, and transcription settings under **Audio**.

Windows installer: `packages/desktop/dist/0.3.4/BitsBytesChat-win-x64.exe`. The installer is unsigned. Source and installer backup are in the private [GitHub release](https://github.com/DerkOttersberg/BitsBytesChat/releases/tag/v0.3.4). Its `SHA256SUMS.txt` records the verified installer hash.

Installer SHA-256: `1b3673a92ca37bad983c354e1b6f34de228c5822635bb53382418ae1aa455b51`.

See [verification notes](VERIFICATION.md) for all measured checks. The 65-minute / 47.5 MB recording completed its entire HTTPS upload and 131 CPU chunks. Actual iPhone microphone/background behavior still needs physical-device testing; Dutch accuracy remains deferred. This account's successful model discovery still omits GPT-6.1 Sol. No paid provider fallback is automatic.
