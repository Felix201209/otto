# Otto E2EE v2 architecture

Status: foundation only. Encrypted messaging is disabled by default and must
not be advertised as production E2EE until the MLS engine, interoperability
suite, external audit and signed release approval are complete.

## Scope

`secure_messaging` owns account trust roots, device credentials, MLS
KeyPackages, signed device approvals and revocations, and key-transparency
checkpoints. `collaboration` continues to own routing, unread state and A2A.

E2EE is intended for direct-message bodies, direct-message attachments and
content a user explicitly selects for an A2A request. Enterprise knowledge,
park tickets, organization policy, billing, statistics and audit metadata stay
server-managed so their business rules remain enforceable and explainable.

## Protocol decision

The production protocol identifier is `otto-mls-v1`, based on RFC 9420. Each
approved Otto device is an MLS client/leaf. OpenMLS is the preferred MIT-licensed
Rust implementation and will run outside the renderer through a narrow native
bridge. The server stores KeyPackages and opaque protocol messages but never an
MLS epoch secret.

The earlier `device-envelope-v1` prototype is not the production protocol. Its
UI, OS-keystore integration and test fixtures may be reused, but its custom
per-message envelope, mutable approval state and server-only hash chain must not
be migrated.

## Device trust

The first device is bootstrapped by a client-generated account trust root. Each
additional device publishes a self-signed credential and remains pending until
an already approved, unexpired device signs the target credential hash. Device
revocation is also signed. Directory state is derived from these immutable
proofs; there is intentionally no mutable `approval_state` column.

The server verifies proofs before storage. Clients verify the complete proof
chain again and reject a directory whose displayed state is not backed by valid
signatures. Modifying the database therefore cannot manufacture a trusted
device.

## Trust-directory API

The enterprise server advertises `e2ee_device_trust_v2` and exposes only the
device-trust foundation under `/enterprise/e2ee/*`. Every endpoint requires an
account session. Root registration, device registration, approval and
revocation must carry the authenticated account and organization in their
signed payload; the HTTP adapter rejects a mismatched scope before signature
verification. Directory and transparency lookups can target only active
accounts in the caller's organization and return a generic not-found response
for cross-tenant identifiers.

`GET /enterprise/e2ee/status` deliberately reports `foundation-only` and
`enabled: false`. There is no encrypted-message send endpoint in this phase,
and the desktop client must not interpret successful device registration as
permission to label a conversation E2EE or silently fall back to plaintext.

## Transparency and recovery

Every root, credential, approval and revocation is appended to an account Merkle
log. Clients pin the last checkpoint in the OS credential store and reject
rollback or forked prefixes. A later phase will add checkpoint gossip and an
optional Otto Control or customer-owned witness for cross-device fork detection.

The recovery public key proves possession during trust-root registration, but
recovery execution and encrypted history backup are intentionally deferred.
Recovery must require a client-held
high-entropy secret, rotate the account trust root and revoke old devices. A
server administrator must never be able to complete recovery alone.

## AI consent boundary

Otto and A2A do not receive an E2EE conversation by default. The desktop client
will decrypt only the messages or attachments the user explicitly selects and
create a bounded, one-use consent envelope. Cloud-model use must visibly state
that selected content is leaving the E2EE boundary. No implementation may
silently fall back to plaintext.

## Release gates

The current release state is `foundation-only`. This gate blocks enabling E2EE,
not unrelated Otto releases. Enabling requires an OpenMLS engine, multi-device
and cross-server interoperability tests, malicious-directory tests, recovery
drills, an external cryptography review and signed product approval.
