/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { Database } from '../data_platform/index.js';

export type OrganizationPositionRoleMapping =
  'member' | 'department_admin' | 'enterprise_admin';

export interface OrganizationPositionView {
  id: string;
  organizationId: string;
  departmentId: string;
  title: string;
  roleMapping: OrganizationPositionRoleMapping;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationDepartmentView {
  id: string;
  organizationId: string;
  name: string;
  memberCount: number;
  positions: OrganizationPositionView[];
  createdAt: string;
  updatedAt: string;
}

interface OrganizationDepartmentRow {
  id: string;
  organization_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface OrganizationPositionRow {
  id: string;
  organization_id: string;
  department_id: string;
  title: string;
  role_mapping: OrganizationPositionRoleMapping;
  created_at: string;
  updated_at: string;
}

export interface OrganizationStructureRepositoryStore {
  db(): Database;
  logAudit(
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
}

export interface CreateOrganizationDepartmentInput {
  organizationId: string;
  name: string;
}

export interface UpdateOrganizationDepartmentInput {
  organizationId: string;
  departmentId: string;
  name: string;
}

export interface DeleteOrganizationDepartmentInput {
  organizationId: string;
  departmentId: string;
}

export interface CreateOrganizationPositionInput {
  organizationId: string;
  departmentId: string;
  title: string;
  roleMapping?: OrganizationPositionRoleMapping;
}

export interface UpdateOrganizationPositionInput {
  organizationId: string;
  positionId: string;
  title?: string;
  roleMapping?: OrganizationPositionRoleMapping;
}

export interface DeleteOrganizationPositionInput {
  organizationId: string;
  positionId: string;
}

function normalizeStructureText(
  value: string | null | undefined,
  label: string,
  maxLength = 80,
): string | null {
  const clean = value?.trim() || null;
  if (clean && clean.length > maxLength) {
    throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  }
  return clean;
}

export function normalizeAssignmentName(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('zh-CN');
}

export function stableAssignmentId(
  prefix: 'dept' | 'pos',
  organizationId: string,
  ...parts: Array<string | null>
): string {
  const digest = createHash('sha256')
    .update([organizationId, ...parts.map((part) => part ?? '')].join('\0'))
    .digest('hex')
    .slice(0, 20);
  return `${prefix}_${digest}`;
}

function toOrganizationPositionView(
  row: OrganizationPositionRow,
): OrganizationPositionView {
  return {
    id: row.id,
    organizationId: row.organization_id,
    departmentId: row.department_id,
    title: row.title,
    roleMapping: row.role_mapping,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getOrganizationPositionRoleMappingFromRepository(
  database: Database,
  organizationId: string,
  positionId: string,
): OrganizationPositionRoleMapping | null {
  const row = database
    .prepare(
      `SELECT role_mapping FROM organization_positions
       WHERE id = ? AND organization_id = ?`,
    )
    .get(positionId, organizationId) as
    { role_mapping: OrganizationPositionRoleMapping } | undefined;
  return row?.role_mapping ?? null;
}

function roleForMapping(mapping: OrganizationPositionRoleMapping): string {
  if (mapping === 'enterprise_admin') return '企业管理员';
  if (mapping === 'department_admin') return '部门管理员';
  return '成员';
}

function isUniqueConstraintFor(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    error.message.includes('UNIQUE constraint failed') &&
    error.message.includes(table)
  );
}

function withImmediateTransaction<T>(
  database: Database,
  operation: () => T,
): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function listOrganizationStructureFromRepository(
  store: OrganizationStructureRepositoryStore,
  organizationId: string,
): OrganizationDepartmentView[] {
  const database = store.db();
  const departments = database
    .prepare(
      `SELECT * FROM organization_departments
       WHERE organization_id = ? ORDER BY name COLLATE NOCASE, id`,
    )
    .all(organizationId) as OrganizationDepartmentRow[];
  const positions = database
    .prepare(
      `SELECT * FROM organization_positions
       WHERE organization_id = ? ORDER BY title COLLATE NOCASE, id`,
    )
    .all(organizationId) as OrganizationPositionRow[];
  const counts = database
    .prepare(
      `SELECT department_id, COUNT(*) AS count FROM accounts
       WHERE organization_id = ? AND deleted_at IS NULL AND status = 'active'
         AND department_id IS NOT NULL
       GROUP BY department_id`,
    )
    .all(organizationId) as Array<{ department_id: string; count: number }>;
  const countByDepartment = new Map(
    counts.map((row) => [row.department_id, Number(row.count)]),
  );
  return departments.map((department) => ({
    id: department.id,
    organizationId: department.organization_id,
    name: department.name,
    memberCount: countByDepartment.get(department.id) ?? 0,
    positions: positions
      .filter((position) => position.department_id === department.id)
      .map(toOrganizationPositionView),
    createdAt: department.created_at,
    updatedAt: department.updated_at,
  }));
}

export function createOrganizationDepartmentInRepository(
  store: OrganizationStructureRepositoryStore,
  input: CreateOrganizationDepartmentInput,
): OrganizationDepartmentView {
  const database = store.db();
  const organization = database
    .prepare('SELECT 1 FROM organizations WHERE id = ?')
    .get(input.organizationId);
  if (!organization) throw new Error('企业不存在');
  const name = normalizeStructureText(input.name, '部门名称');
  if (!name) throw new Error('部门名称不能为空');
  const id = stableAssignmentId(
    'dept',
    input.organizationId,
    normalizeAssignmentName(name),
  );
  try {
    database
      .prepare(
        `INSERT INTO organization_departments (id, organization_id, name)
         VALUES (?, ?, ?)`,
      )
      .run(id, input.organizationId, name);
  } catch (error) {
    if (isUniqueConstraintFor(error, 'organization_departments')) {
      throw new Error('部门名称已存在');
    }
    throw error;
  }
  return listOrganizationStructureFromRepository(
    store,
    input.organizationId,
  ).find((department) => department.id === id)!;
}

export function updateOrganizationDepartmentInRepository(
  store: OrganizationStructureRepositoryStore,
  input: UpdateOrganizationDepartmentInput,
): OrganizationDepartmentView {
  const name = normalizeStructureText(input.name, '部门名称');
  if (!name) throw new Error('部门名称不能为空');
  const database = store.db();
  try {
    withImmediateTransaction(database, () => {
      const changed = database
        .prepare(
          `UPDATE organization_departments
           SET name = ?, updated_at = datetime('now')
           WHERE id = ? AND organization_id = ?`,
        )
        .run(name, input.departmentId, input.organizationId);
      if (Number(changed.changes) !== 1) throw new Error('部门不存在');
      database
        .prepare(
          `UPDATE accounts SET department = ?, updated_at = datetime('now')
           WHERE organization_id = ? AND department_id = ?`,
        )
        .run(name, input.organizationId, input.departmentId);
      database
        .prepare(
          `UPDATE employees SET department = ?
           WHERE organization_id = ? AND department_id = ?`,
        )
        .run(name, input.organizationId, input.departmentId);
      database
        .prepare(
          `UPDATE organization_invites SET default_department = ?
           WHERE organization_id = ? AND department_id = ?`,
        )
        .run(name, input.organizationId, input.departmentId);
    });
  } catch (error) {
    if (isUniqueConstraintFor(error, 'organization_departments')) {
      throw new Error('部门名称已存在');
    }
    throw error;
  }
  return listOrganizationStructureFromRepository(
    store,
    input.organizationId,
  ).find((department) => department.id === input.departmentId)!;
}

export function deleteOrganizationDepartmentInRepository(
  store: OrganizationStructureRepositoryStore,
  input: DeleteOrganizationDepartmentInput,
): void {
  const database = store.db();
  const positions = database
    .prepare(
      `SELECT COUNT(*) AS count FROM organization_positions
       WHERE organization_id = ? AND department_id = ?`,
    )
    .get(input.organizationId, input.departmentId) as { count: number };
  if (Number(positions.count) > 0) {
    throw new Error('部门仍有岗位，不能删除');
  }
  const members = database
    .prepare(
      `SELECT COUNT(*) AS count FROM accounts
       WHERE organization_id = ? AND department_id = ? AND deleted_at IS NULL`,
    )
    .get(input.organizationId, input.departmentId) as { count: number };
  if (Number(members.count) > 0) {
    throw new Error('部门仍有成员，不能删除');
  }
  const changed = database
    .prepare(
      `DELETE FROM organization_departments
       WHERE id = ? AND organization_id = ?`,
    )
    .run(input.departmentId, input.organizationId);
  if (Number(changed.changes) !== 1) throw new Error('部门不存在');
}

export function createOrganizationPositionInRepository(
  store: OrganizationStructureRepositoryStore,
  input: CreateOrganizationPositionInput,
): OrganizationPositionView {
  const title = normalizeStructureText(input.title, '职位名称');
  if (!title) throw new Error('职位名称不能为空');
  const database = store.db();
  const department = database
    .prepare(
      `SELECT id FROM organization_departments
       WHERE id = ? AND organization_id = ?`,
    )
    .get(input.departmentId, input.organizationId);
  if (!department) throw new Error('部门不存在');
  const roleMapping = input.roleMapping ?? 'member';
  const id = stableAssignmentId(
    'pos',
    input.organizationId,
    input.departmentId,
    normalizeAssignmentName(title),
  );
  try {
    database
      .prepare(
        `INSERT INTO organization_positions
         (id, organization_id, department_id, title, role_mapping)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.organizationId, input.departmentId, title, roleMapping);
  } catch (error) {
    if (isUniqueConstraintFor(error, 'organization_positions')) {
      throw new Error('该部门下职位名称已存在');
    }
    throw error;
  }
  return listOrganizationStructureFromRepository(store, input.organizationId)
    .flatMap((departmentView) => departmentView.positions)
    .find((position) => position.id === id)!;
}

export function updateOrganizationPositionInRepository(
  store: OrganizationStructureRepositoryStore,
  input: UpdateOrganizationPositionInput,
): OrganizationPositionView {
  const database = store.db();
  withImmediateTransaction(database, () => {
    const current = database
      .prepare(
        `SELECT * FROM organization_positions
         WHERE id = ? AND organization_id = ?`,
      )
      .get(input.positionId, input.organizationId) as
      OrganizationPositionRow | undefined;
    if (!current) throw new Error('职位不存在');
    const title =
      input.title === undefined
        ? current.title
        : normalizeStructureText(input.title, '职位名称');
    if (!title) throw new Error('职位名称不能为空');
    const roleMapping = input.roleMapping ?? current.role_mapping;
    if (roleMapping !== 'enterprise_admin') {
      const activeMappedAdmins = database
        .prepare(
          `SELECT COUNT(*) AS count FROM accounts
           WHERE organization_id = ? AND position_id = ? AND is_admin = 1
             AND status = 'active' AND deleted_at IS NULL`,
        )
        .get(input.organizationId, input.positionId) as { count: number };
      if (Number(activeMappedAdmins.count) > 0) {
        const otherActiveAdmin = database
          .prepare(
            `SELECT 1 FROM accounts
             WHERE organization_id = ?
               AND (position_id IS NULL OR position_id <> ?)
               AND is_admin = 1 AND status = 'active' AND deleted_at IS NULL
             LIMIT 1`,
          )
          .get(input.organizationId, input.positionId);
        if (!otherActiveAdmin) {
          throw new Error('企业至少需要保留一名可登录管理员');
        }
      }
    }
    const mappedRole = roleForMapping(roleMapping);
    database
      .prepare(
        `UPDATE organization_positions
         SET title = ?, role_mapping = ?, updated_at = datetime('now')
         WHERE id = ? AND organization_id = ?`,
      )
      .run(title, roleMapping, input.positionId, input.organizationId);
    database
      .prepare(
        `UPDATE accounts SET position_title = ?, role = ?,
           is_admin = CASE WHEN ? = 'enterprise_admin' THEN 1 ELSE 0 END,
           updated_at = datetime('now')
         WHERE organization_id = ? AND position_id = ?`,
      )
      .run(
        title,
        mappedRole,
        roleMapping,
        input.organizationId,
        input.positionId,
      );
    database
      .prepare(
        `UPDATE employees SET position_title = ?, role = ?
         WHERE organization_id = ? AND position_id = ?`,
      )
      .run(title, mappedRole, input.organizationId, input.positionId);
    database
      .prepare(
        `UPDATE organization_invites SET position_title = ?, default_role = ?
         WHERE organization_id = ? AND position_id = ?`,
      )
      .run(title, mappedRole, input.organizationId, input.positionId);
    database
      .prepare(
        `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now'))
         WHERE account_id IN (
           SELECT id FROM accounts
           WHERE organization_id = ? AND position_id = ?
         )`,
      )
      .run(input.organizationId, input.positionId);
    store.logAudit(
      'organization_position_update',
      null,
      `Position ${input.positionId} mapped to ${roleMapping}`,
      input.organizationId,
    );
  });
  return listOrganizationStructureFromRepository(store, input.organizationId)
    .flatMap((department) => department.positions)
    .find((position) => position.id === input.positionId)!;
}

export function deleteOrganizationPositionInRepository(
  store: OrganizationStructureRepositoryStore,
  input: DeleteOrganizationPositionInput,
): void {
  const database = store.db();
  const member = database
    .prepare(
      `SELECT 1 FROM accounts
       WHERE organization_id = ? AND position_id = ? AND deleted_at IS NULL
       LIMIT 1`,
    )
    .get(input.organizationId, input.positionId);
  if (member) throw new Error('职位仍有成员，不能删除');
  const changed = database
    .prepare(
      `DELETE FROM organization_positions
       WHERE id = ? AND organization_id = ?`,
    )
    .run(input.positionId, input.organizationId);
  if (Number(changed.changes) !== 1) throw new Error('职位不存在');
}
