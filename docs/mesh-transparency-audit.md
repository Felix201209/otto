# Mesh transparency audit

`mesh_rendezvous/meshTransparency.ts` defines the MESH-08 protocol. Each device keeps an
append-only, tenant-scoped hash chain and periodically derives a Merkle tree. Events contain
only type, logical sequence, tenant/device/subject/object identifiers and a caller-provided
SHA-256 scope digest. Prompts, outputs, private messages, files, tokens and key material are
not accepted as event fields and must never be encoded into `scopeDigest`.

## Publication and offline behavior

Devices can append while fully offline and sign a checkpoint containing their local evidence.
On reconnection they should submit only a signed tree head and the requested inclusion or
consistency proof. A full signed checkpoint is for device-local recovery or an explicitly
authorized enterprise evidence export; it is not a root-server upload format. The protocol
uses Ed25519 and SHA-256, with no public chain, token, mining or consensus dependency.

Tree heads bind tenant, device, epoch, size, current root and previous root. A conflicting root
at the same size, a smaller head after a larger observed head, a broken event link, replay,
tampering or inconsistent proof enters quarantine and requires human investigation. Logical
sequence is authoritative when clocks disagree. Root-server unavailability does not block safe
local work, but clients must not claim that high-risk work is transparency-proven until proofs
can be checked.

## Access, retention and auditability

Employees may inspect their own device chain and inclusion receipts. Tenant auditors need an
explicit audit-view capability and should receive minimized tree heads/proofs by default;
cross-employee event export requires elevated approval. Every audit view/export must itself be
written as an authorization/operation audit event. Root metadata should retain tree heads and
fork alerts for the tenant policy period; local detailed evidence follows enterprise policy and
must remain available long enough to reconstruct requested proofs. Deletion after retention is
allowed only as an auditable policy transition, never as silent rewriting of an existing chain.
