/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * [MESH-05] HTTP 路由测试：验证 handleMeshRoute 在真实端点形状下工作。
 * 使用内存 Database + 真实 composition 作为 services，覆盖：
 *  - GET /v1/mesh/status（隐私不变量）
 *  - POST/GET /v1/mesh/rendezvous（发布/查询）
 *  - POST /v1/mesh/sessions + data 投递/拉取 + p2p 声明
 */

import { generateKeyPairSync } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { Database } from '../data_platform/index.js';
import { LocalMeshSigner } from './meshCrypto.js';
import { createMeshRendezvousComposition } from './meshComposition.js';
import { MESH_RENDEZVOUS_SCHEMA_CONTRIBUTOR } from './meshSchema.js';
import { handleMeshRoute } from './meshRoutes.js';

const FIXED_NOW = Date.parse('2026-08-07T00:00:00.000Z');

interface FakeRes extends ServerResponse {
  statusCode: number;
  capturedStatus: number;
  capturedBody: unknown;
}

function fakeRes(): FakeRes {
  const res = {
    statusCode: 200,
    capturedStatus: 0,
    capturedBody: undefined as unknown,
    writeHead(status: number) {
      this.capturedStatus = status;
      return this;
    },
    end(payload?: string) {
      this.capturedBody = payload ? JSON.parse(payload) : null;
      return this;
    },
  };
  return res as unknown as FakeRes;
}

function fakeReq(source = '203.0.113.5'): IncomingMessage {
  return {
    headers: {},
    socket: { remoteAddress: source },
  } as unknown as IncomingMessage;
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function makeReadBody(body: unknown) {
  return async (_req: IncomingMessage): Promise<Record<string, unknown>> =>
    (body ?? {}) as Record<string, unknown>;
}

describe('mesh rendezvous HTTP routes', () => {
  const databases: Database[] = [];
  afterEach(() => {
    databases.splice(0).forEach((db) => db.close());
  });

  function setup() {
    const db = new Database(':memory:');
    MESH_RENDEZVOUS_SCHEMA_CONTRIBUTOR.apply(db);
    databases.push(db);
    const services = createMeshRendezvousComposition({
      db: () => db,
      now: () => FIXED_NOW,
    });
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = new LocalMeshSigner(
      privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    );
    return { services, signer };
  }

  async function signedRendezvous(nodeId: string, signer: LocalMeshSigner) {
    const record = {
      version: 1 as const,
      nodeId,
      issuedAt: new Date(FIXED_NOW).toISOString(),
      expiresAt: new Date(FIXED_NOW + 60 * 60_000).toISOString(),
      candidates: [
        { type: 'lan' as const, address: 'stun://192.168.1.10:3478', priority: 10 },
      ],
    };
    return {
      record,
      signingKeyId: signer.keyId,
      signature: await signer.sign(record),
    };
  }

  it('serves status with privacy invariants', async () => {
    const { services } = setup();
    const res = fakeRes();
    const handled = await handleMeshRoute({
      path: '/v1/mesh/status',
      method: 'GET',
      url: new URL('http://127.0.0.1/v1/mesh/status'),
      req: fakeReq(),
      res,
      services,
      readBody: makeReadBody({}),
      sendJSON,
    });
    expect(handled).toBe(true);
    expect(res.capturedStatus).toBe(200);
    const body = res.capturedBody as {
      privacy: { payloadStorage: string; plaintextNeverStored: boolean };
    };
    expect(body.privacy).toEqual({
      payloadStorage: 'ciphertext-only-in-memory',
      plaintextNeverStored: true,
    });
  });

  it('publishes and looks up a rendezvous record over HTTP', async () => {
    const { services, signer } = setup();
    const signed = await signedRendezvous('node_alice', signer);

    const pubRes = fakeRes();
    const published = await handleMeshRoute({
      path: '/v1/mesh/rendezvous',
      method: 'POST',
      url: new URL('http://127.0.0.1/v1/mesh/rendezvous'),
      req: fakeReq(),
      res: pubRes,
      services,
      readBody: makeReadBody({ signed }),
      sendJSON,
    });
    expect(published).toBe(true);
    expect(pubRes.capturedStatus).toBe(201);
    expect((pubRes.capturedBody as { nodeId: string }).nodeId).toBe('node_alice');

    const getRes = fakeRes();
    const lookedUp = await handleMeshRoute({
      path: '/v1/mesh/rendezvous/node_alice',
      method: 'GET',
      url: new URL('http://127.0.0.1/v1/mesh/rendezvous/node_alice'),
      req: fakeReq(),
      res: getRes,
      services,
      readBody: makeReadBody({}),
      sendJSON,
    });
    expect(lookedUp).toBe(true);
    expect(getRes.capturedStatus).toBe(200);
    expect(
      (getRes.capturedBody as { record: { record: { nodeId: string } } }).record.record
        .nodeId,
    ).toBe('node_alice');
  });

  it('round-trips a relay session over HTTP and declares P2P', async () => {
    const { services } = setup();

    const sessionRes = fakeRes();
    const created = await handleMeshRoute({
      path: '/v1/mesh/sessions',
      method: 'POST',
      url: new URL('http://127.0.0.1/v1/mesh/sessions'),
      req: fakeReq(),
      res: sessionRes,
      services,
      readBody: makeReadBody({
        nodeA: 'node_alice',
        nodeB: 'node_bob',
        maxBytes: 1024 * 1024,
      }),
      sendJSON,
    });
    expect(created).toBe(true);
    expect(sessionRes.capturedStatus).toBe(201);
    const session = sessionRes.capturedBody as { sessionId: string };
    expect(session.sessionId).toMatch(/^mns_/u);

    const putRes = fakeRes();
    const put = await handleMeshRoute({
      path: `/v1/mesh/sessions/${session.sessionId}/data`,
      method: 'POST',
      url: new URL(`http://127.0.0.1/v1/mesh/sessions/${session.sessionId}/data`),
      req: fakeReq(),
      res: putRes,
      services,
      readBody: makeReadBody({ node: 'node_alice', ciphertext: 'ZW5jcnlwdGVkLWNoaW5r' }),
      sendJSON,
    });
    expect(put).toBe(true);
    expect(putRes.capturedStatus).toBe(201);

    const takeRes = fakeRes();
    const take = await handleMeshRoute({
      path: `/v1/mesh/sessions/${session.sessionId}/data`,
      method: 'GET',
      url: new URL(
        `http://127.0.0.1/v1/mesh/sessions/${session.sessionId}/data?node=node_bob`,
      ),
      req: fakeReq(),
      res: takeRes,
      services,
      readBody: makeReadBody({}),
      sendJSON,
    });
    expect(take).toBe(true);
    expect(takeRes.capturedStatus).toBe(200);
    expect(
      (takeRes.capturedBody as { chunks: Array<{ from: string }> }).chunks[0]!.from,
    ).toBe('node_alice');

    const p2pRes = fakeRes();
    const p2p = await handleMeshRoute({
      path: `/v1/mesh/sessions/${session.sessionId}/p2p`,
      method: 'POST',
      url: new URL(`http://127.0.0.1/v1/mesh/sessions/${session.sessionId}/p2p`),
      req: fakeReq(),
      res: p2pRes,
      services,
      readBody: makeReadBody({ node: 'node_bob' }),
      sendJSON,
    });
    expect(p2p).toBe(true);
    expect(p2pRes.capturedStatus).toBe(200);
    expect(
      (p2pRes.capturedBody as { receipt: { pathType: string } }).receipt.pathType,
    ).toBe('p2p');
  });

  it('rejects invalid node ids and unknown sessions', async () => {
    const { services } = setup();

    const badNodeRes = fakeRes();
    await handleMeshRoute({
      path: '/v1/mesh/sessions',
      method: 'POST',
      url: new URL('http://127.0.0.1/v1/mesh/sessions'),
      req: fakeReq(),
      res: badNodeRes,
      services,
      readBody: makeReadBody({ nodeA: 'bad node!', nodeB: 'node_bob' }),
      sendJSON,
    });
    expect(badNodeRes.capturedStatus).toBe(400);

    const unknownRes = fakeRes();
    await handleMeshRoute({
      path: '/v1/mesh/sessions/mns_0000000000000000000000/data',
      method: 'POST',
      url: new URL('http://127.0.0.1/v1/mesh/sessions/mns_0000000000000000000000/data'),
      req: fakeReq(),
      res: unknownRes,
      services,
      readBody: makeReadBody({ node: 'node_alice', ciphertext: 'c2VjcmV0' }),
      sendJSON,
    });
    expect(unknownRes.capturedStatus).toBe(400);
  });
});
