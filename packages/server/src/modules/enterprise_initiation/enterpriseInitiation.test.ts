/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import {
  ENTERPRISE_INITIATION_SCHEMA_CONTRIBUTOR,
  createEnterpriseInitiationComposition,
  redeemFirstLoginTokenInRepository,
  revokeFirstLoginTokens,
  validateRequestedRoleAssignment,
  type FirstLoginPurpose,
} from './index.js';

type Comp = ReturnType<typeof createEnterpriseInitiationComposition>;

const PURPOSE: FirstLoginPurpose = 'ceo_password_set';

/** 构建带齐全依赖的编排器（用内存 SQLite + schema contributor）。 */
function makeComp(
  overrides?: Partial<Parameters<typeof createEnterpriseInitiationComposition>[0]>,
  seed?: (db: Database) => void,
): { db: Database; comp: Comp } {
  const db = new Database(':memory:');
  ENTERPRISE_INITIATION_SCHEMA_CONTRIBUTOR.apply(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT, slug TEXT, invite_secret TEXT);
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, organization_id TEXT, account_type TEXT, employee_id TEXT,
      username TEXT, password_hash TEXT, name TEXT, phone TEXT, is_admin INTEGER,
      status TEXT, role TEXT
    );
    CREATE TABLE IF NOT EXISTS organization_departments (
      id TEXT PRIMARY KEY, organization_id TEXT, name TEXT
    );
  `);
  seed?.(db);
  const comp = createEnterpriseInitiationComposition({
    db: () => db,
    resolveOrganizationSlug: (name) =>
      name.trim().toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '-'),
    assertAccountIdentifierAvailable: () => {},
    ...overrides,
  });
  return { db, comp };
}

const baseCommand = {
  deploymentId: 'deploy-1',
  commandId: 'cmd-1',
  idempotencyKey: 'idem-1',
  schemaVersion: 1,
  organization: { name: 'Example Corp', slug: 'example-corp' },
  ceo: { username: 'ceo@example.com', name: 'Ada CEO', phone: '+86-13800000000' },
  defaultDepartmentName: '默认部门',
  modules: ['enterprise_tree'],
};

describe('enterprise initiation (SERVER-16)', () => {
  it('正常指令创建企业、CEO、默认部门与系统角色绑定', () => {
    const { db, comp } = makeComp();
    const result = comp.executeInitiation(baseCommand);
    expect(result.replayed).toBe(false);
    expect(result.organizationId).toBeTruthy();
    expect(result.ceoAccountId).toBeTruthy();
    expect(result.defaultDepartmentId).toBeTruthy();

    const org = db.prepare('SELECT name, slug FROM organizations WHERE id = ?')
      .get(result.organizationId) as { name: string; slug: string };
    expect(org.name).toBe('Example Corp');
    expect(org.slug).toBe('example-corp');

    const ceo = db.prepare(
      'SELECT username, is_admin, status, role FROM accounts WHERE id = ?',
    ).get(result.ceoAccountId) as { username: string; is_admin: number; status: string; role: string };
    expect(ceo.username).toBe('ceo@example.com');
    expect(ceo.is_admin).toBe(1);
    expect(ceo.status).toBe('active');
    // CEO 角色来自注册表；不设默认密码（占位不可登录哈希）。
    expect(ceo.role).toBe('CEO（创始人）');

    const dept = db.prepare(
      'SELECT name FROM organization_departments WHERE id = ?',
    ).get(result.defaultDepartmentId!) as { name: string };
    expect(dept.name).toBe('默认部门');

    const roles = db.prepare(
      'SELECT role_key FROM system_role_assignments WHERE organization_id = ?',
    ).all(result.organizationId) as Array<{ role_key: string }>;
    expect(roles.map((r) => r.role_key).sort()).toEqual([
      'ceo', 'department_admin', 'member',
    ]);
  });

  it('重复指令（同键）返回同一结果且不重复创建资源', () => {
    const { db, comp } = makeComp();
    const first = comp.executeInitiation(baseCommand);
    const second = comp.executeInitiation(baseCommand);
    expect(first.organizationId).toBe(second.organizationId);
    expect(first.ceoAccountId).toBe(second.ceoAccountId);
    expect(second.replayed).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS c FROM organizations').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c).toBe(1);
  });

  it('不同 idempotencyKey 创建不同企业', () => {
    const { db, comp } = makeComp();
    const first = comp.executeInitiation(baseCommand);
    const second = comp.executeInitiation({ ...baseCommand, idempotencyKey: 'idem-2' });
    expect(first.organizationId).not.toBe(second.organizationId);
    expect((db.prepare('SELECT COUNT(*) AS c FROM organizations').get() as { c: number }).c).toBe(2);
  });

  it('任一入库步骤失败整体回滚，无半成品数据', () => {
    const db = new Database(':memory:');
    ENTERPRISE_INITIATION_SCHEMA_CONTRIBUTOR.apply(db);
    db.exec(`
      CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT, slug TEXT, invite_secret TEXT);
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, organization_id TEXT, account_type TEXT, employee_id TEXT,
        username TEXT, password_hash TEXT, name TEXT, phone TEXT, is_admin INTEGER,
        status TEXT, role TEXT
      );
      CREATE TABLE organization_departments (id TEXT PRIMARY KEY, organization_id TEXT, name TEXT);
    `);
    const comp = createEnterpriseInitiationComposition({
      db: () => db,
      assertAccountIdentifierAvailable: () => {
        throw new Error('手机号已绑定其他账号');
      },
    });
    expect(() => comp.executeInitiation(baseCommand)).toThrow('手机号已绑定其他账号');
    expect((db.prepare('SELECT COUNT(*) AS c FROM organizations').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM system_role_assignments').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM first_login_tokens').get() as { c: number }).c).toBe(0);
  });

  it('越界 schemaVersion 被拒绝', () => {
    const { comp } = makeComp();
    expect(() => comp.executeInitiation({ ...baseCommand, schemaVersion: 99 }))
      .toThrow(/版本|schemaVersion/);
  });
});

describe('system role registry (SERVER-16)', () => {
  it('外部 Payload 不能注入任意权限', () => {
    const result = validateRequestedRoleAssignment({
      requestedRoleKey: 'member',
      requestedPermissions: ['organization.manage'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not owned by role');
  });

  it('CEO 权限不能由 Payload 覆盖', () => {
    const result = validateRequestedRoleAssignment({
      requestedRoleKey: 'ceo',
      requestedPermissions: ['member.view_self'],
    });
    expect(result.ok).toBe(false);
  });

  it('未知角色被拒绝', () => {
    const result = validateRequestedRoleAssignment({
      requestedRoleKey: 'super_owner',
      requestedPermissions: [],
    });
    expect(result.ok).toBe(false);
  });

  it('合法角色子集权限通过', () => {
    const result = validateRequestedRoleAssignment({
      requestedRoleKey: 'member',
      requestedPermissions: ['member.view_self'],
    });
    expect(result.ok).toBe(true);
  });
});

describe('first-login token (SERVER-16)', () => {
  it('签发 → 正确核销认领 CEO；再次核销失败（单次使用）', () => {
    const { db, comp } = makeComp();
    const result = comp.executeInitiation(baseCommand);
    // 编排器不暴露明文令牌（只给 hash 前缀），这里重新签一个以验证单次语义。
    const issued = comp.issueFirstLoginToken({
      organizationId: result.organizationId,
      accountId: result.ceoAccountId,
      purpose: PURPOSE,
      ttlMs: 15 * 60_000,
    });
    const first = redeemFirstLoginTokenInRepository(
      { db: () => db, now: () => 1_700_000_000_000, createTokenId: () => 'x' },
      issued.token,
      PURPOSE,
    );
    expect(first).toEqual({
      accountId: result.ceoAccountId,
      organizationId: result.organizationId,
    });
    const second = redeemFirstLoginTokenInRepository(
      { db: () => db, now: () => 1_700_000_000_000, createTokenId: () => 'x' },
      issued.token,
      PURPOSE,
    );
    expect(second).toBeNull();
  });

  it('撤销未使用令牌后不可核销', () => {
    const { db, comp } = makeComp();
    const result = comp.executeInitiation(baseCommand);
    const issued = comp.issueFirstLoginToken({
      organizationId: result.organizationId,
      accountId: result.ceoAccountId,
      purpose: PURPOSE,
      ttlMs: 15 * 60_000,
    });
    const revoked = revokeFirstLoginTokens(
      { db: () => db, now: () => 1_700_000_000_000, createTokenId: () => 'x' },
      result.ceoAccountId,
      PURPOSE,
    );
    expect(revoked).toBe(1);
    const redeem = redeemFirstLoginTokenInRepository(
      { db: () => db, now: () => 1_700_000_000_000, createTokenId: () => 'x' },
      issued.token,
      PURPOSE,
    );
    expect(redeem).toBeNull();
  });

  it('过期令牌（现在超过过期时间）不可核销', () => {
    const { db, comp } = makeComp();
    const result = comp.executeInitiation(baseCommand);
    const issued = comp.issueFirstLoginToken({
      organizationId: result.organizationId,
      accountId: result.ceoAccountId,
      purpose: PURPOSE,
      ttlMs: 15 * 60_000,
    });
    // 把令牌过期时间强制设为过去。
    db.prepare(`UPDATE first_login_tokens SET expires_at_ms = 1 WHERE token_hash = ?`)
      .run(issued.tokenHash);
    const redeem = redeemFirstLoginTokenInRepository(
      { db: () => db, now: () => 1_700_000_000_000, createTokenId: () => 'x' },
      issued.token,
      PURPOSE,
    );
    expect(redeem).toBeNull();
  });
});
