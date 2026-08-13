/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * [MESH-05] 单元测试：rendezvous 发布/查询、relay 会话生命周期、TTL/背压/配额/DDoS、P2P 路径收据。
 */

import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { Database } from '../data_platform/index.js';
import { LocalMeshSigner } from './meshCrypto.js';
import { createMeshRendezvousComposition } from './meshComposition.js';
import { MESH_RENDEZVOUS_SCHEMA_CONTRIBUTOR } from './meshSchema.js';

const FIXED_NOW = Date.parse('2026-08-07T00:00:00.000Z');

function database(): Database {
  const db = new Database(':memory:');
  MESH_RENDEZVOUS_SCHEMA_CONTRIBUTOR.apply(db);
  return db;
}

function signer(): LocalMeshSigner {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new LocalMeshSigner(
    privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  );
}

async function signedRendezvousRecord(
  nodeId: string,
  s: LocalMeshSigner,
  now: number = FIXED_NOW,
) {
  const record = {
    version: 1 as const,
    nodeId,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    candidates: [
      { type: 'lan' as const, address: 'stun://192.168.1.10:3478', priority: 10 },
      { type: 'server_reflexive' as const, address: 'stun://8.8.8.8:3478', priority: 20 },
    ],
  };
  return {
    record,
    signingKeyId: s.keyId,
    signature: await s.sign(record),
  };
}

describe('mesh rendezvous composition', () => {
  const databases: Database[] = [];
  afterEach(() => {
    databases.splice(0).forEach((db) => db.close());
  });

  function service(opts: { maxConnectionsPerScope?: number } = {}) {
    const db = database();
    databases.push(db);
    return createMeshRendezvousComposition({
      db: () => db,
      now: () => FIXED_NOW,
      runtimeOptions: {
        quotaWindowMs: 60_000,
        maxConnectionsPerScope: opts.maxConnectionsPerScope ?? 256,
        throttleThreshold: 5,
        blockThreshold: 10,
      },
    });
  }

  it('publishes and looks up a signed rendezvous record', async () => {
    const s = service();
    const nodeSigner = signer();
    const signed = await signedRendezvousRecord('node_alice', nodeSigner);
    const published = s.publishRendezvous({ signed, source: '203.0.113.5' });
    expect(published.nodeId).toBe('node_alice');
    expect(published.expiresAt).toBe(signed.record.expiresAt);

    const lookedUp = s.lookupRendezvous('node_alice');
    expect(lookedUp?.record.nodeId).toBe('node_alice');
    expect(lookedUp?.record.candidates).toHaveLength(2);
    expect(s.listRendezvous()).toHaveLength(1);
    expect(s.lookupRendezvous('node_missing')).toBeNull();
  });

  it('creates a relay session, forwards ciphertext chunks, and pulls them once', async () => {
    const s = service();
    const session = await s.createRelaySession({
      nodeA: 'node_alice',
      nodeB: 'node_bob',
      tenantA: null,
      tenantB: null,
      requester: 'node_alice',
      source: '203.0.113.5',
      maxBytes: 1024 * 1024,
    });
    expect(session.sessionId).toMatch(/^mns_/u);
    expect(session.ticket).toMatchObject({
      version: 1,
      requesterNodeId: 'node_alice',
      peerNodeId: 'node_bob',
      signingKeyId: expect.any(String),
    });

    const put = s.putRelayChunk({
      sessionId: session.sessionId,
      from: 'node_alice',
      ciphertext: 'ZW5jcnlwdGVkLWNoaW5rLTE',
      source: '203.0.113.5',
    });
    expect(put.chunkId).toMatch(/^mch_/u);

    const pulledByBob = s.takeRelayChunks({
      sessionId: session.sessionId,
      node: 'node_bob',
      source: '198.51.100.9',
    });
    expect(pulledByBob.chunks).toHaveLength(1);
    expect((pulledByBob.chunks[0] as { from: string }).from).toBe('node_alice');
    expect((pulledByBob.chunks[0] as { ciphertext: string }).ciphertext).toBe(
      'ZW5jcnlwdGVkLWNoaW5rLTE',
    );

    // 游标单调：再次拉取不再重复返回。
    const again = s.takeRelayChunks({
      sessionId: session.sessionId,
      node: 'node_bob',
      source: '198.51.100.9',
    });
    expect(again.chunks).toHaveLength(0);
  });

  it('destroys relay state and records a p2p path receipt after P2P success', async () => {
    const s = service();
    const session = await s.createRelaySession({
      nodeA: 'node_alice',
      nodeB: 'node_bob',
      tenantA: 'tenant_x',
      tenantB: null,
      requester: 'node_alice',
      source: '203.0.113.5',
      maxBytes: 1024 * 1024,
    });
    s.putRelayChunk({
      sessionId: session.sessionId,
      from: 'node_alice',
      ciphertext: 'ZW5jcnlwdGVk',
      source: '203.0.113.5',
    });
    const receipt = s.declareP2P({
      sessionId: session.sessionId,
      node: 'node_bob',
      source: '198.51.100.9',
    });
    expect(receipt?.receipt.pathType).toBe('p2p');
    expect(receipt?.receipt.bytesForwarded).toBeGreaterThan(0);
    expect(receipt?.receipt.sessionId).toBe(session.sessionId);

    // 会话已销毁：再次访问应失败。
    expect(() =>
      s.takeRelayChunks({
        sessionId: session.sessionId,
        node: 'node_bob',
        source: '198.51.100.9',
      }),
    ).toThrow();
    // 重复声明返回 null。
    expect(
      s.declareP2P({ sessionId: session.sessionId, node: 'node_bob', source: '198.51.100.9' }),
    ).toBeNull();
  });

  it('rejects chunk forwarding from a node that is not part of the session', async () => {
    const s = service();
    const session = await s.createRelaySession({
      nodeA: 'node_alice',
      nodeB: 'node_bob',
      tenantA: null,
      tenantB: null,
      requester: 'node_alice',
      source: '203.0.113.5',
      maxBytes: 1024 * 1024,
    });
    expect(() =>
      s.putRelayChunk({
        sessionId: session.sessionId,
        from: 'node_mallory',
        ciphertext: 'ZW5jcnlwdGVkLWludHJ1ZGVy',
        source: '198.51.100.66',
      }),
    ).toThrow('invalid or expired');
  });

  it('enforces connection quota per scope', async () => {
    const s = service({ maxConnectionsPerScope: 1 });
    const first = await s.createRelaySession({
      nodeA: 'node_a1',
      nodeB: 'node_a2',
      tenantA: 'tenant_x',
      tenantB: null,
      requester: 'node_a1',
      source: '203.0.113.5',
      maxBytes: 1024 * 1024,
    });
    expect(first.sessionId).toBeTruthy();
    await expect(
      s.createRelaySession({
        nodeA: 'node_b1',
        nodeB: 'node_b2',
        tenantA: 'tenant_x',
        tenantB: null,
        requester: 'node_b1',
        source: '203.0.113.6',
        maxBytes: 1024 * 1024,
      }),
    ).rejects.toThrow('connection quota exceeded');

    // 关闭后释放槽位。
    s.closeRelaySession({ sessionId: first.sessionId, node: 'node_a1', source: '203.0.113.5' });
    const second = await s.createRelaySession({
      nodeA: 'node_c1',
      nodeB: 'node_c2',
      tenantA: 'tenant_x',
      tenantB: null,
      requester: 'node_c1',
      source: '203.0.113.7',
      maxBytes: 1024 * 1024,
    });
    expect(second.sessionId).toBeTruthy();
  });

  it('blocks sources that exceed the DDoS block threshold', async () => {
    const s = service();
    // 持续触发 request 计数直到 block 阈值。
    for (let i = 0; i < 11; i += 1) {
      s.getRuntime().checkQuota('198.51.100.99', 0);
    }
    const decision = s.getRuntime().ddosDecision('198.51.100.99');
    expect(decision.decision).toBe('block');
    expect(s.status('198.51.100.99')).toMatchObject({
      ddosDecision: { decision: 'block' },
    });
  });

  it('reports status with privacy invariants', async () => {
    const s = service();
    await s.createRelaySession({
      nodeA: 'node_alice',
      nodeB: 'node_bob',
      tenantA: null,
      tenantB: null,
      requester: 'node_alice',
      source: '203.0.113.5',
      maxBytes: 1024 * 1024,
    });
    const status = s.status('203.0.113.5') as {
      privacy: { payloadStorage: string; plaintextNeverStored: boolean };
      activeSessions: number;
      rendezvousCount: number;
    };
    expect(status.privacy).toEqual({
      payloadStorage: 'ciphertext-only-in-memory',
      plaintextNeverStored: true,
    });
    expect(status.activeSessions).toBe(1);
    expect(status.rendezvousCount).toBe(0);
  });
});
