# E2EE private chat

Otto enterprise private chat uses a fail-closed, client-side encryption path.
The enterprise server stores message ciphertext, encrypted attachment bytes,
signatures, routing metadata, and per-device wrapped message keys. It has no
private key and no message-decryption API.

## Protocol v1

Each desktop device creates two independent asymmetric key pairs:

- an Ed25519 identity/signing key, used to authenticate outgoing envelopes;
- an X25519 device-exchange key, used to unwrap per-message content keys.

For each message, Electron main generates a random 256-bit content key. The
message JSON is encrypted with AES-256-GCM. Every attachment is encrypted with
the same content key and a unique nonce and authenticated-data scope. The
content key is then wrapped separately for every active sender and recipient
device using ephemeral X25519, HKDF-SHA-256, and AES-256-GCM. The sender signs
the ciphertext hash, routing metadata, protocol metadata, and envelope set.

The server rejects a message when:

- the sender device is unknown or revoked;
- the Ed25519 signature is invalid;
- any active participant device is missing from the envelope set;
- an envelope is duplicated or targets an inactive device;
- ciphertext, nonce, A2A relation, or attachment bounds are invalid.

The clear routing metadata is limited to tenant and participant IDs, device
IDs, timestamps, read state, protocol content type, A2A reply relation, and
ciphertext sizes. Attachment names, MIME types, bodies, and private message
text are inside authenticated ciphertext.

The shared [attachment object-storage boundary](./attachment-object-storage.md)
stores those client-encrypted bytes under opaque object IDs. PostgreSQL, not an
object path, remains authoritative for tenant access, upload state, and quota;
optional storage-provider SSE-KMS is only a second layer beneath E2EE.

## Local key custody

Private keys are stored below Electron `userData/enterprise-e2ee` only after
being protected by Electron `safeStorage`. Otto refuses to enable private chat
when secure storage is unavailable. On Linux it also refuses the insecure
`basic_text` backend; a Secret Service implementation such as GNOME Keyring or
KWallet must be available and unlocked.

Renderer processes never receive device private keys. Encryption and
decryption run in Electron main. Public message APIs return plaintext to the
renderer only after signature and AEAD authentication succeeds.

## Multiple devices, revocation, and recovery

The server device directory can contain multiple active devices per account.
New messages contain a key envelope for every active device on both sides.
Revoked devices are excluded from all subsequent messages, and messages signed
by a revoked device are rejected.

The preload API exposes:

- `enterpriseE2eeDevicesList()`
- `enterpriseE2eeDeviceRevoke(deviceId)`
- `enterpriseE2eeRecoveryExport(passphrase)`
- `enterpriseE2eeRecoveryImport(bundle, passphrase)`

The same operations are available to users under **Settings → Privacy & data
→ End-to-end encrypted private chat**. Device registration and revocation are
written to the enterprise security audit log; revocation requires an explicit
second confirmation in the desktop UI.

Recovery bundles are encrypted with scrypt and AES-256-GCM. Importing a bundle
on another device keeps that device's freshly generated active identity while
adding recovered device keys as decrypt-only historical keys. It can therefore
read history addressed to an older device without reusing or reactivating that
device identity. Losing every device and the recovery bundle permanently loses
the corresponding message keys; the server cannot replace or reconstruct them.

## Otto and A2A privacy boundary

The `enterprise_collaboration` tool has no `list_messages` action. Otto cannot
request decrypted private-chat history. The ordinary employee chat UI can read
messages because decryption happens locally for the signed-in participant.

For an inbound A2A request, the permission dialog defaults to no access. If the
user enables current-chat context, they must additionally select exact message
rows. Only those IDs are filtered from the locally decrypted conversation and
placed into that single A2A invocation. “Allow all non-chat data” deliberately
excludes private chat. Files, keys, other conversations, and unselected private
messages never enter the A2A context.

## Upgrade behavior

Protocol-v1 HTTP routes do not accept plaintext private-message bodies. Legacy
server-readable rows remain outside the E2EE conversation query and are not
silently re-encrypted by the server, because doing so would make the server an
encryption endpoint and preserve the wrong trust boundary. A future explicit
participant-side history migration may fetch and re-encrypt legacy history;
until then, protocol-v1 private chat starts a new cryptographic history.

## Security scope and remaining hardening

Protocol v1 is an authenticated per-message envelope protocol, not the Signal
Double Ratchet. A fresh content key and ephemeral wrapping key are generated
for every message, but compromise of a device's long-lived X25519 private key
can expose recorded messages that contain an envelope for that device. Forward
secrecy and post-compromise security require a future ratcheting protocol.

The server-hosted device directory is trusted in v1. Immutable device IDs stop
accidental or API-level key rebinding, but there is not yet a key-transparency
log, safety-number comparison, or out-of-band approval for a newly registered
device. Those controls are required to defend against a malicious directory
server or a stolen account session registering an attacker-controlled device.
