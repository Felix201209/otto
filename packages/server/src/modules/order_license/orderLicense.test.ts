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
  controlLicenseClaim,
  type OrderProjection,
  type OrderEvent,
  type ControlLicenseClaimDeps,
} from './index.js';
import { verifyEd25519Envelope } from '../commercial_control/signedEnvelope.js';
import type { DeploymentLicenseView } from '../commercial_control/deploymentTypes.js';

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

  it('USB 签发显式保留待激活的 machineFingerprint', () => {
    const entitlement = deriveEntitlement(makeEvent(), undefined, 'lic_usb', 1);
    const payload = buildLicensePayload(entitlement, 1, undefined, 'nonce-1');
    expect(payload).toMatchObject({ activationNonce: 'nonce-1', machineFingerprint: '' });
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

  it('审核修复：多事件生命周期保留既有上下文（篡改客户被拒）', () => {
    const p = makeDeps();
    p.ingest(makeEvent()); // v1 payment
    // 同 order 第二事件（plan_change v2）篡改客户 → 必须 rejected_tampered
    const tampered = p.ingest({
      ...makeEvent({
        eventId: 'evt-2',
        version: 2,
        type: 'plan_change',
        customer: { id: 'cus-9', name: 'Evil' },
      }),
    });
    expect(tampered.kind).toBe('rejected_tampered');
  });

  it('审核修复：多事件生命周期降配（减席位）在编排层被拒', () => {
    const p = makeDeps();
    p.ingest(makeEvent({ seatLimit: 50 })); // v1 50 席位
    const downgrade = p.ingest({
      ...makeEvent({
        eventId: 'evt-2',
        version: 2,
        type: 'seat_change',
        seatLimit: 10,
      }),
    });
    expect(downgrade.kind).toBe('rejected_tampered');
  });

  it('审核修复：同 order 升配（加席位）编排层接受并递增版本', () => {
    const p = makeDeps();
    p.ingest(makeEvent({ seatLimit: 50 }));
    const upgrade = p.ingest({
      ...makeEvent({
        eventId: 'evt-2',
        version: 2,
        type: 'seat_change',
        seatLimit: 100,
      }),
    });
    expect(upgrade.kind).toBe('license_issued');
    expect(upgrade.licenseId).toBeTruthy();
    const ent = p.latestEntitlement('ord-1');
    expect(ent!.seat_limit).toBe(100);
  });
});

describe('control license activation (CONTROL-11)', () => {
  function makeClaimDeps(db: Database, overrides: Partial<ControlLicenseClaimDeps> = {}) {
    return {
      db: () => db,
      deploymentId: 'dep-1',
      machineFingerprint: 'fp-1',
      claimFromControl: async () => ({
        ok: true as const,
        envelope: { license: { id: 'lic_1' }, signature: 'sig', signingKeyId: 'k' },
      }),
      applyAcceptedLicense: (envelope: unknown) => ({
        id: (envelope as { license: { id: string } }).license.id,
        deploymentId: 'dep-1',
      } as DeploymentLicenseView),
      ...overrides,
    } as ControlLicenseClaimDeps;
  }

  it('无既有 License → activated', async () => {
    const db = new Database(':memory:');
    const r = await controlLicenseClaim(makeClaimDeps(db));
    expect(r.kind).toBe('activated');
    expect(r.license?.id).toBe('lic_1');
  });

  it('已有 License → already_active（不重复消耗订单）', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE deployment_license (id TEXT, updated_at TEXT);
             INSERT INTO deployment_license VALUES ('lic_exist', '2026-01-01');`);
    let claims = 0;
    const r = await controlLicenseClaim(
      makeClaimDeps(db, {
        claimFromControl: async () => {
          claims += 1;
          return { ok: true as const, envelope: {} };
        },
      }),
    );
    expect(r.kind).toBe('already_active');
    expect(claims).toBe(0); // 未向 Control 发起领取
  });

  it('Control 断网 → claim_failed', async () => {
    const db = new Database(':memory:');
    const r = await controlLicenseClaim(
      makeClaimDeps(db, {
        claimFromControl: async () => ({ ok: false as const, error: 'network down' }),
      }),
    );
    expect(r.kind).toBe('claim_failed');
  });

  it('激活校验失败（篡改/签名无效）→ invalid_license', async () => {
    const db = new Database(':memory:');
    const r = await controlLicenseClaim(
      makeClaimDeps(db, {
        applyAcceptedLicense: () => {
          throw new Error('license signature invalid');
        },
      }),
    );
    expect(r.kind).toBe('invalid_license');
    expect(r.reason).toContain('signature invalid');
  });
});
