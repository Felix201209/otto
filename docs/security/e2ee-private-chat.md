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

The first device for an account is explicitly recorded as a trust-on-first-use
(TOFU) bootstrap. Every later device starts in `pending` state and receives no
message envelopes until an existing approved device signs an approval over the
new device ID and its combined Ed25519/X25519 fingerprint. The approval
signature is created in Electron main; private identity keys never enter the
renderer or server. New messages contain a key envelope for every approved,
active device on both sides. Revoked devices are excluded from all subsequent
messages, and messages signed by a revoked device are rejected.

Each bootstrap, pending registration, approval, and revocation is appended to a
per-account SHA-256 hash chain with a monotonic sequence and previous-entry
hash. Electron main independently validates every entry and stores the latest
seen head in a `safeStorage`-protected local checkpoint. A shorter history is
rejected as a rollback; a history that no longer contains the pinned head is
rejected as a fork. Message and attachment decryption also requires the sender
public key to match the pinned directory, while encryption requires the complete
active-device set to match the same history.

The chain is still hosted by the enterprise server. Local pinning detects a
fork only after that device has seen an earlier head; it cannot authenticate the
first view or detect a server presenting permanently different histories to two
devices that never compare checkpoints. An independent witness or authenticated
client gossip remains required for that stronger guarantee.

The preload API exposes:

- `enterpriseE2eeDevicesList()`
- `enterpriseE2eeDeviceVerification(deviceId)`
- `enterpriseE2eeDeviceApprove(deviceId)`
- `enterpriseE2eeDeviceRevoke(deviceId)`
- `enterpriseE2eeRecoveryExport(passphrase)`
- `enterpriseE2eeRecoveryImport(bundle, passphrase)`

The same operations are available to users under **Settings → Privacy & data
→ End-to-end encrypted private chat**. Device registration and revocation are
audited. A trusted device displays a deterministic 60-digit safety number and a
locally generated QR code for a pending device. The user must compare either through an
independent channel before explicitly approving it. Device registration,
approval, and revocation are written to the enterprise security audit log;
revocation requires an explicit second confirmation in the desktop UI.

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

Protocol v1 now has immutable device IDs, signed new-device approval, safety
numbers/QR comparison, a server-hosted key-history chain, and protected local
head pinning. These controls reduce the risk from a stolen account session and
detect rollback or mutation of history already observed by a client, but they
do not make the enterprise directory independently trustworthy: a malicious
server can still create first-use or persistent split views unless clients
gossip tree heads or verify them through an external witness.

Formal releases run `scripts/verify-e2ee-release-readiness.mjs` and fail closed.
The checked-in status intentionally reports that prekey handshakes, Double
Ratchet sessions, safety-state reset, forward secrecy, post-compromise
security, an external audit, and explicit security release approval are still
missing. Otto must not claim Signal-grade security until a reviewed,
license-compatible protocol implementation and audit artifacts satisfy that
gate.

An inactive upgrade foundation now pins OpenMLS 0.8.1 and its official Rust
crypto provider in `otto-native`. It creates signed, one-time public MLS 1.0
KeyPackages and supports an in-memory two-device flow for group creation,
Welcome joining, pending-commit merge, and authenticated application-message
encryption/decryption behind a device-and-conversation-scoped JSON-RPC boundary.
Tests reject replayed and tampered ciphertext, mismatched group bindings, and
sends attempted while a member commit is pending. Private signature, HPKE, and
epoch material never enters the TypeScript response.

The native foundation now exports versioned AES-256-GCM snapshots of its
OpenMLS memory store and restores them transactionally after a process restart.
The state-encryption key is separate from the snapshot, zeroed from transient
buffers, and accepted by a fail-closed file adapter designed for an OS secure
storage wrapper such as Electron `safeStorage`. The adapter writes only the
OS-protected key and authenticated ciphertext, atomically replaces ratchet
state after each mutation, and locks the kernel after a persistence failure.
Tests cover two-device message continuity, pending member commits, wrong keys,
invalid manifests, and protected-key preservation across snapshot updates.

The desktop main process now owns an `EnterpriseMlsSessionManager` that binds
the native scope to server, organization, account, and approved device IDs. Its
state filename contains only a SHA-256 identity digest, its DEK is wrapped by
Electron `safeStorage`, and account changes, logout, failed device registration,
or application shutdown close the native process. Linux `basic_text` and all
other unavailable secure-storage states fail closed. The desktop build treats
`@otto/native` as a workspace package and reserves its native executable for
ASAR unpacking.

The desktop now also recognizes the inactive `e2ee_mls_transport_v1`
capability independently from the production `e2ee_mls_v1` gate. An approved
device initializes its protected native state when that transport foundation
is available, and the enterprise client exposes typed KeyPackage publication
and claim plus Commit, Welcome, and application-event append/list operations.
Every response is checked for ciphersuite, payload bounds, deterministic
organization/account-pair conversation binding, device binding, and monotonic
cursor order before it can reach the native boundary. Local OpenMLS group and
application operations derive the same deterministic conversation ID instead
of accepting an arbitrary caller-supplied group namespace. The desktop also
publishes a native OpenMLS KeyPackage reference for each approved device; the
server treats that protocol reference as opaque and no longer substitutes an
unrelated application-level digest.

The inactive desktop path now has initial-session orchestration without being
wired into production chat. A deterministic account ordering prevents both
participants from racing to create different initial groups. KeyPackage claims
are recoverable only by the same requester account and device until Welcome is
bound, pending Commit/Welcome bytes survive restart in the encrypted native
snapshot, and their event IDs are deterministic so a lost response can be
replayed through the server's idempotency check. The desktop publishes one
recoverable KeyPackage after approved-device activation.

Each device keeps its per-conversation transport cursor inside the same
authenticated native snapshot as the OpenMLS ratchet. Initial Commit and
Welcome events can therefore resume after restart, and application-message
decryption advances the native cursor before that combined state is atomically
persisted. A cursor never moves backwards. Events for another local device are
skipped without attempting to consume that device's Welcome material.

The server now exposes an inactive `e2ee_mls_transport_v1` foundation in both
SQLite development mode and the PostgreSQL clustered authority. It publishes
approved-device KeyPackages, claims each package once (with an unfinished
claim recoverable only by the same requester device), binds Welcome messages
to the claimed device, relays opaque Commit/Welcome/application bytes, and
enforces conversation-scoped epoch and idempotency rules. PostgreSQL claims use
row locks with `SKIP LOCKED`; neither implementation stores plaintext or client
private keys.

An account pair is a stable conversation root, not a permanent binding to one
MLS `group_id`. `mls_group_sessions` records numbered generations and retains
retired group metadata alongside generation-tagged ciphertext events. A new
group can become active only through an epoch-1 Commit carrying the currently
active group as `resetFromGroupId`; retirement, generation creation, active
pointer update, and Commit insertion are one transaction. Concurrent or stale
resets fail with a conflict, implicit group replacement is rejected, and a
previously used group cannot be reactivated while its retained session record
exists. Retired session rows are removed only after their events have passed
retention and been safely deleted.

This server-side transport reset is recovery plumbing, not the complete
client-visible safety-state reset required by the E2EE production gate. It does
not establish a prekey handshake, Double Ratchet, multi-device session
coordination, forward secrecy, post-compromise security, or external audit.
`security/e2ee-release-status.json` therefore records transport session history
and reset separately while `safetyStateReset` remains false.

MLS transport resource governance is enforced by both authorities. The default
policy allows at most 100 unclaimed KeyPackages per device and 10,000 per
organization, 60 new KeyPackage publications per device per minute, and 300
new transport events per device per minute. Active event inventory is also
capped at 25,000 events/256 MiB per conversation and 100,000 events/1 GiB per
organization. Unclaimed KeyPackages expire after
7 days, claimed-but-unbound packages after 24 hours, and transport events after
90 days. Cleanup is bounded to 500 rows per pass and runs every 15 minutes; the
clustered job uses a shared lease and an additional PostgreSQL advisory lock.
Before deleting events it advances a per-conversation retention floor. A client
whose cursor falls behind that floor receives an explicit secure-session-reset
error instead of silently processing an incomplete Commit history.

This is still not the active chat protocol. No production server advertises
`e2ee_mls_v1`. If a server does advertise that capability, the desktop refuses
to read or send through the legacy envelope instead of silently downgrading.
The initial handshake and polling coordinator is not yet a production
background event loop. Processing later remote member Commits, a durable
outbox for locally encrypted application events, multi-device fan-out,
user-visible safety-state reset, state migration/recovery policy,
multi-platform native packaging, and external review are still required. The
release gate therefore keeps `desktopTransportSessionOrchestration` false.
Until those controls and an external audit pass the release gate, the
production status remains `device-envelope-v1`.
