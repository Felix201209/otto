import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { LocalMeshSigner } from './meshCrypto.js';
import {
  MeshSyncEngine,
  createSignedMeshEvent,
  type MeshSyncEvent,
} from './meshSync.js';

function signer() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new LocalMeshSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
}

async function event(input: {
  signer: LocalMeshSigner;
  deviceId: string;
  sequence: number;
  parents?: string[];
  value: string;
  eventId?: string;
}): Promise<MeshSyncEvent> {
  return createSignedMeshEvent({
    signer: input.signer,
    eventId: input.eventId,
    tenantId: 'tenant-a',
    ownerId: 'alice',
    objectId: 'note-1',
    objectType: 'map',
    deviceId: input.deviceId,
    sequence: input.sequence,
    epoch: 3,
    parents: input.parents ?? [],
    chunks: [{ chunkId: `chunk-${input.deviceId}-${input.sequence}`, digest: 'sha256:present' }],
    operation: { kind: 'set', field: 'body', value: input.value },
  });
}

function engine(keys: Map<string, string>, chunks = new Set<string>()) {
  return new MeshSyncEngine({
    expectedTenantId: 'tenant-a',
    currentEpoch: 3,
    resolveDeviceKey: (deviceId) => keys.get(deviceId) ?? null,
    authorize: () => true,
    hasChunk: (chunkId) => chunks.has(chunkId),
  });
}

describe('mesh device-first sync', () => {
  it('deterministically merges concurrent offline map edits and emits a verifiable receipt', async () => {
    const a = signer();
    const b = signer();
    const keys = new Map([['device-a', a.publicKeyPem], ['device-b', b.publicKeyPem]]);
    const chunks = new Set(['chunk-device-a-1', 'chunk-device-b-1']);
    const left = await event({ signer: a, deviceId: 'device-a', sequence: 1, value: 'left' });
    const right = await event({ signer: b, deviceId: 'device-b', sequence: 1, value: 'right' });

    const first = engine(keys, chunks);
    expect(first.apply(right).status).toBe('applied');
    expect(first.apply(left).status).toBe('applied');
    const second = engine(keys, chunks);
    second.apply(left);
    second.apply(right);

    expect(first.object('note-1')).toEqual(second.object('note-1'));
    expect(first.object('note-1')).toMatchObject({ body: 'right' });
    expect(first.receipts()).toHaveLength(2);
    expect(first.receipts()[1]).toMatchObject({ version: 1, objectId: 'note-1', resultHeads: expect.any(Array) });
  });

  it('is idempotent, buffers gaps, detects forks, and resumes from a checkpoint', async () => {
    const a = signer();
    const keys = new Map([['device-a', a.publicKeyPem]]);
    const chunks = new Set(['chunk-device-a-1', 'chunk-device-a-2']);
    const one = await event({ signer: a, deviceId: 'device-a', sequence: 1, value: 'one' });
    const two = await event({ signer: a, deviceId: 'device-a', sequence: 2, parents: [one.eventId], value: 'two' });
    const fork = await event({ signer: a, deviceId: 'device-a', sequence: 2, parents: [one.eventId], value: 'fork', eventId: 'evt-fork' });
    const source = engine(keys, chunks);

    expect(source.apply(two).status).toBe('buffered_gap');
    expect(source.apply(one).status).toBe('applied');
    expect(source.apply(one).status).toBe('duplicate');
    expect(source.apply(fork).status).toBe('quarantined');
    expect(source.conflicts()).toContainEqual(expect.objectContaining({ reason: 'log_fork' }));

    const restored = MeshSyncEngine.fromCheckpoint(source.checkpoint(), {
      expectedTenantId: 'tenant-a', currentEpoch: 3,
      resolveDeviceKey: (id) => keys.get(id) ?? null, authorize: () => true,
      hasChunk: (id) => chunks.has(id),
    });
    expect(restored.object('note-1')).toEqual({ body: 'two' });
    expect(restored.heads('note-1')).toEqual([two.eventId]);
  });

  it('quarantines tampering, rollback, cross-tenant input, and missing chunks without overwriting trusted state', async () => {
    const a = signer();
    const keys = new Map([['device-a', a.publicKeyPem]]);
    const chunks = new Set(['chunk-device-a-1', 'chunk-device-a-2']);
    const trusted = await event({ signer: a, deviceId: 'device-a', sequence: 1, value: 'trusted' });
    const subject = engine(keys, chunks);
    expect(subject.apply(trusted).status).toBe('applied');

    const tampered = { ...trusted, operation: { ...trusted.operation, value: 'evil' } };
    expect(subject.apply(tampered).reason).toBe('invalid_signature');
    const next = await event({ signer: a, deviceId: 'device-a', sequence: 2, parents: [trusted.eventId], value: 'next' });
    expect(subject.apply(next).status).toBe('applied');
    const rollback = await event({ signer: a, deviceId: 'device-a', sequence: 1, value: 'rollback', eventId: 'evt-rollback' });
    expect(subject.apply(rollback).reason).toBe('sequence_rollback');
    const crossTenant = { ...trusted, eventId: 'evt-other', tenantId: 'tenant-b' };
    expect(subject.apply(crossTenant).reason).toBe('tenant_mismatch');
    const missing = await event({ signer: a, deviceId: 'device-a', sequence: 2, parents: [trusted.eventId], value: 'missing' });
    chunks.delete('chunk-device-a-2');
    expect(subject.apply(missing).reason).toBe('missing_chunk');
    expect(subject.object('note-1')).toEqual({ body: 'next' });
  });

  it('requires manual resolution for security state conflicts', async () => {
    const a = signer();
    const b = signer();
    const keys = new Map([['device-a', a.publicKeyPem], ['device-b', b.publicKeyPem]]);
    const chunks = new Set(['chunk-device-a-1', 'chunk-device-b-1']);
    const base = { tenantId: 'tenant-a', ownerId: 'alice', objectId: 'grant-1', objectType: 'security' as const, sequence: 1, epoch: 3, parents: [], chunks: [] };
    const left = await createSignedMeshEvent({ ...base, signer: a, deviceId: 'device-a', operation: { kind: 'set', field: 'enabled', value: true } });
    const right = await createSignedMeshEvent({ ...base, signer: b, deviceId: 'device-b', operation: { kind: 'set', field: 'enabled', value: false } });
    const subject = engine(keys, chunks);
    expect(subject.apply(left).status).toBe('applied');
    expect(subject.apply(right).status).toBe('manual_conflict');
    expect(subject.object('grant-1')).toEqual({ enabled: true });
  });
});
