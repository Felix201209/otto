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
For an established direct session, the native boundary also authenticates and
merges a peer's proposal-free self-update Commit for the immediately following
epoch.
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
invalid manifests, protected-key preservation across snapshot updates, and a
remote Commit plus cursor surviving the same restart boundary.

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

Approved devices now maintain a bounded pool of ten usable one-time
KeyPackages instead of relying on a single package between identity refreshes.
The server exposes only the current device's sorted, unclaimed, unexpired
references and expiry times; it never returns KeyPackage bytes through the
inventory endpoint and never receives private key material. SQLite and
PostgreSQL use dedicated device-inventory indexes. The desktop validates the
device binding, reference syntax, ordering, uniqueness, expiry and 100-entry
response ceiling, then skips references still present on the server, retries
unconfirmed local publications idempotently, and creates only enough fresh
packages to reach the target. A one-hour remaining-lifetime margin prevents a
pool from expiring as a batch. The existing 100-package/device inventory quota
and 60-publication/minute rate limit remain authoritative.

An unclaimed server reference that is absent from the authenticated local MLS
snapshot is treated as an orphan, not as usable inventory. The approved device
retires that reference under the same account/device binding before publishing
a replacement. Retirement is idempotent only while the package is absent or
still unclaimed; if another participant has already claimed it, retirement
fails closed because the corresponding Welcome can no longer be proven
decryptable by the current local state.

The inactive desktop path now has initial-session orchestration without being
wired into production chat. A deterministic account ordering prevents both
participants from racing to create different initial groups. KeyPackage claims
are recoverable only by the same requester account and device until Welcome is
bound, pending Commit/Welcome bytes survive restart in the encrypted native
snapshot, and their event IDs are deterministic so a lost response can be
replayed through the server's idempotency check. The desktop publishes one
recoverable KeyPackage after approved-device activation.

When the deterministic receiving account explicitly opens or establishes a
direct session, the coordinator now releases its establishment lock, performs
one plaintext-free transport poll, and then rechecks the native group under
the same peer lock. A pending Commit/Welcome can therefore complete in one
call without a recursive-lock deadlock; any accompanying application remains
only in the encrypted native inbox. An empty poll remains a waiting state and
transport or binding failures are not hidden. The background path can now
discover a never-opened inbound conversation through the device-scoped lookup
described below, but this remains single-device invitation handling rather
than multi-device session orchestration.

Each device keeps its per-conversation transport cursor inside the same
authenticated native snapshot as the OpenMLS ratchet. Initial Commit and
Welcome events can therefore resume after restart, and application-message
decryption now creates a durable pending-delivery record in that encrypted
snapshot in the same native mutation that advances the cursor. A crash after
the snapshot replacement therefore re-delivers the queued plaintext instead
of losing a message whose receive ratchet has already advanced. The chat-layer
consumer must explicitly acknowledge an event after its own durable delivery;
an acknowledgement persistence failure safely causes at-least-once
re-delivery. Inbox item and byte limits fail closed before decryption. A cursor
never moves backwards. Events for another local device are skipped without
attempting to consume that device's Welcome material.

For an established direct session, a remote Commit is parsed, authenticated,
merged, and cursor-advanced by one native operation before the resulting
encrypted snapshot is replaced. A proposal-free self-update must bind the
current group, exact next epoch, peer account and sender device, retain the
exact member set, and include an authenticated update path. A membership
Commit is accepted only when it contains exactly one Add proposal and the
server-authenticated transport envelope binds that proposal to an approved,
previously absent device of the local account and to the exact claimed
KeyPackage reference. The resulting roster must be precisely the previous
roster plus that device and remain within the 100-member limit. Replay, epoch
skips, tampering, removal, duplicate devices, cross-account additions,
identity replacement, mixed proposals, and unbound membership changes fail
closed. Rejected authenticated changes and OpenMLS panic paths quarantine the
conversation until an explicit security reset. The native client persists
that quarantined state even though the RPC returns an error, so restart cannot
resurrect the rejected ratchet or its pending records. This is guarded member
addition and epoch-update plumbing only; it is not automatic multi-device
orchestration and is not a claim of message-level forward secrecy, Double
Ratchet, or post-compromise security.

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

Clearing the desktop's local MLS security state is also deliberately
fail-closed. A successful clear destroys the native identity, private keys,
conversation state, inbox and outbox, closes the native process, and changes
the desktop manager from `ready` to `inactive`. No KeyPackage, polling, send or
receive operation can continue until an approved device identity explicitly
reactivates a newly created native kernel. A clear failure closes the kernel
and leaves the manager `blocked`; it never resumes the old state. This local
lifecycle control is not a server conversation-generation reset and therefore
does not satisfy the production `safetyStateReset` gate by itself.

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

The desktop MLS path now also has a crash-safe application outbox. Encryption
creates an opaque random event ID and stores only the ciphertext, group binding,
epoch and FIFO order in the same authenticated encrypted native snapshot before
the transport upload begins. A bound, idempotent server response is required
before the entry is acknowledged and removed. After a process or network
failure, pending ciphertext is replayed in ratchet order with the same event ID;
item and byte limits prevent unbounded local growth. Plaintext is never written
to the outbox. The external native IPC exposes no direct application
encrypt/decrypt bypass around the durable outbox and receive cursor.

The encrypted native state also retains a verified conversation-to-peer route.
The route is activated only while merging the matching initial member Commit
or joining a Welcome that contains the expected peer credential. Snapshot
restore revalidates the trust domain, active group and account membership;
outbox records from the preceding snapshot format can supply the route only
after the same checks. A legacy ready group without an outbox is bound on its
first deterministic peer inspection only after the native kernel verifies that
every member belongs to the local or expected peer account. A restart can
therefore enumerate active direct sessions without a plaintext side index. The
desktop retry scheduler attempts
outbox delivery immediately after MLS activation,
uses jittered exponential backoff with a 1-second base and 60-second cap after
failures, and uses a 30-second idle scan after success. A successful identity
refresh or system resume wakes it immediately. Peer sessions are flushed
independently so one blocked session does not starve the others. Logout,
identity replacement and application shutdown stop the scheduler and wait for
an active acknowledgement before closing or replacing the native MLS identity.

A separate background receive scheduler polls every persistently bound peer at
a five-second idle interval and uses the same bounded, jittered failure
backoff. Before each pass it also asks the server for unexpired Welcome peers
addressed to the exact authenticated account and approved device. The query is
strictly paginated, joins only the active conversation generation, excludes
inactive peer accounts, and returns sorted peer account IDs only. It exposes no
ciphertext, KeyPackage, group ID, epoch, key material, or other conversation
metadata. The desktop validates ordering, uniqueness, identifier syntax,
self-binding and a hard discovery ceiling before merging those peers with the
native encrypted route list.

The scheduler's dedicated staging RPC decrypts and persists applications
inside the authenticated encrypted native inbox but returns only event,
sender, group, epoch and cursor bindings. It does not enumerate pending inbox
records or return their plaintext to the JavaScript scheduler. Only an explicit
future chat consumer may list those records; it must durably insert each
returned message and then call the explicit inbox acknowledgement. Polling a
server-bound, one-at-a-time local-device Add Commit uses the guarded native
path described above; every other membership-changing Commit still fails
closed and requires a security-state reset. Proposal-free peer self-update
Commits advance the epoch through the same atomic path. Device-scoped Welcome
discovery does not implement invitation fanout, automatic roster expansion, or
recovery for the user's other devices and does not activate the production MLS
gate.

This is still not the active chat protocol. No production server advertises
`e2ee_mls_v1`. If a server does advertise that capability, the desktop refuses
to read or send through the legacy envelope instead of silently downgrading.
The initial handshake, polling, durable inbox and outbox coordinator are not yet
connected to the production chat composer or history writer. Automatic
member-add orchestration, wiring durable inbox delivery/acknowledgement into
chat, multi-device fan-out, user-visible safety-state reset, state recovery
policy, multi-platform native packaging, and external review are still
required. The release gate therefore keeps
`desktopTransportSessionOrchestration` false.
Until those controls and an external audit pass the release gate, the
production status remains `device-envelope-v1`.
