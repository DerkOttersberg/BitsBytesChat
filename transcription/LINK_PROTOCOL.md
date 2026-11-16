# Local phone link, protocol 1

The Windows app is the receiver. It runs at user sign-in and keeps its listener alive while its window is hidden in the tray. Android sends complete transcripts explicitly; it does not send audio or OpenRouter credentials and does not require a relay account.

## Pairing and identity

The PC generates a persistent RSA TLS identity locally using bundled JavaScript libraries. Its private key is protected with Windows DPAPI; updates retain the existing data folder and identity. Each QR code contains a version, PC UUID/name, current IP addresses/port, the TLS public-key SHA-256 pin, a random peer UUID, and a random 256-bit bearer credential. Pending credentials expire after ten minutes. Windows stores only the credential hash. Android stores its credential encrypted with Android Keystore.

The phone verifies the QR-pinned TLS public key before sending an Authorization header. It never falls back to an unpinned connection, never accepts a public CA identity in place of that pin, and does not follow redirects. A pairing is bound to the phone installation UUID. Re-scanning a new code on the same phone rotates that phone's credential and revokes its previous one. The PC can revoke a phone in Link phone.

The pinned identity, rather than a hostname, authenticates dynamic LAN addresses. DNS-SD (`_bbtranscript._tcp`) and UDP discovery on port 47832 expose only PC identity, pin, and listener port. Discovery information is untrusted until the TLS handshake verifies the stored pin. The normal HTTPS port is 47831, with an automatically discovered alternative if it is occupied. Network-interface changes refresh the PC advertisement. Cached successful endpoints are attempted before rediscovery.

## Durable delivery

1. Send to PC atomically saves a phone outbox job containing a UUID, destination, source recording UUID, the complete text, SHA-256 of its UTF-8 bytes, title, and duration.
2. A user-initiated foreground worker attempts delivery. Android's persistent network-constrained JobScheduler handles later retries, and network changes trigger a retry while the process is alive. Offline work remains queued through app/process restarts.
3. The authenticated PC validates identity, size, fields, and text hash, then commits an incoming job before applying it. Clipboard applications are serialized across phones.
4. The PC commits a transcript-only recording, writes the whole Windows clipboard, reads it back for exact equality, and durably records a copied receipt before returning success. Clipboard contention is retried briefly; failure leaves the job recoverable.
5. Android accepts success only when the returned PC ID, delivery UUID, text hash, and copied status match. It commits the acknowledgement before displaying success. Acknowledged outbox entries and PC receipts retain metadata without duplicate text; the recording libraries retain the original transcripts.

An acknowledged delivery is idempotent across retries and PC restarts. It does not re-copy over something the user copied later. An explicit new Send creates a new delivery so the user can deliberately copy that transcript again. The same phone recording updates its existing PC history entry rather than creating a history row for every retry.

Clipboard and filesystem writes cannot form a single OS transaction. A process crash after an unacknowledged clipboard write and before its durable receipt can apply that pending delivery again after restart. Once the copied receipt is committed, retries only return the receipt. The design does not claim distributed exactly-once execution across power failures.

The protocol accepts up to 4 MiB of UTF-8 text and bounds the JSON request body to 28 MiB (including JSON escaping). No truncation is used. HTTP connections, headers, body size, concurrency, and client operations have limits/timeouts. The phone keeps the complete recording if a transfer is rejected. Android displays long text in sections to avoid constructing an unbounded text layout; Send always reads the complete saved transcript.

## Network and operating-system limits

This is direct LAN delivery. It does not traverse arbitrary NAT, mobile data, guest-network isolation, or a corporate firewall, and it does not install a VPN or server dependency. Allow Windows private-network access when the OS asks. A PC must be on, signed in, and running the tray app to receive a clipboard value. Credential/certificate identity survives updates but must be paired again after app-data deletion or replacement of the PC.

Android may defer background jobs in Doze, under OEM battery restrictions, or after force stop. Reopening the phone app or choosing Retry connection attempts pending work again. Do not show an offline job as delivered merely because its upload was attempted. Unlinking on the phone cancels that PC's pending sends. Normal Windows window close does not shut down the receiver; Quit does.

Tests exercise real HTTPS and saved receipts, and the Android integration test scans the PC-generated QR bitmap and sends 1,122,000 bytes through the actual Send to PC button to the real Windows clipboard. The test confirms the full Unicode content and that an acknowledged retry preserves a newer clipboard value while the PC window remains hidden.
