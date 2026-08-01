# SQLCipher whole-database encryption

Otto requires SQLCipher for the enterprise database in every non-test runtime.
It fails closed if the custody key, native binding, SQLCipher runtime, key
authentication, or cipher integrity check is unavailable. Emergency plaintext
compatibility requires an explicit `OTTO_DATABASE_ENCRYPTION=disabled` opt-out.

## Key custody

The database layer accepts the `SqlCipherKeyProvider` contract. Remote custody
uses the unified `KeyProvider` and an enveloped SQLCipher provider; AWS KMS,
Azure Key Vault, Google Cloud KMS, HashiCorp Vault, and PKCS#11 HSM transports
share the same fail-closed boundary. The built-in headless provider continues
to support a customer-controlled offline file:

```text
OTTO_DATABASE_ENCRYPTION=required
OTTO_DATABASE_ENCRYPTION_KEY_FILE=/mounted-custody/otto-database.key
OTTO_SQLCIPHER_NATIVE_BINDING=/opt/otto/sqlcipher/better_sqlite3.node
```

The initial offline file is exactly 32 cryptographically random bytes. It must
be provisioned outside the Otto data directory, backed up separately, limited
to the service account, and never committed or copied into an image. Set
`OTTO_DATABASE_ENCRYPTION_KEY_READONLY=true` for read-only removable custody;
Otto will then reject automatic rotation.

On the first managed rotation, Otto converts a writable raw file into an
`otto-sqlcipher-keyring-v1` file. The keyring durably stages the next key before
rekey, retains the previous key after commit, and can recover an interrupted
provider commit. The file contains custody material and remains secret.

## Plain SQLite migration

When the exact `SQLite format 3\0` header is detected, the official
`sqlcipher_export()` path writes a new encrypted file. Otto validates
`cipher_version`, `cipher_integrity_check`, normal integrity, and the schema
before atomically switching files. The original main database and any WAL/SHM
sidecars move into `database-recovery/`. Any failed check restores the original
set; ciphertext is never retried as plaintext.

## Rotation

Stop the enterprise server and run:

```text
otto-database-encryption rotate --confirm-rotation
```

Rotation creates and verifies an encrypted recovery snapshot, stages a new key,
runs SQLCipher `PRAGMA rekey`, opens the database with the new key, and only then
commits the provider version. A failure restores the old encrypted snapshot.
The command refuses a live enterprise runtime lock and prints the retained
recovery path.

## Backup and restore

Online backup delegates snapshot creation and validation to the keyed SQLCipher
driver. The encrypted database plus the offline keyring (or a host-provided
keystore/KMS recovery envelope) enter the existing outer encrypted backup
archive. Restore authenticates the archive, opens the staged database with its
recovery material, runs database/foreign-key/schema and attachment checks, and
only then swaps the protected data set. The prior database and keyring remain in
the restore rollback directory.

The backup encryption key must be held separately from both the database and
database custody key; losing all database key candidates and all recovery
archives is intentionally unrecoverable.

Remote-provider envelope rules, KEK versus DEK rotation, distributed locking,
backup version synchronization, audit fields, and dual-control recovery are
specified in [server key management and rotation](key-management.md).

## Native release assets

`.github/workflows/sqlcipher-native.yml` builds pinned official SQLCipher for
Windows x64, macOS x64/arm64, and Linux x64/arm64. Each Electron-ABI artifact
must pass correct-key, wrong-key, encrypted-header, ordinary-Python-SQLite
rejection, and `cipher_integrity_check` behavior tests. Every target emits a
checksummed CycloneDX 1.5 SBOM identifying SQLCipher and better-sqlite3. The
matrix verifier checks the platform binary magic, manifest and SBOM SHA-256,
then GitHub records build provenance for each binding. The release workflow
verifies those attestations before copying the target binding outside
`app.asar`; installer signing and packaged-runtime checks remain mandatory.

Third-party notices are in `native/sqlcipher/THIRD_PARTY_NOTICES.md`.
