/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import {
  deleteAccountTagsInRepository,
  replaceAccountTagsInRepository,
} from './accountTagRepository.js';

export type AccountLifecycleRoleMapping =
  'member' | 'department_admin' | 'enterprise_admin';

export interface AccountLifecycleAssignment {
  department: string | null;
  departmentId: string | null;
  positionId: string | null;
  positionTitle: string | null;
  roleMapping: AccountLifecycleRoleMapping | null;
}

export interface AccountLifecycleView {
  id: string;
  organizationId: string;
  accountType: 'personal' | 'enterprise';
  employeeId: string | null;
  username: string;
  name: string;
  role: string | null;
  department: string | null;
  departmentId: string | null;
  positionId: string | null;
  positionTitle: string | null;
  isAdmin: boolean;
  status: 'active' | 'disabled';
}

export interface CreateAccountInput {
  organizationId?: string;
  accountType?: 'personal' | 'enterprise';
  username: string;
  password: string;
  name: string;
  phone?: string | null;
  feishuOpenId?: string | null;
  employeeId?: string | null;
  role?: string | null;
  department?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
  avatarUrl?: string | null;
  tags?: string[];
  isAdmin?: boolean;
  status?: 'active' | 'disabled';
}

export interface UpdateAccountPatch {
  username?: string;
  password?: string;
  name?: string;
  phone?: string | null;
  feishuOpenId?: string | null;
  role?: string | null;
  department?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
  avatarUrl?: string | null;
  tags?: string[];
  isAdmin?: boolean;
  status?: 'active' | 'disabled';
}

export interface AccountLifecycleRepositoryStore<
  TAccountView extends AccountLifecycleView,
> {
  db(): Database;
  defaultOrganizationId: string;
  organizationExists(organizationId: string): boolean;
  normalizeUsername(username: string): string;
  normalizeOptionalPhone(value: string | null | undefined): string | null;
  normalizeOptionalFeishuOpenId(
    value: string | null | undefined,
  ): string | null;
  normalizeOptionalAvatarUrl(value: string | null | undefined): string | null;
  assertPassword(password: string): void;
  hashPassword(password: string): string;
  createId(prefix: 'acc' | 'emp'): string;
  createDeletionPasswordHash(): string;
  resolveAssignment(
    database: Database,
    organizationId: string,
    input: {
      department?: string | null;
      departmentId?: string | null;
      positionId?: string | null;
      positionTitle?: string | null;
    },
  ): AccountLifecycleAssignment;
  createEmployee(input: {
    id: string;
    organizationId: string;
    name: string;
    role?: string;
    department?: string;
    departmentId?: string;
    positionId?: string;
    positionTitle?: string;
  }): unknown;
  getAccount(id: string, organizationId?: string): TAccountView | null;
  logAudit(
    action: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
}

function roleForMapping(
  roleMapping: AccountLifecycleRoleMapping | null,
): string | null {
  if (roleMapping === 'enterprise_admin') return '企业管理员';
  if (roleMapping === 'department_admin') return '部门管理员';
  if (roleMapping === 'member') return '成员';
  return null;
}

function throwStablePhoneConflict(error: unknown): never {
  if (/accounts\.phone|idx_accounts_phone_unique/i.test(String(error))) {
    throw new Error('手机号已绑定其他账号');
  }
  throw error;
}

export function createAccountInRepository<
  TAccountView extends AccountLifecycleView,
>(
  store: AccountLifecycleRepositoryStore<TAccountView>,
  input: CreateAccountInput,
): TAccountView {
  const organizationId = input.organizationId || store.defaultOrganizationId;
  if (!store.organizationExists(organizationId)) {
    throw new Error('Organization not found');
  }
  const username = store.normalizeUsername(input.username);
  const name = input.name.trim();
  if (!username || !name || !input.password) {
    throw new Error('username, password and name required');
  }
  store.assertPassword(input.password);
  const status = input.status ?? 'active';
  if (status !== 'active' && status !== 'disabled') {
    throw new Error('账号状态必须是 active 或 disabled');
  }

  const database = store.db();
  const accountType = input.accountType ?? 'enterprise';
  const assignment = store.resolveAssignment(database, organizationId, input);
  const mappedRole = roleForMapping(assignment.roleMapping);
  const effectiveRole = mappedRole ?? (input.role?.trim() || null);
  const effectiveIsAdmin =
    assignment.roleMapping !== null
      ? assignment.roleMapping === 'enterprise_admin'
      : (input.isAdmin ?? false);
  const id = store.createId('acc');
  let employeeId = input.employeeId || null;

  database.exec('SAVEPOINT create_account');
  try {
    if (accountType === 'enterprise' && !employeeId) {
      employeeId = store.createId('emp');
      store.createEmployee({
        id: employeeId,
        organizationId,
        name,
        role: effectiveRole || undefined,
        department: assignment.department || undefined,
        departmentId: assignment.departmentId || undefined,
        positionId: assignment.positionId || undefined,
        positionTitle: assignment.positionTitle || undefined,
      });
    }
    database
      .prepare(
        `INSERT INTO accounts
         (id, organization_id, account_type, employee_id, username, phone,
          feishu_open_id, password_hash, name, role, department, department_id,
          position_id, position_title, avatar_url, is_admin, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        organizationId,
        accountType,
        employeeId,
        username,
        store.normalizeOptionalPhone(input.phone),
        store.normalizeOptionalFeishuOpenId(input.feishuOpenId),
        store.hashPassword(input.password),
        name,
        effectiveRole,
        assignment.department,
        assignment.departmentId,
        assignment.positionId,
        assignment.positionTitle,
        store.normalizeOptionalAvatarUrl(input.avatarUrl),
        effectiveIsAdmin ? 1 : 0,
        status,
      );
    replaceAccountTagsInRepository(store, id, organizationId, input.tags ?? []);
    store.logAudit(
      'account_create',
      employeeId,
      `Preset account ${username} created`,
      organizationId,
    );
    const created = store.getAccount(id, organizationId);
    if (!created) throw new Error('账号创建失败');
    database.exec('RELEASE SAVEPOINT create_account');
    return created;
  } catch (error) {
    database.exec('ROLLBACK TO SAVEPOINT create_account');
    database.exec('RELEASE SAVEPOINT create_account');
    throwStablePhoneConflict(error);
  }
}

export function updateAccountInRepository<
  TAccountView extends AccountLifecycleView,
>(
  store: AccountLifecycleRepositoryStore<TAccountView>,
  id: string,
  patch: UpdateAccountPatch,
  organizationId?: string,
): TAccountView {
  const database = store.db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = store.getAccount(id, organizationId);
    if (!current) throw new Error('Account not found');

    const assignmentChanged = [
      patch.department,
      patch.departmentId,
      patch.positionId,
      patch.positionTitle,
    ].some((value) => value !== undefined);
    const assignment = assignmentChanged
      ? store.resolveAssignment(database, current.organizationId, {
          department:
            patch.department !== undefined
              ? patch.department
              : current.department,
          departmentId:
            patch.departmentId !== undefined ? patch.departmentId : undefined,
          positionTitle:
            patch.positionTitle !== undefined
              ? patch.positionTitle
              : current.positionTitle,
          positionId:
            patch.positionId !== undefined ? patch.positionId : undefined,
        })
      : null;
    const mappedRole = assignment
      ? roleForMapping(assignment.roleMapping)
      : null;
    const nextIsAdmin =
      assignment !== null && assignment.roleMapping !== null
        ? assignment.roleMapping === 'enterprise_admin'
        : (patch.isAdmin ?? current.isAdmin);
    const nextStatus = patch.status ?? current.status;
    const removesActiveAdmin =
      current.isAdmin &&
      current.status === 'active' &&
      (!nextIsAdmin || nextStatus === 'disabled');
    if (removesActiveAdmin) {
      const other = database
        .prepare(
          `SELECT 1 FROM accounts
           WHERE organization_id = ? AND id <> ? AND is_admin = 1
             AND status = 'active' AND deleted_at IS NULL
           LIMIT 1`,
        )
        .get(current.organizationId, current.id);
      if (!other) throw new Error('企业至少需要保留一名可登录管理员');
    }

    const assignments: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown): void => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.username !== undefined) {
      const username = store.normalizeUsername(patch.username);
      if (!username) throw new Error('username required');
      set('username', username);
    }
    if (patch.phone !== undefined) {
      set('phone', store.normalizeOptionalPhone(patch.phone));
    }
    if (patch.feishuOpenId !== undefined) {
      set(
        'feishu_open_id',
        store.normalizeOptionalFeishuOpenId(patch.feishuOpenId),
      );
    }
    if (patch.password !== undefined) {
      store.assertPassword(patch.password);
      set('password_hash', store.hashPassword(patch.password));
    }
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error('name required');
      set('name', name);
    }
    if (mappedRole !== null) set('role', mappedRole);
    else if (patch.role !== undefined) set('role', patch.role?.trim() || null);
    if (assignment) {
      set('department', assignment.department);
      set('department_id', assignment.departmentId);
      set('position_id', assignment.positionId);
      set('position_title', assignment.positionTitle);
    }
    if (patch.avatarUrl !== undefined) {
      set('avatar_url', store.normalizeOptionalAvatarUrl(patch.avatarUrl));
    }
    if (assignment !== null && assignment.roleMapping !== null) {
      set('is_admin', nextIsAdmin ? 1 : 0);
    } else if (patch.isAdmin !== undefined) {
      set('is_admin', patch.isAdmin ? 1 : 0);
    }
    if (patch.status !== undefined) set('status', patch.status);

    if (assignments.length > 0) {
      assignments.push("updated_at = datetime('now')");
      try {
        const sql = organizationId
          ? `UPDATE accounts SET ${assignments.join(', ')} WHERE id = ? AND organization_id = ?`
          : `UPDATE accounts SET ${assignments.join(', ')} WHERE id = ?`;
        database
          .prepare(sql)
          .run(...values, id, ...(organizationId ? [organizationId] : []));
      } catch (error) {
        throwStablePhoneConflict(error);
      }
    }
    if (patch.tags !== undefined) {
      replaceAccountTagsInRepository(
        store,
        id,
        current.organizationId,
        patch.tags,
      );
    }

    const shouldRevokeSessions =
      patch.password !== undefined ||
      (patch.status !== undefined && patch.status !== current.status) ||
      nextIsAdmin !== current.isAdmin ||
      (mappedRole !== null && mappedRole !== current.role) ||
      assignmentChanged;
    if (shouldRevokeSessions) {
      database
        .prepare(
          `UPDATE auth_sessions SET revoked_at = datetime('now')
           WHERE account_id = ? AND revoked_at IS NULL`,
        )
        .run(id);
    }

    const updated = store.getAccount(id, organizationId);
    if (!updated) throw new Error('Account not found');
    if (
      current.employeeId &&
      [
        patch.name,
        patch.role,
        patch.department,
        patch.departmentId,
        patch.positionId,
        patch.positionTitle,
      ].some((value) => value !== undefined)
    ) {
      database
        .prepare(
          `UPDATE employees
           SET name = ?, role = ?, department = ?, department_id = ?,
               position_id = ?, position_title = ?
           WHERE id = ? AND organization_id = ?`,
        )
        .run(
          updated.name,
          updated.role,
          updated.department,
          updated.departmentId,
          updated.positionId,
          updated.positionTitle,
          current.employeeId,
          current.organizationId,
        );
    }

    store.logAudit(
      'account_update',
      current.employeeId,
      `Preset account ${current.username} updated`,
      current.organizationId,
    );
    database.exec('COMMIT');
    return updated;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function deleteAccountInRepository<
  TAccountView extends AccountLifecycleView,
>(
  store: AccountLifecycleRepositoryStore<TAccountView>,
  id: string,
  organizationId: string,
  actorAccountId: string,
): { id: string; deleted: true } {
  if (id === actorAccountId) throw new Error('不能删除当前登录账号');
  const database = store.db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = store.getAccount(id, organizationId);
    if (!current) throw new Error('Account not found');
    if (current.isAdmin && current.status === 'active') {
      const other = database
        .prepare(
          `SELECT 1 FROM accounts
           WHERE organization_id = ? AND id <> ? AND is_admin = 1
             AND status = 'active' AND deleted_at IS NULL
           LIMIT 1`,
        )
        .get(organizationId, id);
      if (!other) throw new Error('企业至少需要保留一名可登录管理员');
    }

    database
      .prepare(
        `UPDATE accounts SET
           employee_id = NULL,
           username = ?,
           phone = NULL,
           feishu_open_id = NULL,
           password_hash = ?,
           name = '已删除账号',
           role = NULL,
           department = NULL,
           department_id = NULL,
           position_id = NULL,
           position_title = NULL,
           avatar_url = NULL,
           is_admin = 0,
           status = 'disabled',
           deleted_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
      )
      .run(
        `deleted_${id}`,
        store.createDeletionPasswordHash(),
        id,
        organizationId,
      );
    deleteAccountTagsInRepository(store, id, organizationId);
    database
      .prepare(
        `UPDATE auth_sessions SET revoked_at = datetime('now')
         WHERE account_id = ? AND revoked_at IS NULL`,
      )
      .run(id);
    if (current.employeeId) {
      database
        .prepare(
          `UPDATE employees SET status = 'offboarded', offboarded_at = datetime('now')
           WHERE id = ? AND organization_id = ?`,
        )
        .run(current.employeeId, organizationId);
    }
    store.logAudit(
      'account_delete',
      current.employeeId,
      `Account ${current.username} deleted by ${actorAccountId}`,
      organizationId,
    );
    database.exec('COMMIT');
    return { id, deleted: true };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
