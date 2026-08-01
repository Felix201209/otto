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
implemented. Existing enterprise route repositories still use their
synchronous SQLite contracts. If PostgreSQL is selected, the legacy server
entry point fails closed instead of silently writing a second local SQLite
database.

The remaining cutover work is:

1. port repositories to asynchronous PostgreSQL contracts and promote verified
   staging rows into their PostgreSQL domain schemas;
2. switch routes only after import verification, following the documented
   maintenance cutover and rollback gates;
3. wire the implemented [attachment object-storage adapters](./security/attachment-object-storage.md)
   and Redis cache/lease adapter into the asynchronous enterprise routes;
4. qualify multiple replicas, backup/PITR and automatic failover.

Until those stages are complete, PostgreSQL mode is a preparation target and
must not be described as a production-ready enterprise persistence backend.
