# Otto E2EE threat model

Status: release candidate. This document is part of the external-audit scope.

## Security objective

For enterprise direct chat and its attachments, only approved participant
devices may obtain plaintext. The enterprise server routes ciphertext and may
be unavailable, buggy, compromised, or actively hostile. A server must not be
able to silently make a production build use plaintext transport.

## Protected assets

- message and attachment plaintext;
- MLS epoch, sender-ratchet, signature, HPKE, and recovery secrets;
- device identity private keys and OS-protected local history keys;
- membership, device-approval, revocation, and security-reset integrity;
- conversation, tenant, device, epoch, generation, and attachment bindings.

## Trusted components

- the approved endpoint operating system and Electron `safeStorage` backend;
- the audited OpenMLS version and Otto native MLS boundary;
- a user comparison of the safety number or QR code for new devices;
- external-auditor and Otto release-approval public keys in the release trust
  store;
- the signed release process that decides whether the server may advertise
  `e2ee_mls_v1`.

The enterprise server, database, object storage, network, update mirror, and
renderer process are not trusted with E2EE private keys or plaintext.

## Required hostile-server tests

Every release candidate reruns the machine-readable scenario inventory in
`security/e2ee-release-status.json` and writes a report bound to the exact
security-profile digest. The suite covers:

1. rollback or fork of a previously observed device-transparency history;
2. key or device substitution inconsistent with the authenticated directory;
3. message, Commit, attachment, manifest, AAD, or generation tampering;
4. future key distribution to a revoked device;
5. substitution of a transport acknowledgement;
6. skipped epochs and malformed or replayed Commits;
7. cross-tenant or cross-server device injection;
8. replay, idempotency, durable cursor, and crash-recovery behavior;
9. a server-advertised MLS session attempting to downgrade to plaintext or the
   legacy envelope protocol.

## Explicit limitations

The server currently hosts the key-transparency hash chain. Local checkpoint
pinning detects rollback or a changed history after a device has observed a
head. It cannot detect a permanent first-view split presented to devices that
never compare safety numbers and have no independent witness. Users must
verify safety numbers or QR codes out of band. Otto must not claim automatic
protection from a malicious device-directory server until an independently
witnessed transparency service is deployed and audited.

Endpoint compromise can expose plaintext available on that endpoint. A device
that remains controlled must be revoked; post-compromise recovery is not a
substitute for endpoint remediation. Losing every approved device and every
recovery bundle permanently loses the corresponding keys.

Traffic analysis is out of scope: routing identifiers, timing, ciphertext
sizes, delivery state, and participant relationships remain visible to the
enterprise server. The protocol does not claim anonymity or metadata privacy.

## Release decision

Candidate transport may ship while production MLS is disabled. Production MLS
may be advertised only when all of the following bind to the same security
profile:

- a fresh clean-source hostile-server test report passes every required case;
- an independent auditor signs a server-hostile assessment with no unresolved
  critical or high findings;
- separate Otto security and release approvers sign the production decision;
- the generated server policy matches those records and CI verifies it;
- any later security-profile change invalidates the approval and requires a
  new assessment.

This gate is release assurance, not a claim that Otto authored its own
independent audit.
