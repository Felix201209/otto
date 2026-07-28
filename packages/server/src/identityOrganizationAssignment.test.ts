/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from './modules/data_platform/index.js';
import {
  createAssignmentIdentityFacade,
  stableAssignmentId,
} from './modules/identity_organization/index.js';

let database: Database;
const assignments = createAssignmentIdentityFacade();

function createSchema(): void {
  database.exec(`
    CREATE TABLE organization_departments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE,
      UNIQUE(organization_id, name)
    );
    CREATE TABLE organization_positions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      department_id TEXT NOT NULL,
      title TEXT NOT NULL COLLATE NOCASE,
      role_mapping TEXT NOT NULL DEFAULT 'member',
      UNIQUE(organization_id, department_id, title)
    );
    CREATE TABLE accounts (
      organization_id TEXT NOT NULL,
      department TEXT,
      department_id TEXT,
      position_title TEXT,
      position_id TEXT,
      deleted_at TEXT
    );
    CREATE TABLE employees (
      organization_id TEXT NOT NULL,
      department TEXT,
      department_id TEXT,
      position_title TEXT,
      position_id TEXT
    );
    CREATE TABLE organization_invites (
      organization_id TEXT NOT NULL,
      default_department TEXT,
      department_id TEXT,
      position_title TEXT,
      position_id TEXT
    );
  `);
}

beforeEach(() => {
  database = new Database(':memory:');
  createSchema();
});

afterEach(() => {
  database.close();
});

describe('identity_organization assignment identity', () => {
  it('creates stable tenant-scoped directory nodes and reuses them', () => {
    const first = assignments.resolveAssignmentIdentity(database, 'org-a', {
      department: '研发中心',
      positionTitle: '技术负责人',
    });
    const second = assignments.resolveAssignmentIdentity(database, 'org-a', {
      department: '  研发中心  ',
      positionTitle: '技术负责人',
    });

    expect(first).toEqual(second);
    expect(first.departmentId).toBe(
      stableAssignmentId('dept', 'org-a', '研发中心'),
    );
    expect(first.positionId).toBe(
      stableAssignmentId('pos', 'org-a', first.departmentId, '技术负责人'),
    );
    expect(
      database
        .prepare('SELECT role_mapping FROM organization_positions WHERE id = ?')
        .get(first.positionId!),
    ).toEqual({ role_mapping: 'member' });

    database
      .prepare(
        "UPDATE organization_positions SET role_mapping = 'enterprise_admin' WHERE id = ?",
      )
      .run(first.positionId!);
    assignments.resolveAssignmentIdentity(database, 'org-a', {
      department: '研发中心',
      positionTitle: '技术负责人',
    });
    expect(
      database
        .prepare('SELECT role_mapping FROM organization_positions WHERE id = ?')
        .get(first.positionId!),
    ).toEqual({ role_mapping: 'enterprise_admin' });
  });

  it('reuses legacy display names after Unicode and whitespace normalization', () => {
    database
      .prepare(
        'INSERT INTO organization_departments (id, organization_id, name) VALUES (?, ?, ?)',
      )
      .run('dept-research', 'org-a', 'Research  Team');

    expect(
      assignments.resolveAssignmentIdentity(database, 'org-a', {
        department: 'Ｒｅｓｅａｒｃｈ Team',
      }),
    ).toMatchObject({ departmentId: 'dept-research' });
  });

  it('keeps generated identities isolated between organizations', () => {
    const alpha = assignments.resolveAssignmentIdentity(database, 'org-a', {
      department: '运营部',
      positionTitle: '主管',
    });
    const beta = assignments.resolveAssignmentIdentity(database, 'org-b', {
      department: '运营部',
      positionTitle: '主管',
    });

    expect(alpha.departmentId).not.toBe(beta.departmentId);
    expect(alpha.positionId).not.toBe(beta.positionId);
  });

  it('rejects explicit IDs owned by another organization', () => {
    database
      .prepare(
        'INSERT INTO organization_departments (id, organization_id, name) VALUES (?, ?, ?)',
      )
      .run('dept-shared', 'org-b', '财务部');

    expect(() =>
      assignments.resolveAssignmentIdentity(database, 'org-a', {
        department: '财务部',
        departmentId: 'dept-shared',
      }),
    ).toThrow('该部门 ID 已属于其他企业');
    expect(
      database
        .prepare(
          'SELECT COUNT(*) AS count FROM organization_departments WHERE organization_id = ?',
        )
        .get('org-a'),
    ).toEqual({ count: 0 });
  });

  it('treats legacy assignment references as tenant ownership evidence', () => {
    database
      .prepare(
        `INSERT INTO accounts
          (organization_id, department, department_id, position_title, position_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('org-b', '市场部', 'dept-legacy', '市场主管', 'pos-legacy');

    expect(() =>
      assignments.resolveAssignmentIdentity(database, 'org-a', {
        department: '市场部',
        departmentId: 'dept-legacy',
      }),
    ).toThrow('该部门 ID 已属于其他企业');
    expect(() =>
      assignments.resolveAssignmentIdentity(database, 'org-a', {
        department: '市场部',
        departmentId: 'dept-new',
        positionTitle: '市场主管',
        positionId: 'pos-legacy',
      }),
    ).toThrow('该职位 ID 已属于其他企业');
  });

  it('fails closed when names and explicit IDs conflict inside a tenant', () => {
    assignments.resolveAssignmentIdentity(database, 'org-a', {
      department: '法务部',
      departmentId: 'dept-legal',
      positionTitle: '法务主管',
      positionId: 'pos-legal-lead',
    });

    expect(() =>
      assignments.resolveAssignmentIdentity(database, 'org-a', {
        department: '人事部',
        departmentId: 'dept-legal',
      }),
    ).toThrow('该部门 ID 已绑定其他部门名称');
    expect(() =>
      assignments.resolveAssignmentIdentity(database, 'org-a', {
        department: '法务部',
        departmentId: 'dept-legal',
        positionTitle: '法务专员',
        positionId: 'pos-legal-lead',
      }),
    ).toThrow('该职位 ID 已绑定其他部门或职位名称');
  });

  it('rolls back a new department when position persistence fails', () => {
    database.exec(`
      CREATE TRIGGER reject_positions
      BEFORE INSERT ON organization_positions
      BEGIN
        SELECT RAISE(ABORT, 'position rejected');
      END;
    `);

    expect(() =>
      assignments.resolveAssignmentIdentity(database, 'org-a', {
        department: '新部门',
        positionTitle: '新职位',
      }),
    ).toThrow('position rejected');
    expect(
      database
        .prepare(
          'SELECT COUNT(*) AS count FROM organization_departments WHERE organization_id = ?',
        )
        .get('org-a'),
    ).toEqual({ count: 0 });
  });

  it('requires display names for explicit assignment IDs', () => {
    expect(() =>
      assignments.resolveAssignmentIdentity(database, 'org-a', {
        departmentId: 'dept-only',
      }),
    ).toThrow('设置部门 ID 时必须同时提供部门名称');
    expect(() =>
      assignments.resolveAssignmentIdentity(database, 'org-a', {
        positionId: 'pos-only',
      }),
    ).toThrow('设置职位 ID 时必须同时提供职位名称');
  });
});
