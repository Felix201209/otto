/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Uses an isolated real enterprise database. Never touches the user's data.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type DbModule = typeof import('./db.js');

let directory: string;
let previousDirectory: string | undefined;
let opened: DbModule | null = null;

async function freshDatabase(): Promise<DbModule> {
  process.env.OTTO_ENTERPRISE_DIR = directory;
  vi.resetModules();
  opened = await import('./db.js');
  return opened;
}

beforeEach(() => {
  previousDirectory = process.env.OTTO_ENTERPRISE_DIR;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-bootstrap-org-'));
});

afterEach(() => {
  opened?.closeEnterpriseDatabase();
  opened = null;
  if (previousDirectory === undefined) delete process.env.OTTO_ENTERPRISE_DIR;
  else process.env.OTTO_ENTERPRISE_DIR = previousDirectory;
  fs.rmSync(directory, { recursive: true, force: true });
});

function command(overrides: Record<string, unknown> = {}) {
  return {
    deploymentId: 'dep_bootstrap_test',
    commandId: 'cmd_first',
    idempotencyKey: 'bootstrap-enterprise:enroll_test',
    payloadDigest: 'a'.repeat(64),
    organization: {
      id: 'org_customer_acme',
      name: 'Acme 科技',
      slug: 'acme-tech',
    },
    ceo: {
      username: 'acme-ceo',
      name: '张总',
      phone: '13800138000',
    },
    defaultDepartmentName: '管理层',
    ...overrides,
  };
}

function count(database: DbModule, table: string): number {
  return Number(
    (
      database
        .getDB()
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as {
        count: number;
      }
    ).count,
  );
}

describe('Control-bound enterprise bootstrap provisioning', () => {
  it('creates the real tenant tree and replays by business idempotency key', async () => {
    const database = await freshDatabase();
    const first = database.provisionBootstrapEnterprise(command());
    const replay = database.provisionBootstrapEnterprise(
      command({
        commandId: 'cmd_retry_after_response_loss',
      }),
    );

    expect(first).toMatchObject({
      organizationId: 'org_customer_acme',
      replayed: false,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(
      database
        .getDB()
        .prepare(
          `SELECT role, department, department_id, position_id, position_title,
                is_admin, phone
         FROM accounts WHERE id = ?`,
        )
        .get(first.ceoAccountId),
    ).toMatchObject({
      role: '企业管理员',
      department: '管理层',
      department_id: first.defaultDepartmentId,
      position_id: first.ceoPositionId,
      position_title: 'CEO',
      is_admin: 1,
      phone: '+8613800138000',
    });
    expect(
      database
        .getDB()
        .prepare('SELECT role_mapping FROM organization_positions WHERE id = ?')
        .get(first.ceoPositionId),
    ).toEqual({ role_mapping: 'enterprise_admin' });
    expect(
      database
        .getDB()
        .prepare(
          'SELECT COUNT(*) AS count FROM organization_invites WHERE organization_id = ?',
        )
        .get(first.organizationId),
    ).toEqual({ count: 1 });
    expect(count(database, 'organization_bootstrap_provisioning')).toBe(1);
    expect(
      database.hasBootstrapEnterpriseIdentity(
        'dep_bootstrap_test',
        'org_customer_acme',
      ),
    ).toBe(true);
    expect(
      database.hasBootstrapEnterpriseIdentity(
        'dep_other',
        'org_customer_acme',
      ),
    ).toBe(false);
  });

  it('rejects a changed payload for the same business key without extra writes', async () => {
    const database = await freshDatabase();
    database.provisionBootstrapEnterprise(command());

    expect(() =>
      database.provisionBootstrapEnterprise(
        command({
          commandId: 'cmd_tampered',
          payloadDigest: 'b'.repeat(64),
        }),
      ),
    ).toThrow('idempotency key was reused with a different payload');
    expect(count(database, 'organizations')).toBe(2); // org_default + customer
    expect(count(database, 'organization_bootstrap_provisioning')).toBe(1);
  });

  it('rolls back organization, structure and audit when the CEO conflicts', async () => {
    const database = await freshDatabase();
    database.createAccount({
      organizationId: database.DEFAULT_ORGANIZATION_ID,
      username: 'existing-phone',
      password: 'Existing-pass-2026',
      name: 'Existing',
      phone: '13800138000',
    });

    expect(() => database.provisionBootstrapEnterprise(command())).toThrow(
      '手机号已绑定其他账号',
    );
    expect(database.getOrganization('org_customer_acme')).toBeNull();
    expect(
      database
        .getDB()
        .prepare(
          'SELECT COUNT(*) AS count FROM organization_departments WHERE organization_id = ?',
        )
        .get('org_customer_acme'),
    ).toEqual({ count: 0 });
    expect(count(database, 'organization_bootstrap_provisioning')).toBe(0);
  });
});
