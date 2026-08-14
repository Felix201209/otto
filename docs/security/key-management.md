# Server key management and rotation

Otto separates server-side key custody from client E2EE. The server key
management layer may protect database, backup, field-encryption, and object
storage keys. It must never receive an E2EE identity private key, device
private key, or client recovery secret. The `KeyProvider` runtime enforces this
trust-domain boundary before a provider call is made.

## Unified provider boundary

`KeyProvider` exposes `wrap`, `unwrap`, `rewrap`, `healthCheck`, and
`getKeyVersion`. Named factories cover:

- AWS KMS
- Azure Key Vault
- Google Cloud KMS
- HashiCorp Vault transit
- PKCS#11 HSM

Each deployment host supplies a narrow `KeyProviderTransport` backed by the
official provider SDK, its workload identity, or an HSM session. Provider
credentials, SDK clients, PKCS#11 PINs, and sessions remain outside Otto's
configuration and database. The transport must bind the supplied purpose and
opaque scope as authenticated encryption context where the provider supports
it. A provider mismatch, unhealthy provider, empty envelope, invalid version,
or non-32-byte DEK is fatal.

This split lets cloud and appliance distributions own SDK versions and
credential bootstrapping without adding them to the runtime kernel. It does
not permit a mock or local default in production: the deployment must inject
one of the configured transports, and startup fails if its health check or
unwrap fails.

## Envelope encryption

SQLCipher receives a random 256-bit DEK. KMS/HSM protects only that DEK with a
KEK, so normal database reads and writes never call a remote service. The
envelope manifest stores only provider name, opaque key ID, KEK version,
wrapped DEK ciphertext, DEK version, and timestamps. Plaintext DEKs exist only
in process memory and are zeroed when the data platform closes.

`createSqlCipherEnvelopedRuntime` performs provider health validation and DEK
unwrap before returning a SQLCipher driver/provider pair. If the manifest is
missing, creation must be explicitly enabled for first provisioning. There is
no plaintext, default-key, or offline-file fallback.

The built-in offline file provider remains available for development,
air-gapped, and removable-custody deployments. Its file is a separate trust
choice and must not be silently selected when a remote provider is configured.

## Rotation state machines

KEK and DEK rotation are deliberately different:

| Rotation | Operation                                    | Database rewrite | Normal cadence         |
| -------- | -------------------------------------------- | ---------------- | ---------------------- |
| KEK      | Rewrap the existing DEK envelope             | No               | Frequent and automatic |
| DEK      | Generate a new DEK and run SQLCipher `rekey` | Yes              | Maintenance window     |

KEK rotation follows `prepare -> rewrap -> verify -> activate -> retire`.
Rewrapped envelopes are verified against the in-memory DEKs before activation.
The new manifest remains staged until the backup key catalog is prepared and
activated; failure before activation aborts the stage and retains the old
manifest.

DEK rotation durably writes a pending wrapped DEK before SQLCipher starts.
It then prepares backup metadata, creates and validates an encrypted recovery
snapshot, rekeys and verifies the database, activates the version, and retires
the old version only after the configured recovery window. Failures before
rekey cancel the pending envelope. Failures after rekey restore the verified
snapshot and previous provider version through the rotation target.

`createAutomaticKeyRotationTask` may run on every stateless server replica.
Due timestamps are held in the shared state store, while the coordinator uses
an owner-checked Redis lease to elect one executor. DEK rotation additionally
requires the deployment's maintenance-window predicate.

Backups and snapshots must record both DEK and KEK versions. A
`BackupKeyRotationTarget` implements prepare, activate, rollback, and retire so
database and backup catalogs move through the same two-phase operation. Old
versions remain decryptable only for the documented recovery window.

## Audit and recovery

Every coordinator phase emits an audit event with event/time, actor,
operation, phase, result, request ID, and old/new version identifiers. The
audit type has no field for plaintext, ciphertext, key material, credentials,
or provider responses. Production must persist these events in an append-only
or otherwise tamper-evident audit sink.

Recovery requires a stable request ID and two distinct approvers. The gate
rejects the client-E2EE trust domain even with two approvals. Recovery
custodians should be organizationally separate, and deployments must exercise
database, snapshot, backup, provider-outage, and total-key-loss runbooks on a
regular schedule.

The recovery window is not a substitute for custody: after every retained KEK
and backup envelope is destroyed, data is intentionally unrecoverable.
