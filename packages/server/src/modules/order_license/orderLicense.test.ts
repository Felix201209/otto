/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-11 —— 订单驱动 License 签发测试。
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { Database } from '../data_platform/index.js';
import {
  createOrderLicenseProcessor,
  applyOrderEvent,
  deriveEntitlement,
  issueSignedLicense,
  deterministicLicenseId,
  buildLicensePayload,
  licensePayloadDigest,
  type OrderProjection,
  type OrderEvent,
} from './index.js';
import { verifyEd25519Envelope } from '../commercial_control/signedEnvelope.js';

const NOW_MS = 1_700_000_000_000;
const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function makeEvent(overrides: Partial<OrderEvent> = {}): OrderEvent {
  return {
    eventId: 'evt-1',
    orderId: 'ord-1',
    version: 1,
    type: 'payment',
    customer: { id: 'cus-1', name: 'Acme' },
    deploymentId: 'dep-1',
    plan: 'pro',
    product: 'otto-enterprise-pro',
    region: 'cn-hangzhou',
    amountCents: 990000,
    currency: 'CNY',
    seatLimit: 50,
    modules: ['knowledge', 'park', 'billing'],
    effectiveAtMs: NOW_MS - 1000,
    expiresAtMs: NOW_MS + 365 * 24 * 60 * 60 * 1000,
    orderState: 'paid',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<Parameters<typeof createOrderLicenseProcessor>[0]> = {}) {
  const db = new Database(':memory:');
  return createOrderLicenseProcessor({
    db: () => db,
    now: () => NOW_MS,
    signingPrivateKey: privateKey,
    signingKeyId: 'ctl-sign-2026',
    ...overrides,
  });
}

describe('order state machine (CONTROL-11)', () => {
  it('合法支付事件 → entitlement_active，licenseId 确定性', () => {
    const projection: OrderProjection = { records: new Map(), processedEventIds: new Set() };
    const result = applyOrderEvent(projection, makeEvent(), (f) =>
      deterministicLicenseId(f));
    expect(result.status).toBe('accepted');
    expect(result.eventStatus).toBe('entitlement_active');
    expect(result.entitlement?.plan).toBe('pro');
    expect(result.entitlement?.licenseId).toMatch(/^lic_/);
    // 确定性
    const again = deterministicLicenseId({ deploymentId: 'dep-1', orderId: 'ord-1', plan: 'pro' });
    expect(result.entitlement?.licenseId).toBe(again);
  });

  it('同 eventId 幂等 → idempotent_replayed', () => {
    const projection: OrderProjection = { records: new Map(), processedEventIds: new Set() };
    applyOrderEvent(projection, makeEvent(), (f) => deterministicLicenseId(f));
    const second = applyOrderEvent(projection, makeEvent(), (f) => deterministicLicenseId(f));
    expect(second.status).toBe('idempotent_replayed');
  });

  it('乱序（version 回退）→ rejected_out_of_order', () => {
    const projection: OrderProjection = { records: new Map(), processedEventIds: new Set() };
    applyOrderEvent(projection, makeEvent({ version: 2 }), (f) => deterministicLicenseId(f));
    const bad = applyOrderEvent(projection, makeEvent({ eventId: 'evt-2', version: 1 }),
      (f) => deterministicLicenseId(f));
    expect(bad.status).toBe('rejected_out_of_order');
  });

  it('篡改客户/部署 → rejected_tampered', () => {
    const projection: OrderProjection = { records: new Map(), processedEventIds: new Set() };
    applyOrderEvent(projection, makeEvent(), (f) => deterministicLicenseId(f));
    const tampered = applyOrderEvent(
      projection,
      makeEvent({ eventId: 'evt-2', version: 2, customer: { id: 'cus-2', name: 'Evil' } }),
      (f) => deterministicLicenseId(f),
    );
    expect(tampered.status).toBe('rejected_tampered');
  });

  it('降配（减席位）无整改窗口 → rejected_tampered', () => {
    const projection: OrderProjection = { records: new Map(), processedEventIds: new Set() };
    applyOrderEvent(projection, makeEvent(), (f) => deterministicLicenseId(f));
    const downgrade = applyOrderEvent(
      projection,
      makeEvent({ eventId: 'evt-2', version: 2, type: 'seat_change', seatLimit: 10 }),
      (f) => deterministicLicenseId(f),
    );
    expect(downgrade.status).toBe('rejected_tampered');
  });

  it('升配（加席位）→ accepted', () => {
    const projection: OrderProjection = { records: new Map(), processedEventIds: new Set() };
    applyOrderEvent(projection, makeEvent(), (f) => deterministicLicenseId(f));
    const upgrade = applyOrderEvent(
      projection,
      makeEvent({ eventId: 'evt-2', version: 2, type: 'seat_change', seatLimit: 100 }),
      (f) => deterministicLicenseId(f),
    );
    expect(upgrade.status).toBe('accepted');
  });
});

describe('license issuance (CONTROL-11)', () => {
  it('签发负载不含任何秘密字段', () => {
    const entitlement = deriveEntitlement(makeEvent(), undefined, 'lic_x', 1);
    const payload = buildLicensePayload(entitlement, 1);
    const serialized = JSON.stringify(payload);
    for (const secret of ['password', 'token', 'accessKey', 'secretKey', 'privateKey', 'e2ee']) {
      expect(serialized.toLowerCase()).not.toContain(secret);
    }
  });

  it('签发签名可用信任根公钥验证', () => {
    const entitlement = deriveEntitlement(makeEvent(), undefined, 'lic_x', 1);
    const issued = issueSignedLicense({
      entitlement,
      signingPrivateKey: privateKey,
      signingKeyId: 'ctl-sign-2026',
      rollbackSequence: 1,
    });
    const verify = verifyEd25519Envelope(issued.license, issued.signature, [publicKey]);
    expect(verify.valid).toBe(true);
  });

  it('digest 稳定且无秘密', () => {
    const entitlement = deriveEntitlement(makeEvent(), undefined, 'lic_x', 1);
    const p1 = buildLicensePayload(entitlement, 1);
    const p2 = buildLicensePayload(entitlement, 1);
    expect(licensePayloadDigest(p1)).toBe(licensePayloadDigest(p2));
  });
});

describe('order license processor (CONTROL-11)', () => {
  it('端到端：ingest → license_issued，含签名，可验签', () => {
    const p = makeDeps();
    const r = p.ingest(makeEvent());
    expect(r.kind).toBe('license_issued');
    expect(r.issued).toBeTruthy();
    const verify = verifyEd25519Envelope(r.issued!.license, r.issued!.signature, [publicKey]);
    expect(verify.valid).toBe(true);
    expect(r.issued!.signingKeyId).toBe('ctl-sign-2026');
  });

  it('同 eventId 重复 ingest → 幂等返回既有 license', () => {
    const p = makeDeps();
    const first = p.ingest(makeEvent());
    const second = p.ingest(makeEvent());
    expect(second.kind).toBe('license_issued'); // 因持久化后重放既有
    expect(second.licenseId).toBe(first.licenseId);
  });

  it('乱序事件 → rejected_out_of_order（持久化层单调）', () => {
    const p = makeDeps();
    p.ingest(makeEvent({ version: 2 }));
    const bad = p.ingest(makeEvent({ eventId: 'evt-2', version: 1 }));
    expect(bad.kind).toBe('rejected_out_of_order');
  });

  it('latestEntitlement 响应丢失恢复', () => {
    const p = makeDeps();
    p.ingest(makeEvent());
    const ent = p.latestEntitlement('ord-1');
    expect(ent).not.toBeNull();
    expect(ent!.license_id).toBeTruthy();
    expect(ent!.deployment_id).toBe('dep-1');
  });
});
