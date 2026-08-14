import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { LocalMeshSigner } from './meshCrypto.js';
import {
  MeshTransparencyLog,
  verifyConsistencyProof,
  verifyInclusionProof,
  verifySignedTreeHead,
} from './meshTransparency.js';

function signer() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new LocalMeshSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
}

describe('mesh transparency audit', () => {
  it('chains minimized authorization, operation, sync and receipt events', () => {
    const log = new MeshTransparencyLog({ tenantId: 'tenant-a', deviceId: 'device-a' });
    const first = log.append({ type: 'authorization.granted', subjectId: 'alice', objectId: 'skill-a', scopeDigest: 'sha256:scope' });
    const second = log.append({ type: 'operation.executed', subjectId: 'alice', objectId: 'skill-a', scopeDigest: 'sha256:result' });
    log.append({ type: 'sync.completed', subjectId: 'alice', objectId: 'device-b', scopeDigest: 'sha256:sync' });
    log.append({ type: 'receipt.issued', subjectId: 'alice', objectId: 'receipt-a', scopeDigest: 'sha256:receipt' });

    expect(first.sequence).toBe(1);
    expect(second.previousHash).toBe(first.eventHash);
    expect(log.verifyChain()).toEqual({ valid: true });
    expect(JSON.stringify(log.events())).not.toContain('prompt');
  });

  it('detects replay, tampering and chain rollback', () => {
    const log = new MeshTransparencyLog({ tenantId: 'tenant-a', deviceId: 'device-a' });
    const event = log.append({ type: 'authorization.revoked', subjectId: 'alice', objectId: 'skill-a', scopeDigest: 'sha256:scope' });
    expect(() => log.import(event)).toThrow('replay');
    expect(log.verifyChain([{ ...event, scopeDigest: 'sha256:tampered' }])).toMatchObject({ valid: false, reason: 'event_hash_mismatch' });
    const checkpoint = log.checkpoint();
    expect(log.verifyCheckpoint(checkpoint)).toEqual({ valid: true });
    log.append({ type: 'operation.executed', subjectId: 'alice', objectId: 'skill-a', scopeDigest: 'sha256:next' });
    expect(log.verifyCheckpoint(checkpoint)).toMatchObject({ valid: false, reason: 'checkpoint_rollback' });
  });

  it('builds verifiable inclusion and consistency proofs and rejects forks', async () => {
    const key = signer();
    const log = new MeshTransparencyLog({ tenantId: 'tenant-a', deviceId: 'device-a' });
    for (let index = 0; index < 4; index += 1) {
      log.append({ type: 'operation.executed', subjectId: 'alice', objectId: `object-${index}`, scopeDigest: `sha256:${index}` });
    }
    const oldHead = await log.signedTreeHead(2, key);
    const head = await log.signedTreeHead(4, key);
    expect(verifySignedTreeHead(head, key.publicKeyPem)).toBe(true);
    expect(verifyInclusionProof(log.inclusionProof(2, 4), head.treeHead)).toBe(true);
    expect(verifyConsistencyProof(log.consistencyProof(2, 4), oldHead.treeHead, head.treeHead)).toBe(true);
    expect(log.observeTreeHead(head.treeHead)).toEqual({ status: 'accepted' });
    expect(log.observeTreeHead({ ...head.treeHead, rootHash: 'sha256:fork' })).toMatchObject({ status: 'quarantined', reason: 'root_conflict' });
  });

  it('restores a fully offline log from a signed checkpoint', async () => {
    const key = signer();
    const log = new MeshTransparencyLog({ tenantId: 'tenant-a', deviceId: 'device-a' });
    log.append({ type: 'sync.completed', subjectId: 'alice', objectId: 'device-b', scopeDigest: 'sha256:sync' });
    const checkpoint = await log.signedCheckpoint(key);
    const restored = MeshTransparencyLog.fromCheckpoint(checkpoint, key.publicKeyPem);
    expect(restored.verifyChain()).toEqual({ valid: true });
    expect(restored.events()).toEqual(log.events());
  });
});
