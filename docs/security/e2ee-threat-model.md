# Otto E2EE threat model

Status: design baseline for review. This document does not claim that the
current production protocol satisfies every goal below.

## Scope

This model covers enterprise one-to-one chat, encrypted attachments, local
message search, device enrollment and recovery, one-time A2A disclosure, and
opaque delivery between independently operated Otto servers.

The protected content is:

- message text and attachment names, MIME types, and bytes;
- locally generated search terms and search results;
- A2A context selected by a user for one invocation;
- device, recovery, MLS epoch, and attachment content keys.

Routing metadata is not hidden in the first protocol version. Servers can see
tenant and account identifiers, participating devices, message times and
sizes, delivery state, MLS group identifiers, and traffic volume.

## Trust boundaries

1. **Desktop trusted computing base**: the signed Otto desktop application,
   its Electron main process, OpenMLS runtime, OS secure storage, and local
   encrypted database.
2. **Renderer**: treated as less trusted. It receives decrypted content needed
   for the visible conversation but never receives long-lived private keys.
3. **Enterprise server**: an untrusted delivery and persistence service for
   private content. It may authorize account membership and route ciphertext,
   but it must not hold content keys.
4. **Otto control/witness service**: independently operated trust anchor for
   signed deployment policy and witnessed transparency checkpoints. It must
   not receive private message content.
5. **Federation gateway**: an untrusted opaque relay. It authenticates server
   identities and applies abuse controls but cannot decrypt MLS traffic.
6. **A2A runtime**: receives only the exact context authorized by a signed,
   expiring, single-use grant on the local device.

## Adversaries

### Malicious or compromised enterprise server

The server can drop, delay, reorder, replay, duplicate, or selectively deliver
traffic. It can return stale device directories, create split views, mutate
database rows, and collude with another server. It cannot forge a valid device
certificate, MLS message, transparency checkpoint, or A2A grant without a
corresponding private key.

Required behavior:

- clients reject unknown epochs, replayed handshakes, invalid signatures, and
  directories inconsistent with a witnessed checkpoint;
- clients surface delivery gaps and unresolved forks instead of silently
  accepting a new trust root;
- the server cannot add a device to an MLS group solely from an account
  session or administrator action.

### Database or object-store attacker

The attacker can read and edit server database rows and attachment objects.
Confidentiality depends on MLS and attachment AEAD, not disk encryption.
Clients reject changed ciphertext, attachment substitution, broken inclusion
proofs, and rollback to a previously observed tree size.

### Stolen or lost device

An unlocked compromised device can read content available to that device and
act until it is removed. Removal must rotate the MLS epoch and stop future
delivery. It cannot erase content already obtained by the stolen device.
Loss of every device without a user-held recovery secret is intentionally
unrecoverable by an enterprise administrator.

### Malicious participant or Agent

A conversation participant can disclose plaintext they legitimately receive.
E2EE cannot prevent screenshots or copying. Otto and A2A do not automatically
gain access to private chat. A2A access is explicit, scoped, expiring,
single-use, and locally consumed.

### Federation attacker

A remote server or gateway can spoof routing requests, replay envelopes, or
route a message to the wrong tenant. Mutual server authentication, signed
deployment identities, destination binding, replay caches, quotas, and
end-to-end MLS authentication are all required. A gateway is never a device
or MLS group member.

## Security goals

- End-to-end confidentiality and integrity for messages and attachments.
- Forward secrecy and post-compromise security through RFC 9420 epoch updates.
- Cryptographic device enrollment with proof of possession and approval by an
  already trusted device or an explicit user recovery ceremony.
- Detectable device-directory rollback and equivocation using Merkle inclusion
  and consistency proofs plus an independent signed witness checkpoint.
- Local-only full-text search whose index is encrypted with a distinct key.
- Verifiable, expiring, single-use A2A disclosure grants.
- Safe cross-server routing without sharing content keys with either server or
  the federation gateway.
- Fail-closed activation controlled by a signed module policy and an external
  audit artifact bound to the reviewed protocol version and source commit.

## Non-goals

- Hiding traffic timing, participant relationships, sizes, or IP addresses.
- Protecting plaintext after an authorized recipient exports or captures it.
- Allowing a server administrator to recover user private messages.
- Calling the legacy `device-envelope-v1` protocol MLS or Signal-grade.
- Enabling the MLS path before migration, interoperability, and external audit
  gates pass.

## Security invariants

1. A private key never crosses the desktop main-process boundary unencrypted.
2. A server response cannot silently replace a pinned account or device key.
3. Every active device is represented by a valid certificate and an MLS leaf.
4. Revocation is effective only after a committed MLS remove operation.
5. Attachment keys are derived or transported inside the matching MLS epoch
   and are bound to conversation, message, attachment, and content metadata.
6. Search indexes contain no plaintext and never leave the device.
7. An A2A grant is bound to requester, responder, selected content digests,
   purpose, expiry, and a nonce consumed exactly once.
8. Cross-server relays accept only signed deployment identities and cannot
   downgrade protocol or ciphersuite.
9. Audit or feature-policy failure keeps E2EE disabled; it never falls back to
   plaintext under the same conversation.

## Required adversarial tests

| Scenario | Expected result |
| --- | --- |
| Server replaces a device key | Certificate or transparency proof rejected |
| Server returns an older tree head | Monotonic checkpoint rollback rejected |
| Server presents two roots at one tree size | Witness/gossip fork detected |
| Ciphertext or attachment object changes | AEAD or signature verification fails |
| Database replays an old MLS message | Epoch/replay validation fails |
| Revoked device requests a new key | No envelope or MLS membership is issued |
| Recovery bundle uses a wrong passphrase | Import fails without partial mutation |
| A2A grant is replayed or widened | Local verifier rejects it |
| Gateway changes destination server | Deployment and destination signature fails |
| Audit report or signed policy is absent | Production feature remains disabled |

## Residual risks

Metadata remains visible to the delivery infrastructure. A first-contact trust
decision remains vulnerable until an independently witnessed checkpoint is
available. Client compromise can expose local plaintext and current keys.
OpenMLS integration and the surrounding application protocol require an
independent cryptographic and implementation audit before release.
