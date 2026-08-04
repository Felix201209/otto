/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-12 —— HTTP 网络端点测试。
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Database } from '../data_platform/index.js';
import {
  createControlCommandProcessor,
  handleControlCommandRoute,
  parseEnvelope,
  enqueueOutboxInRepository,
  type ControlCommandQueueStore,
  type ControlCommandOutboxStore,
  type ControlCommandEnvelope,
  type ControlCommandRunResult,
} from './index.js';
import { signEd25519Envelope } from '../commercial_control/signedEnvelope.js';
import { verifyControlCommandSignature } from './controlCommandSignature.js';
import { payloadDigest } from './controlCommandEnvelope.js';
import { queryControlCommandReceipt } from './controlCommandReceiptQuery.js';

const NOW_MS = 1_700_000_000_000;
const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function makeEnvelope(overrides: Partial<ControlCommandEnvelope> = {}): ControlCommandEnvelope {
  const env: ControlCommandEnvelope = {
    commandId: 'cmd-1',
    deploymentId: 'dep-1',
    type: 'enterprise.initiate',
    schemaVersion: 1,
    sequence: 1,
    issuedAt: new Date(NOW_MS - 1000).toISOString(),
    expiresAt: new Date(NOW_MS + 60_000).toISOString(),
    idempotencyKey: 'ik-1',
    payloadDigest: '',
    payload: { name: 'Acme' },
    signature: '',
    ...overrides,
  };
  env.payloadDigest = payloadDigest(env.payload);
  return env;
}

function signEnv(env: ControlCommandEnvelope): ControlCommandEnvelope {
  const signedBody = {
    envelope: {
      commandId: env.commandId,
      deploymentId: env.deploymentId,
      type: env.type,
      schemaVersion: env.schemaVersion,
      sequence: env.sequence,
      issuedAt: env.issuedAt,
      expiresAt: env.expiresAt,
      idempotencyKey: env.idempotencyKey,
      payloadDigest: env.payloadDigest,
      payload: env.payload,
    },
  };
  return { ...env, signature: signEd25519Envelope(signedBody, privateKey) };
}

interface CaptureResp {
  status: number;
  data: unknown;
}

function makeServices(overrides?: {
  db?: Database;
  submit?: (e: ControlCommandEnvelope) => ReturnType<ControlCommandSubmit>;
}) {
  const db = overrides?.db ?? new Database(':memory:');
  const processor = createControlCommandProcessor({
    db: () => db,
    now: () => NOW_MS,
    deploymentId: 'dep-1',
    verifyControlSignature: (e) => verifyControlCommandSignature(e, [publicKey]),
    execute: (c): ControlCommandRunResult => ({
      status: 'succeeded',
      resultSummary: 'ok',
      resourceId: `ent-${c.commandId}`,
    }),
    signingPrivateKey: privateKey,
  });
  const submit = overrides?.submit ?? ((e: ControlCommandEnvelope) => {
    const r = processor.ingest(e);
    if ('error' in r) {
      return r.error === 'invalid_signature'
        ? { kind: 'invalid_signature' as const, keyId: null }
        : { kind: 'rejected' as const, code: r.error };
    }
    return {
      kind: 'accepted' as const,
      commandId: r.receipt.commandId,
      status: r.receipt.status,
      replayed: r.receipt.resultSummary === 'replayed',
    };
  });
  const queryReceipt = (id: string) =>
    queryControlCommandReceipt({ db: () => db, now: () => NOW_MS }, id, privateKey);
  return {
    db,
    processor,
    services: {
      submit,
      drainOnce: () => ({ executed: false }),
      flushOutbox: () => ({ delivered: 0, recovered: 0 }),
      queryReceipt,
      recoverOutbox: () => ({ recovered: 0 }),
      summarize: () => ({ outbox: {}, pendingCommands: 0 }),
    },
  };
}

type ControlCommandSubmit = (e: ControlCommandEnvelope) =>
  | { kind: 'accepted'; commandId: string; status: string; replayed: boolean }
  | { kind: 'invalid_signature'; keyId: string | null }
  | { kind: 'rejected'; code: string; reason?: string };

function makeHarness(services: ReturnType<typeof makeServices>['services']) {
  const captured: CaptureResp[] = [];
  const sendJSON = (_res: ServerResponse, status: number, data: unknown) => {
    captured.push({ status, data });
  };
  let readBodyData: Record<string, unknown> = {};
  return {
    captured,
    sendJSON,
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    setBody: (b: Record<string, unknown>) => { readBodyData = b; },
    readBody: async (_req: IncomingMessage) => readBodyData,
    newUrl: (p: string) => new URL(p, 'http://localhost'),
    call: (fullPath: string, method: string) => {
      const url = new URL(fullPath, 'http://localhost');
      return handleControlCommandRoute({
        path: url.pathname,
        method,
        req: {} as IncomingMessage,
        res: {} as ServerResponse,
        url,
        services,
        readBody: async () => readBodyData,
        sendJSON,
      });
    },
  };
}

describe('control command HTTP endpoint (CONTROL-12)', () => {
  it('POST 合法签名 → 201 accepted', async () => {
    const { services } = makeServices();
    const h = makeHarness(services);
    h.setBody(signEnv(makeEnvelope()) as unknown as Record<string, unknown>);
    await h.call('/control/v1/commands', 'POST');
    expect(h.captured[0].status).toBe(201);
    expect((h.captured[0].data as { status: string }).status).toBe('accepted');
  });

  it('POST 非法签名 → 401 invalid_signature', async () => {
    const { services } = makeServices();
    const h = makeHarness(services);
    h.setBody(makeEnvelope() as unknown as Record<string, unknown>); // 未签名
    await h.call('/control/v1/commands', 'POST');
    expect(h.captured[0].status).toBe(401);
  });

  it('malformed body → 400', async () => {
    const { services } = makeServices();
    const h = makeHarness(services);
    h.setBody({ foo: 'bar' });
    await h.call('/control/v1/commands', 'POST');
    expect(h.captured[0].status).toBe(400);
  });

  it('POST 过期指令 → 422 expired', async () => {
    const { services } = makeServices();
    const h = makeHarness(services);
    const env = signEnv(makeEnvelope({ expiresAt: new Date(NOW_MS - 10).toISOString() }));
    h.setBody(env as unknown as Record<string, unknown>);
    await h.call('/control/v1/commands', 'POST');
    // processor.ingest 对 expired 返回 error('expired')
    expect(h.captured[0].status).toBe(422);
  });

  it('GET receipts 未终态 → 404', async () => {
    const { services } = makeServices();
    const h = makeHarness(services);
    await h.call('/control/v1/receipts?commandId=cmd-1', 'GET');
    expect(h.captured[0].status).toBe(404);
  });

  it('集成：POST → drain → outbox → receipts 200', async () => {
    const db = new Database(':memory:');
    const queue: ControlCommandQueueStore = { db: () => db, now: () => NOW_MS };
    const outbox: ControlCommandOutboxStore = { db: () => db };
    const { processor } = makeServices({ db });
    const services = {
      submit: (e: ControlCommandEnvelope) => {
        const r = processor.ingest(e);
        if ('error' in r) return { kind: 'rejected' as const, code: r.error };
        // 领取执行并写 outbox
        processor.drainOne();
        enqueueOutboxInRepository({ db: () => db }, e.commandId, NOW_MS);
        return { kind: 'accepted' as const, commandId: e.commandId, status: r.receipt.status, replayed: false };
      },
      drainOnce: () => ({ executed: false }),
      flushOutbox: () => ({ delivered: 0, recovered: 0 }),
      queryReceipt: (id: string) =>
        queryControlCommandReceipt({ db: () => db, now: () => NOW_MS }, id, privateKey),
      recoverOutbox: () => ({ recovered: 0 }),
      summarize: () => ({ outbox: {}, pendingCommands: 0 }),
    } satisfies Parameters<typeof handleControlCommandRoute>[0]['services'];

    const h = makeHarness(services);
    h.setBody(signEnv(makeEnvelope()) as unknown as Record<string, unknown>);
    await h.call('/control/v1/commands', 'POST');
    expect(h.captured[0].status).toBe(201);

    await h.call('/control/v1/receipts?commandId=cmd-1', 'GET');
    expect(h.captured[1].status).toBe(200);
    expect((h.captured[1].data as { status: string }).status).toBe('succeeded');
  });

  it('未知 path → 返回 false（未处理）', async () => {
    const { services } = makeServices();
    const h = makeHarness(services);
    const handled = await h.call('/nope', 'GET');
    expect(handled).toBe(false);
    expect(h.captured).toHaveLength(0);
  });

  it('parseEnvelope 缺字段 → null', () => {
    expect(parseEnvelope({ commandId: 'x' })).toBeNull();
    expect(parseEnvelope(null as unknown as Record<string, unknown>)).toBeNull();
    expect(parseEnvelope(makeEnvelope() as unknown as Record<string, unknown>)).not.toBeNull();
  });
});
