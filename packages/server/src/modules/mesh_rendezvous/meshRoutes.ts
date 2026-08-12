/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * [MESH-05] 根服务器 HTTP 端点（公开）：
 *  - POST /v1/mesh/rendezvous       发布/刷新签名 rendezvous record
 *  - GET  /v1/mesh/rendezvous/:node 查询对端 rendezvous record
 *  - POST /v1/mesh/sessions         申请短时 relay ticket（附带 NAT 会话）
 *  - POST /v1/mesh/sessions/:id/data 投递密文块
 *  - GET  /v1/mesh/sessions/:id/data?node=:node 拉取密文块
 *  - POST /v1/mesh/sessions/:id/p2p 声明 P2P 成功（销毁 relay 状态）
 *  - DELETE /v1/mesh/sessions/:id   关闭会话
 *  - GET  /v1/mesh/status           状态/SLO
 *
 * 根服务器不需要企业登录：它只做发现与短时中继，且不落明文。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  MeshDdosDecision,
  MeshNatSession,
  MeshPathReceipt,
} from './meshContracts.js';
import { validateSignedRendezvousRecord } from './meshCrypto.js';

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SESSION_ID = /^mns_[A-Za-z0-9_-]{16,}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export interface MeshRouteServices {
  publishRendezvous(input: { signed: unknown; source: string }): {
    nodeId: string;
    expiresAt: string;
  };
  lookupRendezvous(nodeId: string): unknown;
  listRendezvous(): unknown;
  createRelaySession(input: {
    nodeA: string;
    nodeB: string;
    tenantA: string | null;
    tenantB: string | null;
    requester: string;
    source: string;
    maxBytes: number;
  }): Promise<{
    sessionId: string;
    ticket: unknown;
    expiresAt: string;
  }>;
  putRelayChunk(input: {
    sessionId: string;
    from: string;
    ciphertext: string;
    source: string;
  }): { chunkId: string };
  takeRelayChunks(input: {
    sessionId: string;
    node: string;
    limit?: number;
    source: string;
  }): { chunks: unknown[] };
  declareP2P(input: {
    sessionId: string;
    node: string;
    source: string;
  }): { receipt: MeshPathReceipt } | null;
  closeRelaySession(input: { sessionId: string; node: string; source: string }): boolean;
  status(source: string): unknown;
}

export interface MeshRouteDeps {
  path: string;
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  services: MeshRouteServices;
  readBody(req: IncomingMessage, maxLength?: number): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

function optionalNodeId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !NODE_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requiredNodeId(value: unknown, label: string): string {
  const id = optionalNodeId(value, label);
  if (!id) throw new Error(`${label} is required`);
  return id;
}

function requiredSessionId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function ciphertext(value: unknown): string {
  if (typeof value !== 'string' || !BASE64URL.test(value) || value.length > 64 * 1024) {
    throw new Error('ciphertext is invalid');
  }
  return value;
}

function boundedBytes(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1024 * 1024 * 1024
    ? parsed
    : fallback;
}

function boundedLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 200 ? parsed : fallback;
}

function clientAddress(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0]!.trim();
  }
  const socket = req.socket;
  return socket?.remoteAddress ?? 'unknown';
}

export async function handleMeshRoute(deps: MeshRouteDeps): Promise<boolean> {
  const { path, method, url, req, res, services, readBody, sendJSON } = deps;
  if (!path.startsWith('/v1/mesh/')) return false;
  const source = clientAddress(req);

  try {
    // GET /v1/mesh/rendezvous
    if (path === '/v1/mesh/rendezvous' && method === 'GET') {
      sendJSON(res, 200, { records: services.listRendezvous() });
      return true;
    }
    // POST /v1/mesh/rendezvous
    if (path === '/v1/mesh/rendezvous' && method === 'POST') {
      const body = await readBody(req, 128 * 1024);
      const result = services.publishRendezvous({ signed: body.signed, source });
      sendJSON(res, 201, result);
      return true;
    }
    // GET /v1/mesh/rendezvous/:node
    if (path.startsWith('/v1/mesh/rendezvous/') && method === 'GET') {
      const nodeId = requiredNodeId(
        decodeURIComponent(path.slice('/v1/mesh/rendezvous/'.length)),
        'node id',
      );
      const record = services.lookupRendezvous(nodeId);
      if (!record) {
        sendJSON(res, 404, { error: 'rendezvous record not found' });
      } else {
        sendJSON(res, 200, { record });
      }
      return true;
    }
    // POST /v1/mesh/sessions
    if (path === '/v1/mesh/sessions' && method === 'POST') {
      const body = await readBody(req, 64 * 1024);
      const nodeA = requiredNodeId(body.nodeA, 'node a');
      const nodeB = requiredNodeId(body.nodeB, 'node b');
      if (nodeA === nodeB) throw new Error('nodes must be distinct');
      const session = await services.createRelaySession({
        nodeA,
        nodeB,
        tenantA: optionalNodeId(body.tenantA, 'tenant a'),
        tenantB: optionalNodeId(body.tenantB, 'tenant b'),
        requester: nodeA,
        source,
        maxBytes: boundedBytes(body.maxBytes, 1024 * 1024),
      });
      sendJSON(res, 201, session);
      return true;
    }
    // POST /v1/mesh/sessions/:id/data
    if (
      path.startsWith('/v1/mesh/sessions/') &&
      path.endsWith('/data') &&
      method === 'POST'
    ) {
      const sessionId = requiredSessionId(
        decodeURIComponent(path.slice('/v1/mesh/sessions/'.length, -'/data'.length)),
        'session id',
      );
      const body = await readBody(req, 80 * 1024);
      const chunkId = services.putRelayChunk({
        sessionId,
        from: requiredNodeId(body.node, 'node'),
        ciphertext: ciphertext(body.ciphertext),
        source,
      });
      sendJSON(res, 201, { chunkId });
      return true;
    }
    // GET /v1/mesh/sessions/:id/data
    if (
      path.startsWith('/v1/mesh/sessions/') &&
      path.endsWith('/data') &&
      method === 'GET'
    ) {
      const sessionId = requiredSessionId(
        decodeURIComponent(path.slice('/v1/mesh/sessions/'.length, -'/data'.length)),
        'session id',
      );
      const node = requiredNodeId(url.searchParams.get('node'), 'node');
      const result = services.takeRelayChunks({
        sessionId,
        node,
        limit: boundedLimit(url.searchParams.get('limit'), 50),
        source,
      });
      sendJSON(res, 200, result);
      return true;
    }
    // POST /v1/mesh/sessions/:id/p2p
    if (
      path.startsWith('/v1/mesh/sessions/') &&
      path.endsWith('/p2p') &&
      method === 'POST'
    ) {
      const sessionId = requiredSessionId(
        decodeURIComponent(path.slice('/v1/mesh/sessions/'.length, -'/p2p'.length)),
        'session id',
      );
      const body = await readBody(req, 16 * 1024);
      const result = services.declareP2P({
        sessionId,
        node: requiredNodeId(body.node, 'node'),
        source,
      });
      if (!result) {
        sendJSON(res, 404, { error: 'relay session not found' });
      } else {
        sendJSON(res, 200, result);
      }
      return true;
    }
    // DELETE /v1/mesh/sessions/:id
    if (path.startsWith('/v1/mesh/sessions/') && method === 'DELETE') {
      const sessionId = requiredSessionId(
        decodeURIComponent(path.slice('/v1/mesh/sessions/'.length)),
        'session id',
      );
      const node = requiredNodeId(url.searchParams.get('node') ?? '', 'node');
      const closed = services.closeRelaySession({ sessionId, node, source });
      sendJSON(res, closed ? 200 : 404, { closed });
      return true;
    }
    // GET /v1/mesh/status
    if (path === '/v1/mesh/status' && method === 'GET') {
      sendJSON(res, 200, services.status(source));
      return true;
    }
  } catch (error) {
    sendJSON(res, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }

  return false;
}

export function meshDdosPayload(decision: MeshDdosDecision | { decision: string; reason: string }): {
  error: string;
  code: string;
} {
  return {
    error: `rate limited: ${decision.reason}`,
    code: decision.decision === 'block' ? 'MESH_BLOCKED' : 'MESH_THROTTLED',
  };
}

export function meshStatusFrom(
  input: {
    now(): number;
    listActiveDdosDecisions(): MeshDdosDecision[];
    listPathReceipts(limit?: number): MeshPathReceipt[];
    listRendezvous(): unknown;
    listSessions(): MeshNatSession[];
  },
): unknown {
  return {
    protocolVersion: 1,
    privacy: { payloadStorage: 'ciphertext-only-in-memory', plaintextNeverStored: true },
    ddosDecisions: input.listActiveDdosDecisions(),
    pathReceipts: input.listPathReceipts(10),
    rendezvousCount: Array.isArray(input.listRendezvous()) ? input.listRendezvous().length : 0,
    activeSessions: input.listSessions().length,
    serverTime: new Date(input.now()).toISOString(),
  };
}
