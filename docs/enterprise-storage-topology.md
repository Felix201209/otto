# Enterprise storage topology

Otto uses two deliberately different persistence topologies.

## Local and desktop

Desktop and offline deployments keep SQLite with SQLCipher so they can run
without a network dependency. Exactly one Otto process may write the database,
and the database file must remain on a local filesystem. Otto rejects UNC,
SMB, NFS and detected network-mounted SQLite paths before opening the file.
This mode uses local encrypted attachment storage and the process memory cache;
mixed local/clustered backend combinations are rejected to keep health output
and actual persistence behavior consistent.

## Clustered enterprise

The target enterprise topology is stateless Otto Server replicas sharing:

- PostgreSQL for authoritative relational data;
- an S3-compatible object store for attachment ciphertext;
- a shared cache for sessions, rate limits, presence and distributed leases.

PostgreSQL must be a managed HA service or a primary/standby cluster with
replication, automatic failover, backups and point-in-time recovery (PITR).
Otto Server does not implement database failover itself: every replica uses the
provider or cluster proxy connection endpoint. PostgreSQL TLS certificate
verification is enabled by default. Local development may opt out explicitly
with `sslmode=disable` or `OTTO_POSTGRES_SSL_MODE=disable`.

Clustered mode has no local fallback. It requires PostgreSQL, a private
S3-compatible attachment bucket, and a Redis-compatible shared cache even when
temporarily running only one replica:

```powershell
$env:OTTO_ENTERPRISE_DATABASE_BACKEND = 'postgresql'
$env:OTTO_POSTGRES_URL = 'postgresql://otto:<password>@postgres-rw.internal/otto'
$env:OTTO_ENTERPRISE_REPLICA_COUNT = '3'
$env:OTTO_ATTACHMENT_OBJECT_STORE = 's3'
$env:OTTO_S3_BUCKET = 'otto-private'
$env:OTTO_S3_REGION = 'us-east-1'
$env:OTTO_S3_BUCKET_PRIVATE_CONFIRMED = 'true'
$env:OTTO_ATTACHMENT_MAX_BYTES = '10485776'
$env:OTTO_ATTACHMENT_TENANT_QUOTA_BYTES = '107374182400'
$env:OTTO_ATTACHMENT_MIGRATION_GRACE_DAYS = '30'
$env:OTTO_ENTERPRISE_CACHE_BACKEND = 'redis'
$env:OTTO_REDIS_URL = 'rediss://default:<password>@redis.internal:6379/0'
$env:OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE = 'D:\otto-secrets\account-sync.key'
```

Plaintext Redis is rejected unless
`OTTO_REDIS_ALLOW_INSECURE=true` is explicitly set for an isolated development
network. PostgreSQL or Redis URLs are never returned by topology diagnostics;
only credential-free host/database targets are exposed.

Prepare the PostgreSQL migration control plane after building the server:

```powershell
$env:OTTO_ENTERPRISE_DATABASE_BACKEND = 'postgresql'
$env:OTTO_POSTGRES_URL = 'postgresql://otto:password@db.internal/otto'
npm run enterprise:postgres:prepare --workspace=packages/server
```

The command acquires a PostgreSQL advisory transaction lock, verifies applied
migration checksums, applies missing migrations atomically, and refuses a
read-only standby or a schema newer than the running Otto version. Its output
contains only a credential-free database target.

The resumable SQLite/SQLCipher staging importer and the Chinese cutover and
rollback runbook are documented in
[SQLite/SQLCipher 到 PostgreSQL 迁移手册](./operations/sqlite-to-postgresql-migration.zh-CN.md).
The importer defaults to a connection-free dry run, computes logical database,
table, and row hashes, and requires an explicit stopped-writer maintenance
confirmation before it writes PostgreSQL staging tables.

Before deploying replicas, run the full shared-infrastructure preflight:

```powershell
npm run build --workspace=packages/server
npm run enterprise:infrastructure:check --workspace=packages/server
```

The preflight applies checksum-locked PostgreSQL migrations, requires a
writable primary, sends a Redis `PING`, and verifies access to the private S3
bucket. A failure closes all opened clients and exits non-zero; it never
downgrades to SQLite, process memory, or local attachment storage.

## High-availability responsibilities

- Point `OTTO_POSTGRES_URL` at a managed writer endpoint or HA proxy, never a
  fixed standby address. The readiness probe refuses a server in recovery.
- Enable synchronous or provider-recommended replication, automatic failover,
  encrypted backups and PITR. Regularly restore into an isolated environment.
- Run Otto Server replicas without local authoritative state. Session/rate
  limit/presence/task leases belong in Redis; attachment ciphertext belongs in
  S3; relational and object metadata belongs in PostgreSQL.
- Drain readiness-failing replicas at the load balancer. Size connection pools
  across all replicas so their sum remains below PostgreSQL connection limits.
- Never place a SQLite database or its WAL files on NFS, SMB/CIFS, or another
  shared filesystem for multi-instance writes. Otto rejects known network
  paths and filesystems before opening SQLite.

## Migration status

The PostgreSQL lifecycle, migration control plane, resumable verified SQLite
staging importer, S3 attachment adapter, Redis shared-cache/lease adapter,
combined topology validation and production infrastructure preflight are
implemented. PostgreSQL schema v13 now owns organizations, accounts, password
sessions, organization structure and feature flags, audit events, E2EE device
trust/transparency state, encrypted direct messages, attachment ACLs and
message-to-object references. It also owns registration challenges,
organization invitations, encrypted account-sync snapshots, knowledge, Skills,
park services, tickets, commercial-control state and data-governance records.
Tenant identity is a first-class key in every shared business record and event.
The enterprise
launcher selects an isolated asynchronous PostgreSQL server before importing
the legacy SQLite module, so clustered mode cannot create a hidden `data.db`.

The clustered server currently mounts health, password login/logout/session,
SMS registration, organization invitations and joining, account administration,
organization view/structure/features, audit, encrypted account sync, knowledge,
Skills, park services, tickets, commercial control, privacy export/deletion,
E2EE device approval/revocation/transparency, E2EE ciphertext message routes,
and S3 inline/multipart upload, resume, completion and authorized download
routes.
The production composition refuses to start unless PostgreSQL, Redis and the
private S3 bucket all pass readiness. Session entries and active login blocks
are mirrored into Redis with hashed keys; PostgreSQL remains authoritative.
Attachment expiry, orphan and legacy-copy cleanup runs under a Redis lease so
only one replica performs destructive maintenance at a time.
An unimplemented enterprise route still returns
`POSTGRES_ROUTE_NOT_MIGRATED` with HTTP 503 instead of reading or writing
SQLite, but none of the business domains listed above use that fallback.

Account-sync content remains AES-256-GCM ciphertext in PostgreSQL. Every
replica must mount the same externally provisioned 32-byte key at
`OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE`; startup is fail-closed if the file is
missing or invalid. The key is not generated independently by a replica and is
not stored in PostgreSQL, configuration output or logs.

After a verified staging import, prepare every legacy E2EE attachment in S3.
The first command only validates the plan. The execute command requires stopped
SQLite writers and is resumable; it decrypts the old local storage layer when
needed, uploads only the client ciphertext, then downloads and verifies the
complete S3 object before recording a preparation receipt:

```powershell
npm run enterprise:postgres:attachments --workspace=packages/server -- --run <run-id> --dry-run
$env:OTTO_SQLITE_IMPORT_MAINTENANCE_CONFIRMED = 'true'
$env:OTTO_SQLITE_ATTACHMENT_STORAGE_DIR = 'D:\otto-data\attachments'
$env:OTTO_SQLITE_ATTACHMENT_ENCRYPTION_KEY_FILE = 'D:\otto-keys\attachment-storage.key'
npm run enterprise:postgres:attachments --workspace=packages/server -- --run <run-id> --execute
```

The two source-path variables are needed only when staging rows reference the
legacy encrypted filesystem. Inline SQLite ciphertext needs no source key
file. Neither source object keys nor target S3 keys are written to command
output.

Once all attachment receipts are verified, rehearse and execute the atomic
core-domain promotion with the same import run ID:

```powershell
npm run enterprise:postgres:promote --workspace=packages/server -- --run <run-id> --dry-run
$env:OTTO_SQLITE_IMPORT_MAINTENANCE_CONFIRMED = 'true'
npm run enterprise:postgres:promote --workspace=packages/server -- --run <run-id> --execute
```

Promotion acquires a PostgreSQL advisory lock, refuses a non-empty authority,
validates every source table again, rejects unencrypted legacy messages, and
commits core identity, registration/invitation, E2EE/MLS, account-sync,
knowledge, Skills, park, ticketing, commercial-control, privacy-governance,
S3 metadata, participant ACL, quota and attachment-reference rows plus an
idempotent promotion receipt in one transaction. It refuses cutover if even one
staged attachment lacks an exact verified S3 preparation. If the snapshot has
legacy encrypted Skill content, promotion additionally requires
`OTTO_ENTERPRISE_FIELD_KEY_FILE`; the key is used only to transform verified
legacy rows and is never emitted.

For a controlled single-replica migration window, optional
`OTTO_ATTACHMENT_LEGACY_READ_DIR` and
`OTTO_ATTACHMENT_LEGACY_READ_KEY_FILE` enable fallback reads from retained
local encrypted copies. Otto rejects this compatibility mount when more than
one replica is configured. Normal multi-replica operation remains S3-only.

The desktop client automatically selects shared attachment objects when the
server advertises `e2ee_attachment_objects_v1`: it uploads client ciphertext,
sends only its ID/nonce/size/checksum in the message request, and verifies the
downloaded ciphertext before local decryption. Older local servers retain the
legacy inline protocol. Object keys are not exposed as standalone API fields;
they may appear only inside an opaque, short-lived presigned URL. E2EE file keys
are never sent to Otto Server or the object store.

The remaining cutover work is operational qualification rather than route
migration:

1. execute and sign off a real attachment preparation, full-domain cutover,
   dual-read grace and rollback rehearsal against a production-sized snapshot;
2. qualify multiple replicas, backup/PITR restore, Redis failover, object
   lifecycle rules and PostgreSQL automatic failover under the documented load;
3. retain versioned reconciliation evidence for every promoted table and the
   final maintenance-window receipt.

The PostgreSQL business authority is write-serving and no longer splits the
listed domains with SQLite. It must still not be described as production-ready
until the deployment-specific HA, capacity and recovery qualification is signed
off.
