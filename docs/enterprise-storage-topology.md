# Enterprise storage topology

Otto uses two deliberately different persistence topologies.

## Local and desktop

Desktop and offline deployments keep SQLite with SQLCipher so they can run
without a network dependency. Exactly one Otto process may write the database,
and the database file must remain on a local filesystem. Otto rejects UNC,
SMB, NFS and detected network-mounted SQLite paths before opening the file.

## Clustered enterprise

The target enterprise topology is stateless Otto Server replicas sharing:

- PostgreSQL for authoritative relational data;
- an S3-compatible object store for attachment ciphertext;
- a shared cache for sessions, rate limits, presence and distributed leases.

Set `OTTO_ENTERPRISE_DATABASE_BACKEND=postgresql`, `OTTO_POSTGRES_URL` and
`OTTO_ENTERPRISE_REPLICA_COUNT` for this topology. PostgreSQL TLS certificate
verification is enabled by default. Local development may opt out explicitly
with `sslmode=disable` or `OTTO_POSTGRES_SSL_MODE=disable`.

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

## Migration status

This first migration slice installs the PostgreSQL lifecycle and SQLite-import
control schema. Existing enterprise route repositories still use their
synchronous SQLite contracts. If PostgreSQL is selected, the legacy server
entry point fails closed instead of silently writing a second local SQLite
database.

The remaining cutover work is:

1. port repositories to asynchronous PostgreSQL contracts;
2. add a resumable SQLite-to-PostgreSQL importer with row-count and hash checks;
3. switch routes only after import verification, with a documented rollback;
4. add shared object-storage and cache adapters;
5. qualify multiple replicas, backup/PITR and automatic failover.

Until those stages are complete, PostgreSQL mode is a preparation target and
must not be described as a production-ready enterprise persistence backend.
