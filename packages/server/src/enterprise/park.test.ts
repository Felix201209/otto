/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Park unit tests - invite codes, service specialists, repair routing.
 * 数据安全：独立临时 OTTO_ENTERPRISE_DIR + resetModules，绝不碰真实企业库。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type ParkModule = typeof import('./park.js');

let tmpDir: string;
const prevEnv: Record<string, string | undefined> = {};

async function freshPark(): Promise<ParkModule> {
  process.env.OTTO_ENTERPRISE_DIR = tmpDir;
  vi.resetModules();
  return import('./park.js');
}

beforeEach(() => {
  prevEnv.OTTO_ENTERPRISE_DIR = process.env.OTTO_ENTERPRISE_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-park-'));
});

afterEach(() => {
  if (prevEnv.OTTO_ENTERPRISE_DIR === undefined) delete process.env.OTTO_ENTERPRISE_DIR;
  else process.env.OTTO_ENTERPRISE_DIR = prevEnv.OTTO_ENTERPRISE_DIR;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('Park CRUD', () => {
  it('creates and retrieves a park', async () => {
    const park = await freshPark();
    const created = park.createPark({ name: '中关村科技园', address: '北京市海淀区' });
    expect(created.id).toMatch(/^park_/);
    expect(created.name).toBe('中关村科技园');
    expect(created.address).toBe('北京市海淀区');
    expect(created.adminUserIds).toEqual([]);
    expect(created.createdAt).toBeTruthy();

    const fetched = park.getPark(created.id);
    expect(fetched).toEqual(created);
  });

  it('creates park with admin user IDs', async () => {
    const park = await freshPark();
    const created = park.createPark({
      name: '深圳软件园',
      adminUserIds: ['admin-1', 'admin-2'],
    });
    expect(created.adminUserIds).toEqual(['admin-1', 'admin-2']);
  });

  it('lists all parks', async () => {
    const park = await freshPark();
    park.createPark({ name: '园区A' });
    park.createPark({ name: '园区B' });
    const list = park.listParks();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.name).sort()).toEqual(['园区A', '园区B']);
  });

  it('returns null for non-existent park', async () => {
    const park = await freshPark();
    expect(park.getPark('nonexistent')).toBeNull();
  });

  it('rejects empty park name', async () => {
    const park = await freshPark();
    expect(() => park.createPark({ name: '' })).toThrow();
    expect(() => park.createPark({ name: '   ' })).toThrow();
  });
});

describe('Park Invite Codes', () => {
  it('creates and validates invite code, enterprise joins via code', async () => {
    const park = await freshPark();
    const p = park.createPark({ name: '测试园区' });

    const invite = park.createInviteCode({
      parkId: p.id,
      createdBy: 'admin-1',
    });
    expect(invite.code).toHaveLength(8);
    expect(invite.parkId).toBe(p.id);
    expect(invite.active).toBe(true);
    expect(invite.usedCount).toBe(0);
    expect(invite.maxUses).toBe(100);

    const validation = park.validateInviteCode(invite.code);
    expect(validation.valid).toBe(true);
    expect(validation.parkId).toBe(p.id);

    const result = park.useInviteCode(invite.code, 'enterprise-42');
    expect(result.success).toBe(true);
    expect(result.parkId).toBe(p.id);

    // Can't join again
    const doubleJoin = park.useInviteCode(invite.code, 'enterprise-42');
    expect(doubleJoin.success).toBe(false);
    expect(doubleJoin.error).toContain('已是');
  });

  it('invite code with limited uses is exhausted', async () => {
    const park = await freshPark();
    const p = park.createPark({ name: '限额园区' });

    const invite = park.createInviteCode({
      parkId: p.id,
      createdBy: 'admin-1',
      maxUses: 2,
    });

    expect(park.useInviteCode(invite.code, 'ent-1').success).toBe(true);
    expect(park.useInviteCode(invite.code, 'ent-2').success).toBe(true);
    const exhausted = park.useInviteCode(invite.code, 'ent-3');
    expect(exhausted.success).toBe(false);
    expect(exhausted.error).toContain('上限');
  });

  it('expired invite code is rejected', async () => {
    const park = await freshPark();
    const p = park.createPark({ name: '过期园区' });

    const past = new Date(Date.now() - 60_000).toISOString();
    const invite = park.createInviteCode({
      parkId: p.id,
      createdBy: 'admin-1',
      expiresAt: past,
    });

    const validation = park.validateInviteCode(invite.code);
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain('过期');

    const result = park.useInviteCode(invite.code, 'ent-1');
    expect(result.success).toBe(false);
  });

  it('non-existent invite code is invalid', async () => {
    const park = await freshPark();
    const validation = park.validateInviteCode('XXXXXXXX');
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain('不存在');
  });
});

describe('Service Specialists', () => {
  it('assigns, lists, and removes specialists', async () => {
    const park = await freshPark();
    const p = park.createPark({ name: '服务园区' });

    const s1 = park.assignSpecialist({
      parkId: p.id,
      userId: 'user-1',
      serviceTypes: ['维修', '保洁'],
    });
    expect(s1.serviceTypes.sort()).toEqual(['保洁', '维修']);

    const s2 = park.assignSpecialist({
      parkId: p.id,
      userId: 'user-2',
      serviceTypes: ['安保'],
    });
    const list = park.getSpecialists(p.id);
    expect(list).toHaveLength(2);
    expect(list).toContainEqual(expect.objectContaining({
      userId: s2.userId,
      serviceTypes: ['安保'],
    }));

    expect(park.removeSpecialist(p.id, 'user-1')).toBe(true);
    expect(park.getSpecialists(p.id)).toHaveLength(1);

    // Removing non-existent returns false
    expect(park.removeSpecialist(p.id, 'nonexistent')).toBe(false);
  });

  it('re-assign updates existing specialist service types', async () => {
    const park = await freshPark();
    const p = park.createPark({ name: '更新园区' });

    park.assignSpecialist({ parkId: p.id, userId: 'user-1', serviceTypes: ['维修'] });
    park.assignSpecialist({ parkId: p.id, userId: 'user-1', serviceTypes: ['保洁', '绿化'] });

    const list = park.getSpecialists(p.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.serviceTypes.sort()).toEqual(['保洁', '绿化']);
  });

  it('rejects empty service types', async () => {
    const park = await freshPark();
    const p = park.createPark({ name: '空类型园区' });
    expect(() =>
      park.assignSpecialist({ parkId: p.id, userId: 'user-1', serviceTypes: [] }),
    ).toThrow();
  });
});

describe('Service Request Routing', () => {
  it('routes to matching specialist when available', async () => {
    const park = await freshPark();
    const p = park.createPark({ name: '维修园区' });

    park.assignSpecialist({
      parkId: p.id,
      userId: 'repair-guy',
      serviceTypes: ['维修', '电器'],
    });

    const req = park.createServiceRequest({
      parkId: p.id,
      enterpriseId: 'ent-1',
      type: '维修',
      description: '空调坏了',
    });

    expect(req.status).toBe('pending');
    expect(req.assignedTo).toBeNull();

    const routed = park.routeServiceRequest(req.id);
    expect(routed).not.toBeNull();
    expect(routed!.status).toBe('assigned');
    expect(routed!.assignedTo).toBe('repair-guy');
  });

  it('falls back to park admin when no specialist matches', async () => {
    const park = await freshPark();
    const p = park.createPark({
      name: '无人园区',
      adminUserIds: ['admin-fallback'],
    });

    const req = park.createServiceRequest({
      parkId: p.id,
      enterpriseId: 'ent-1',
      type: '维修',
      description: '灯管闪烁',
    });

    const routed = park.routeServiceRequest(req.id);
    expect(routed).not.toBeNull();
    expect(routed!.status).toBe('assigned');
    expect(routed!.assignedTo).toBe('admin-fallback');
  });

  it('falls back to null when no admin and no specialist', async () => {
    const park = await freshPark();
    const p = park.createPark({ name: '孤立园区' });

    const req = park.createServiceRequest({
      parkId: p.id,
      enterpriseId: 'ent-1',
      type: '维修',
      description: '漏水',
    });

    const routed = park.routeServiceRequest(req.id);
    expect(routed).not.toBeNull();
    expect(routed!.status).toBe('assigned');
    expect(routed!.assignedTo).toBeNull();
  });

  it('resolveServiceRequest marks as resolved', async () => {
    const park = await freshPark();
    const p = park.createPark({ name: '完工园区' });

    const req = park.createServiceRequest({
      parkId: p.id,
      enterpriseId: 'ent-1',
      type: '保洁',
      description: '清理垃圾',
    });

    const resolved = park.resolveServiceRequest(req.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe('resolved');

    // Already resolved requests are idempotent
    const doubleResolved = park.resolveServiceRequest(req.id);
    expect(doubleResolved!.status).toBe('resolved');
  });

  it('getParkServiceRequests filters by status', async () => {
    const park = await freshPark();
    const p = park.createPark({ name: '查询园区' });

    const req1 = park.createServiceRequest({
      parkId: p.id, enterpriseId: 'ent-1', type: '维修', description: '门坏了',
    });
    park.resolveServiceRequest(req1.id);

    const req2 = park.createServiceRequest({
      parkId: p.id, enterpriseId: 'ent-2', type: '保洁', description: '窗户脏',
    });

    const all = park.getParkServiceRequests(p.id);
    expect(all).toHaveLength(2);

    const pending = park.getParkServiceRequests(p.id, 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(req2.id);
    expect(pending[0]!.enterpriseId).toBe('ent-2');

    const resolved = park.getParkServiceRequests(p.id, 'resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.enterpriseId).toBe('ent-1');
  });
});
