# Attachment object storage

Otto's attachment-storage boundary is the asynchronous
`AttachmentObjectStore` interface. Development and offline deployments can use
the encrypted local-filesystem adapter. Clustered deployments use the S3
adapter with AWS S3, MinIO, or another compatible private object store. Object
storage contains bytes only; PostgreSQL is the authority for ownership,
authorization, quota, upload state, and migration state.

## Security invariants

- An E2EE client encrypts the file before upload. Otto Server and the object
  store receive only client ciphertext and its SHA-256 checksum.
- The E2EE file key never appears in an object key, URL, object metadata, tag,
  audit event, or server log. Server-side KMS cannot take custody of it.
- Object keys are random IDs such as `attachments/v1/ab/<random>.bin`. They do
  not contain an organization, account, conversation, or original filename.
- The bucket is private. The S3 runtime refuses to start unless the operator
  explicitly confirms that policy with
  `OTTO_S3_BUCKET_PRIVATE_CONFIRMED=true`; the adapter never requests a public
  ACL.
- Authorization is an exact PostgreSQL ACL lookup by attachment, organization,
  and account. A bucket path or possession of an object key is never treated as
  authorization. The HTTP route must validate the current session immediately
  before asking the storage service for a download.
- Upload and download URLs expire after 30 to 900 seconds. Upload-part URLs are
  bound to one bucket, object, upload ID, part number, content length, and
  ciphertext checksum.
- Checksums cover client ciphertext, not plaintext. Multipart completion reads
  the completed object and verifies its full size and SHA-256 digest before the
  metadata state becomes `available`.
- Optional SSE-KMS protects the provider's stored copy as a second layer. It
  does not replace client E2EE and does not change the client-key trust domain.

Otto Server cannot scan an E2EE attachment's plaintext. If malware inspection
is required, the desktop client must decrypt and scan locally and tell the user
that this processing is occurring.

## Upload and quota state

Multipart uploads follow this state machine:

```text
reserve quota -> initialize -> upload/record parts -> verify -> available
       |              |                 |                |
       +--------------+-----------------+----------------+-> failed/rollback
```

Quota is reserved in the same PostgreSQL transaction that creates the object
metadata and ACL rows. The server assigns a bounded upload expiry instead of
trusting a caller-supplied lifetime. Part ETags, byte counts, and checksums are
stored in PostgreSQL, so a new stateless server instance can resume the same
S3 multipart upload. Completion first atomically claims a durable `verifying`
state with a bounded lease, preventing another completion or expiry worker from
racing it. A crashed verifier becomes eligible for cleanup when that lease
expires. Success moves tenant bytes from `reserved` to `stored` in one database
transaction. Failure or expiry aborts the multipart upload, removes a completed
but unverified object when necessary, releases quota, and records a non-secret
failure code.

Operators must run the cleanup methods on a distributed scheduled worker:

- `sweepExpiredUploads` first claims a durable `cleaning` state, then aborts
  timed-out multipart uploads so completion and deletion cannot race;
- `sweepOrphans` removes old unreferenced objects only after a safety grace
  period; the scheduler persists its returned page cursor so referenced objects
  at the start of a large bucket cannot starve later pages;
- `purgeMigratedLegacy` removes verified local copies only after their
  migration grace period.

Cleanup excludes active metadata references, recent uploads, legal holds, and
backup objects. Provider lifecycle rules should independently abort incomplete
multipart uploads after a conservative interval, but must not delete live Otto
objects based only on an object-key prefix.

## Local-to-S3 migration

Migration claims one available attachment in PostgreSQL, copies the ciphertext,
and verifies target size and checksum. Only then does one metadata update make
S3 authoritative and retain the old local location for dual-read fallback. A
failed copy deletes the target and leaves the local source authoritative. The
local copy is deleted after the configured grace period; legal holds always
win over cleanup. The cleanup worker atomically claims a `purging` state in
PostgreSQL before deletion; a database constraint prevents a legal hold and an
active purge claim from coexisting.

This gives the migration order `copy -> verify -> switch -> grace -> delete`.
It never uses a shared SQLite file or a mounted local attachment directory as
multi-instance storage.

## Configuration

Local encrypted storage remains the default. S3 mode uses the AWS SDK default
credential chain; credentials must not be embedded in endpoint URLs or logged.
The runtime rejects local attachment storage when more than one Otto Server
replica is configured.

| Variable                           | Meaning                                               |
| ---------------------------------- | ----------------------------------------------------- |
| `OTTO_ATTACHMENT_OBJECT_STORE`     | `local` or `s3`                                       |
| `OTTO_S3_BUCKET`                   | Private attachment bucket                             |
| `OTTO_S3_REGION`                   | S3 signing region                                     |
| `OTTO_S3_ENDPOINT`                 | Optional S3-compatible endpoint                       |
| `OTTO_S3_FORCE_PATH_STYLE`         | Enable for providers such as many MinIO deployments   |
| `OTTO_S3_BUCKET_PRIVATE_CONFIRMED` | Must be `true` in S3 mode                             |
| `OTTO_S3_ALLOW_INSECURE`           | Explicit development-only opt-in for an HTTP endpoint |
| `OTTO_S3_PRESIGN_TTL_SECONDS`      | URL lifetime, from 30 through 900 seconds             |
| `OTTO_S3_KMS_KEY_ID`               | Optional SSE-KMS key identifier                       |

Example for a TLS-enabled MinIO deployment:

```text
OTTO_ATTACHMENT_OBJECT_STORE=s3
OTTO_S3_BUCKET=otto-private-attachments
OTTO_S3_REGION=us-east-1
OTTO_S3_ENDPOINT=https://minio.internal:9000
OTTO_S3_FORCE_PATH_STYLE=true
OTTO_S3_BUCKET_PRIVATE_CONFIRMED=true
OTTO_S3_PRESIGN_TTL_SECONDS=120
```

## Delivery boundary

The object-store interface, local and S3 adapters, PostgreSQL metadata
repository, migrations, resumable state, migration service, and cleanup
operations are implemented. Existing enterprise chat routes still use their
legacy synchronous SQLite repository until the broader PostgreSQL route
cutover is complete. Selecting PostgreSQL continues to fail closed rather than
silently splitting authoritative data between PostgreSQL and local SQLite.
