/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import { createDepartmentInviteFacade } from './departmentInviteFacade.js';
import type { DepartmentInviteRepositoryStore } from './departmentInviteRepository.js';

let database: Database;

function createStore(
  patch: Partial<DepartmentInviteRepositoryStore> = {},
): DepartmentInviteRepositoryStore {
  return {
    db: () => database,
    defaultOrganizationId: 'org-a',
    getOrganization(organizationId) {
      return database
        .prepare('SELECT id, status FROM organizations WHERE id = ?')
        .get(organizationId) as {
        id: string;
        status: 'active' | 'disabled';
      } | null;
    },
    logAudit(event, employeeId, detail, organizationId) {
      database
        .prepare(
          `INSERT INTO audit_logs (organization_id, event, employee_id, detail)
           VALUES (?, ?, ?, ?)`,
        )
        .run(organizationId, event, employeeId, detail);
    },
    generateCode: () => 'ABC234',
    now: () => Date.parse('2026-07-28T12:00:00.000Z'),
    ...patch,
  };
}

beforeEach(() => {
  database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    INSERT INTO organizations (id, status) VALUES
      ('org-a', 'active'),
      ('org-b', 'active'),
      ('org-disabled', 'disabled');

    CREATE TABLE invite_codes (
      code TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      department TEXT NOT NULL,
      max_uses INTEGER DEFAULT 1,
      used_count INTEGER DEFAULT 0,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    );
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id TEXT NOT NULL,
      event TEXT NOT NULL,
      employee_id TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
});

afterEach(() => {
  database.close();
});

describe('legacy department invite repository', () => {
  it('creates a tenant-bound code and audit record in one transaction', () => {
    const invites = createDepartmentInviteFacade(createStore());
    expect(invites.createInviteCode(' 研发部 ', ' admin-a ', 2, 'org-a')).toBe(
      'ABC234',
    );

    expect(
      database
        .prepare('SELECT * FROM invite_codes WHERE code = ?')
        .get('ABC234'),
    ).toMatchObject({
      organization_id: 'org-a',
      department: '研发部',
      max_uses: 2,
      created_by: 'admin-a',
    });
    expect(database.prepare('SELECT * FROM audit_logs').all()).toEqual([
      expect.objectContaining({
        organization_id: 'org-a',
        event: 'invite_create',
      }),
    ]);
  });

  it('rolls back the invite when audit persistence fails', () => {
    database.exec(`
      CREATE TRIGGER fail_invite_audit
      BEFORE INSERT ON audit_logs
      BEGIN
        SELECT RAISE(ABORT, 'audit unavailable');
      END;
    `);
    const invites = createDepartmentInviteFacade(createStore());

    expect(() => invites.createInviteCode('研发部')).toThrow(
      /audit unavailable/,
    );
    expect(database.prepare('SELECT * FROM invite_codes').all()).toEqual([]);
  });

  it('retries a generated-code collision without overwriting another tenant', () => {
    database
      .prepare(
        `INSERT INTO invite_codes (code, organization_id, department)
         VALUES ('ABC234', 'org-b', '财务部')`,
      )
      .run();
    const candidates = ['ABC234', 'DEF567'];
    const invites = createDepartmentInviteFacade(
      createStore({ generateCode: () => candidates.shift() ?? 'DEF567' }),
    );

    expect(invites.createInviteCode('研发部')).toBe('DEF567');
    expect(
      database
        .prepare('SELECT organization_id FROM invite_codes WHERE code = ?')
        .get('ABC234'),
    ).toMatchObject({ organization_id: 'org-b' });
  });

  it('binds explicit organization context and never consumes across tenants', () => {
    const invites = createDepartmentInviteFacade(createStore());
    invites.createInviteCode('研发部', 'admin', 1, 'org-a');

    expect(invites.validateInviteCode('ABC234', 'org-b')).toEqual({
      valid: false,
      error: 'Invalid invite code',
    });
    expect(invites.validateInviteCode(' abc234 ', 'org-a')).toMatchObject({
      valid: true,
      organizationId: 'org-a',
      department: '研发部',
    });
    expect(invites.validateInviteCode('ABC234', 'org-a')).toEqual({
      valid: false,
      error: 'Invite code already used',
    });
  });

  it('rolls back consumption when the member creation callback fails', () => {
    const invites = createDepartmentInviteFacade(createStore());
    invites.createInviteCode('研发部');

    expect(() =>
      invites.validateInviteCode('ABC234', undefined, () => {
        throw new Error('employee insert failed');
      }),
    ).toThrow(/employee insert failed/);
    expect(
      database
        .prepare('SELECT used_count FROM invite_codes WHERE code = ?')
        .get('ABC234'),
    ).toMatchObject({ used_count: 0 });
    expect(invites.validateInviteCode('ABC234')).toMatchObject({ valid: true });
  });

  it('fails closed for expired codes and disabled organizations', () => {
    database.exec(`
      INSERT INTO invite_codes
        (code, organization_id, department, expires_at)
      VALUES
        ('EXP234', 'org-a', '研发部', '2026-07-28 11:59:59'),
        ('DSA234', 'org-disabled', '研发部', NULL);
    `);
    const invites = createDepartmentInviteFacade(createStore());

    expect(invites.validateInviteCode('EXP234')).toEqual({
      valid: false,
      error: 'Invite code expired',
    });
    expect(invites.validateInviteCode('DSA234')).toEqual({
      valid: false,
      error: 'Organization is disabled',
    });
    expect(() =>
      invites.createInviteCode('研发部', 'admin', 1, 'org-disabled'),
    ).toThrow(/Organization is disabled/);
  });

  it('rejects malformed persistent inputs before writing', () => {
    const invites = createDepartmentInviteFacade(createStore());
    expect(() => invites.createInviteCode(' ')).toThrow(/department required/);
    expect(() => invites.createInviteCode('研发部', 'admin', 0)).toThrow(
      /maxUses/,
    );
    expect(() => invites.createInviteCode('研发部', 'admin', 10_001)).toThrow(
      /maxUses/,
    );
    expect(database.prepare('SELECT * FROM invite_codes').all()).toEqual([]);
  });
});
