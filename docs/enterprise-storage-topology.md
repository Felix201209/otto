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
$env:OTTO_ENTERPRISE_CACHE_BACKEND = 'redis'
$env:OTTO_REDIS_URL = 'rediss://default:<password>@redis.internal:6379/0'
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
implemented. PostgreSQL schema v5 now owns organizations, accounts, password
sessions, organization structure and feature flags, audit events, E2EE device
trust/transparency state, encrypted direct messages, attachment ACLs and
message-to-object references. The enterprise
launcher selects an isolated asynchronous PostgreSQL server before importing
the legacy SQLite module, so clustered mode cannot create a hidden `data.db`.

The clustered server currently mounts health, password login/logout/session,
account administration, organization view/structure/features, audit, E2EE
device approval/revocation/transparency, E2EE ciphertext message routes, S3
inline/multipart upload, resume, completion and authorized download routes.
The production composition refuses to start unless PostgreSQL, Redis and the
private S3 bucket all pass readiness. Session entries and active login blocks
are mirrored into Redis with hashed keys; PostgreSQL remains authoritative.
Attachment expiry, orphan and legacy-copy cleanup runs under a Redis lease so
only one replica performs destructive maintenance at a time.
Every route outside that migrated core returns
`POSTGRES_ROUTE_NOT_MIGRATED` with HTTP 503 instead of reading or writing
SQLite.

After a verified staging import, rehearse and execute the atomic core-domain
promotion with the import run ID:

```powershell
npm run enterprise:postgres:promote --workspace=packages/server -- --run <run-id> --dry-run
$env:OTTO_SQLITE_IMPORT_MAINTENANCE_CONFIRMED = 'true'
npm run enterprise:postgres:promote --workspace=packages/server -- --run <run-id> --execute
```

Promotion acquires a PostgreSQL advisory lock, refuses a non-empty authority,
validates every source table again, rejects unencrypted legacy messages, and
commits all supported tables plus an idempotent promotion receipt in one
transaction. If message attachments exist it refuses cutover until the S3
migration is run, so ciphertext cannot become inaccessible.

The desktop client automatically selects shared attachment objects when the
server advertises `e2ee_attachment_objects_v1`: it uploads client ciphertext,
sends only its ID/nonce/size/checksum in the message request, and verifies the
downloaded ciphertext before local decryption. Older local servers retain the
legacy inline protocol. Object keys are not exposed as standalone API fields;
they may appear only inside an opaque, short-lived presigned URL. E2EE file keys
are never sent to Otto Server or the object store.

The remaining cutover work is:

1. port SMS registration, organization invites, account sync, knowledge,
   skills, park, ticketing, commercial-control and data-governance repositories;
2. promote legacy SQLite attachment ciphertext to S3 with copy, checksum,
   authority switch, dual-read grace and rollback rehearsal;
3. promote the remaining verified staging
   tables to their PostgreSQL domain schemas;
4. qualify multiple replicas, backup/PITR, Redis failover, object lifecycle
   rules and PostgreSQL automatic failover.

The PostgreSQL core is a real write-serving authority, but until those stages
are complete the full Otto Enterprise product must not be described as a
production-ready clustered backend.
