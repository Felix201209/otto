/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-12 —— 边界模块测试（信任根配置、fail closed、submit、handleRoute）。
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { Database } from '../data_platform/index.js';
import {
  createControlCommandBoundary,
  controlPublicKeysFromEnv,
  type ControlCommandBoundaryDeps,
} from './index.js';
import { signEd25519Envelope } from '../commercial_control/signedEnvelope.js';
import { payloadDigest, type ControlCommandEnvelope } from './controlCommandEnvelope.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

const NOW_MS = 1_700_000_000_000;
const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function makeDeps(overrides: Partial<ControlCommandBoundaryDeps> = {}): ControlCommandBoundaryDeps {
  const db = new Database(':memory:');
  return {
    db: () => db,
    deploymentId: 'dep-1',
    now: () => NOW_MS,
    controlPublicKeys: [publicKey],
    signingPrivateKey: privateKey,
    execute: () => ({ status: 'succeeded' as const, resultSummary: 'ok' }),
    ...overrides,
  };
}

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
  return {
    ...env,
    signature: signEd25519Envelope(
      {
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
      },
      privateKey,
    ),
  };
}

describe('control command boundary (CONTROL-12)', () => {
  it('未配置信任根 → fail closed（enabled=false，submit rejected）', () => {
    const b = createControlCommandBoundary(makeDeps({ controlPublicKeys: [] }));
    expect(b.enabled).toBe(false);
    expect(b.submit(signEnv(makeEnvelope())).kind).toBe('rejected');
    expect(b.services.drainOnce().executed).toBe(false);
  });

  it('配置信任根 → enabled，submit 合法签名 accepted', () => {
    const b = createControlCommandBoundary(makeDeps());
    expect(b.enabled).toBe(true);
    expect(b.publicKeyIds).toHaveLength(1);
    const r = b.submit(signEnv(makeEnvelope()));
    expect(r.kind).toBe('accepted');
  });

  it('同 commandId 的签名内容变化时返回 command_id_conflict', () => {
    const b = createControlCommandBoundary(makeDeps());
    expect(b.submit(signEnv(makeEnvelope())).kind).toBe('accepted');

    const conflict = b.submit(
      signEnv(makeEnvelope({ payload: { name: 'Changed' } })),
    );
    expect(conflict).toEqual({
      kind: 'rejected',
      code: 'command_id_conflict',
    });
  });

  it('非法签名 → invalid_signature', () => {
    const b = createControlCommandBoundary(makeDeps());
    const r = b.submit(makeEnvelope()); // 未签名
    expect(r.kind).toBe('invalid_signature');
  });

  it('部署不匹配 → rejected（部署绑定 fail closed）', () => {
    const b = createControlCommandBoundary(makeDeps());
    const env = signEnv(makeEnvelope({ deploymentId: 'other-dep' }));
    const r = b.submit(env);
    expect(r.kind).toBe('rejected');
  });

  it('handleRoute POST 合法 → 201；未配置 → false', async () => {
    // enabled 分支
    const b = createControlCommandBoundary(makeDeps());
    const captured: Array<{ status: number; data: unknown }> = [];
    const sendJSON = (_res: ServerResponse, status: number, data: unknown) => {
      captured.push({ status, data });
    };
    const handled = await b.handleRoute({
      path: '/control/v1/commands',
      method: 'POST',
      url: new URL('http://localhost/control/v1/commands'),
      req: {} as IncomingMessage,
      res: {} as ServerResponse,
      readBody: async () => signEnv(makeEnvelope()) as unknown as Record<string, unknown>,
      sendJSON,
    });
    expect(handled).toBe(true);
    expect(captured[0].status).toBe(201);

    // disabled 分支：一律 false
    const d = createControlCommandBoundary(makeDeps({ controlPublicKeys: [] }));
    const handled2 = await d.handleRoute({
      path: '/control/v1/commands',
      method: 'POST',
      url: new URL('http://localhost/control/v1/commands'),
      req: {} as IncomingMessage,
      res: {} as ServerResponse,
      readBody: async () => ({}),
      sendJSON,
    });
    expect(handled2).toBe(false);
  });

  it('env 解析信任根公钥', () => {
    expect(controlPublicKeysFromEnv({})).toEqual([]);
    expect(controlPublicKeysFromEnv({ OTTO_ENTERPRISE_CONTROL_PUBLIC_KEYS: publicKey }))
      .toHaveLength(1);
  });
});
