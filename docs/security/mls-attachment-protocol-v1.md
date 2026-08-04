# MLS private-chat attachment profile v1

Status: **candidate only**. This profile is implemented behind the MLS
candidate transport. It is not production-approved and remains in the E2EE
external-audit scope.

## Cryptographic profile

Each file has a fresh 32-byte DEK from `node:crypto.randomBytes`. The DEK is
used only for that file. It is never derived from or reused as an MLS epoch,
message, device, object-store, or server KMS key.

The file is split into 1 MiB plaintext chunks by default (accepted range: 64
KiB through 8 MiB). A zero-byte file is represented by one authenticated empty
chunk. Every chunk uses AES-256-GCM with a 12-byte nonce:

```text
nonce = random_8_byte_file_prefix || uint32_be(chunk_index)
```

The 32-bit index makes every nonce unique under one DEK. A file is rejected
before encryption if it would require more than 2^32 chunks. Each chunk is
encoded as `ciphertext || 16_byte_GCM_tag`; chunks are concatenated without a
separate binary header because all framing values are authenticated in the MLS
manifest.

The exact UTF-8 AAD for chunk `i` is:

```text
otto:mls-attachment:v1\n<canonical JSON>
```

The JSON object is emitted in this field order:

```json
{
  "format": 1,
  "cipher": "aes-256-gcm-chunked",
  "attachmentId": "mls-attachment-<uuid>",
  "binding": {
    "organizationId": "...",
    "conversationId": "64 lowercase hex characters",
    "sessionGeneration": 1,
    "groupId": "canonical base64",
    "epoch": 1,
    "messageId": "mls-message-<uuid>"
  },
  "plaintextBytes": 0,
  "chunkBytes": 1048576,
  "chunkCount": 1,
  "chunkIndex": 0,
  "chunkPlaintextBytes": 0
}
```

`JSON.stringify` with the above insertion order is the v1 canonical encoder.
Changing names, order, numeric encoding, or prefix requires a new format
version.

## MLS application manifest

The following JSON exists only inside the authenticated MLS Application
Message:

```json
{
  "format": 1,
  "cipher": "aes-256-gcm-chunked",
  "id": "mls-attachment-<uuid>",
  "fileName": "report.pdf",
  "mimeType": "application/pdf",
  "plaintextBytes": 123,
  "ciphertextBytes": 139,
  "ciphertextSha256": "64 lowercase hex characters",
  "chunkBytes": 1048576,
  "chunkCount": 1,
  "dek": "canonical base64 of exactly 32 bytes",
  "noncePrefix": "canonical base64 of exactly 8 bytes",
  "binding": {
    "organizationId": "...",
    "conversationId": "...",
    "sessionGeneration": 1,
    "groupId": "...",
    "epoch": 1,
    "messageId": "..."
  },
  "object": {
    "id": "mls-attachment-<same uuid>",
    "ciphertextBytes": 139,
    "ciphertextSha256": "same digest"
  }
}
```

File name, MIME type, plaintext size, DEK, nonce prefix, chunk framing, and
recovery material must not appear in an HTTP body, URL, PostgreSQL row, object
tag, log, telemetry event, or audit detail. The outer transport contains only
the unpredictable attachment ID, ciphertext size/digest, MLS conversation,
generation/group/epoch/message binding, participant IDs, and the approved
send-time device roster required for authorization.

## Upload, recovery, and authorization

Limits are six files per message, 10 MiB plaintext per file, 20 MiB plaintext
per message, 10,000 S3 parts, 100 authorized MLS devices, and the configured
tenant stored-plus-reserved quota. Client encryption and decryption process one
chunk at a time. S3 transfers process one multipart/download chunk at a time.

Before upload, the server derives the active conversation, generation, group,
epoch, participants, and approved-device roster from its authority. It rejects
any client mismatch, then reserves quota and stores that authorization in the
same PostgreSQL transaction as the object row. The server never accepts a DEK
or human-readable file metadata.

Each resume, part-presign, part-record, completion, and download operation
rechecks the authenticated account and device against the current MLS session.
The conversation, generation, group, and participants must still match. The
current epoch may advance, but may not precede the attachment epoch. A device
must be both currently approved and present in the send-time roster. Therefore
revoked devices and devices added after the message cannot obtain an object
URL. An available resume result reconciles a lost completion response without
creating another object.

The desktop stores pending manifests (including DEKs), message idempotency IDs,
and drafts only in its authenticated, OS-secure-storage-wrapped history. The
encrypted ciphertext outbox uses private atomic files. It is removed after the
message is delivered; pending recovery data is discarded on an explicit
conversation security reset. Provider lifecycle and Otto cleanup workers own
bounded orphan removal; legal holds and live metadata references win.

On download, the client verifies the outer object ID, encryption profile,
ciphertext length, and SHA-256 while writing the private ciphertext file. It
then validates the inner manifest and exact message binding before per-chunk
GCM authentication. Any mismatch removes temporary output and fails closed.
Otto Server cannot scan E2EE plaintext; any future malware scan must run on the
client with a user-visible status.

History transfer to a newly added device is not enabled by this profile. It
must not be simulated by server-side DEK recovery. A future profile requires
explicit out-of-band approval, safety-number verification, device-to-device
rewrapping of selected history, and a separate audit trail.

## Pinned dependencies and audit limitations

- MLS: `openmls = 0.8.1`, `openmls_rust_crypto = 0.5.1`,
  `openmls_traits = 0.5.0`, and `openmls_basic_credential = 0.5.0` in
  `otto-native`.
- File AEAD, SHA-256, and randomness: the supported Electron/Node.js
  `node:crypto` implementation (`aes-256-gcm`, `createHash`, `randomBytes`),
  backed by the runtime's OpenSSL build.
- MLS state and attachment-manifest custody: Electron `safeStorage` plus the
  authenticated local history format documented in the private-chat design.

Known limitations requiring independent review include the new chunk framing
and AAD profile, JavaScript/runtime buffer lifetime, local plaintext handoff to
the renderer for preview/download, server-hosted device-directory trust,
object-store and cleanup fault injection, and cross-platform secure-storage
behavior. Passing repository tests does not satisfy that external audit.
