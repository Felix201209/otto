/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import type {
  AccountLifecycleView,
  CreateAccountInput,
} from './accountLifecycleRepository.js';

export type AccountRegistrationView = AccountLifecycleView;

export interface AccountRegistrationOrganizationView {
  id: string;
}

export interface CurrentRegistrationAssignment {
  department: string | null;
  departmentId: string | null;
  positionId: string | null;
  positionTitle: string | null;
  role: string;
  isAdmin: boolean;
}

export interface RegistrationInviteResolution<
  TOrganizationView extends AccountRegistrationOrganizationView,
> {
  organization: TOrganizationView;
  inviteId: string;
  defaultDepartment: string | null;
  departmentId: string | null;
  positionId: string | null;
  positionTitle: string | null;
  defaultRole: string | null;
}

export interface CreateSelfRegisteredAccountInput {
  organizationId: string;
  phone: string;
  name: string;
  password: string;
  department?: string | null;
  departmentId?: string | null;
  role?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
  organizationInviteId?: string | null;
}

export interface CreatePersonalRegisteredAccountInput {
  phone: string;
  name: string;
  password: string;
}

export interface AccountRegistrationRepositoryStore<
  TAccountView extends AccountRegistrationView,
  TOrganizationView extends AccountRegistrationOrganizationView,
> {
  db(): Database;
  now(): number;
  normalizePhone(phone: string): string;
  findAccountByPhone(phone: string): TAccountView | null;
  createId(prefix: 'emp'): string;
  createUsernameSuffix(): string;
  createPersonalSlugSuffix(): string;
  resolveAssignmentIdentity(
    database: Database,
    organizationId: string,
    input: {
      department?: string | null;
      departmentId?: string | null;
      positionId?: string | null;
      positionTitle?: string | null;
    },
  ): { departmentId: string | null; positionId: string | null };
  createEmployee(input: {
    id: string;
    organizationId: string;
    name: string;
    role?: string;
    department?: string;
    departmentId?: string;
    positionId?: string;
    positionTitle?: string;
    inviteCode?: string;
  }): unknown;
  createAccount(input: CreateAccountInput): TAccountView;
  createOrganization(input: { name: string; slug: string }): TOrganizationView;
  getAccount(id: string, organizationId?: string): TAccountView | null;
  resolveOrganizationInviteWithDefaults(
    code: string,
    now: number,
  ): RegistrationInviteResolution<TOrganizationView> | null;
  normalizeOrganizationInviteCode(code: string): string;
  replaceMigratedAccountTags(
    accountId: string,
    organizationId: string,
    tags: string[],
  ): void;
  logAudit(
    action: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
}

interface RegistrationDepartmentRow {
  id: string;
  name: string;
}

interface RegistrationPositionRow {
  id: string;
  department_id: string;
  title: string;
  role_mapping: 'member' | 'department_admin' | 'enterprise_admin';
}

export function resolveCurrentRegistrationAssignment(
  database: Database,
  organizationId: string,
  input: {
    departmentId: string | null;
    positionId: string | null;
    defaultRole: string | null;
  },
): CurrentRegistrationAssignment {
  const organization = database
    .prepare("SELECT 1 FROM organizations WHERE id = ? AND status = 'active'")
    .get(organizationId);
  if (!organization) throw new Error('企业不存在或已停用');

  const department = input.departmentId
    ? (database
        .prepare(
          `SELECT id, name FROM organization_departments
           WHERE id = ? AND organization_id = ?`,
        )
        .get(input.departmentId, organizationId) as
        RegistrationDepartmentRow | undefined)
    : undefined;
  if (input.departmentId && !department) throw new Error('部门不存在');
  if (input.positionId && !department) throw new Error('职位必须属于有效部门');

  const position = input.positionId
    ? (database
        .prepare(
          `SELECT id, department_id, title, role_mapping
           FROM organization_positions WHERE id = ? AND organization_id = ?`,
        )
        .get(input.positionId, organizationId) as
        RegistrationPositionRow | undefined)
    : undefined;
  if (input.positionId && !position) throw new Error('职位不存在');
  if (position && position.department_id !== department!.id) {
    throw new Error('职位与部门不一致');
  }

  const role =
    position?.role_mapping === 'enterprise_admin'
      ? '企业管理员'
      : position?.role_mapping === 'department_admin'
        ? '部门管理员'
        : position
          ? '成员'
          : input.defaultRole?.trim() || '成员';
  return {
    department: department?.name ?? null,
    departmentId: department?.id ?? null,
    positionId: position?.id ?? null,
    positionTitle: position?.title ?? null,
    role,
    isAdmin: position?.role_mapping === 'enterprise_admin',
  };
}

function duplicatePhoneError(): Error {
  return new Error('该手机号已注册，请直接登录');
}

export function createSelfRegisteredAccountInRepository<
  TAccountView extends AccountRegistrationView,
  TOrganizationView extends AccountRegistrationOrganizationView,
>(
  store: AccountRegistrationRepositoryStore<TAccountView, TOrganizationView>,
  input: CreateSelfRegisteredAccountInput,
): TAccountView {
  const normalized = store.normalizePhone(input.phone);
  if (store.findAccountByPhone(normalized)) throw duplicatePhoneError();

  const digits = normalized.slice(3);
  const database = store.db();
  database.exec('SAVEPOINT create_self_registered_account');
  try {
    let assignment: CurrentRegistrationAssignment;
    if (input.organizationInviteId) {
      const now = store.now();
      const invite = database
        .prepare(
          `SELECT department_id, position_id, default_role
           FROM organization_invites
           WHERE id = ? AND organization_id = ?
             AND revoked_at_ms IS NULL AND expires_at_ms > ?
             AND (max_uses IS NULL OR used_count < max_uses)`,
        )
        .get(input.organizationInviteId, input.organizationId, now) as
        | {
            department_id: string | null;
            position_id: string | null;
            default_role: string | null;
          }
        | undefined;
      if (!invite) {
        throw new Error('企业邀请码可用名额已用完，请联系管理员重新生成');
      }
      assignment = resolveCurrentRegistrationAssignment(
        database,
        input.organizationId,
        {
          departmentId: invite.department_id,
          positionId: invite.position_id,
          defaultRole: invite.default_role,
        },
      );
    } else {
      const requested = store.resolveAssignmentIdentity(
        database,
        input.organizationId,
        input,
      );
      assignment = resolveCurrentRegistrationAssignment(
        database,
        input.organizationId,
        {
          departmentId: requested.departmentId,
          positionId: requested.positionId,
          defaultRole: input.role ?? null,
        },
      );
    }

    const employeeId = store.createId('emp');
    store.createEmployee({
      id: employeeId,
      organizationId: input.organizationId,
      name: input.name,
      role: assignment.role,
      department: assignment.department || undefined,
      departmentId: assignment.departmentId || undefined,
      positionId: assignment.positionId || undefined,
      positionTitle: assignment.positionTitle || undefined,
    });
    const account = store.createAccount({
      organizationId: input.organizationId,
      accountType: 'enterprise',
      employeeId,
      username: `otto_${digits.slice(-4)}_${store.createUsernameSuffix()}`,
      password: input.password,
      name: input.name,
      phone: normalized,
      role: assignment.role,
      department: assignment.department,
      departmentId: assignment.departmentId,
      positionId: assignment.positionId,
      positionTitle: assignment.positionTitle,
      tags: ['普通成员'],
      isAdmin: assignment.isAdmin,
    });
    if (input.organizationInviteId) {
      const reserved = database
        .prepare(
          `UPDATE organization_invites
           SET used_count = used_count + 1
           WHERE id = ? AND organization_id = ?
             AND revoked_at_ms IS NULL AND expires_at_ms > ?
             AND (max_uses IS NULL OR used_count < max_uses)`,
        )
        .run(input.organizationInviteId, input.organizationId, store.now());
      if (Number(reserved.changes) !== 1) {
        throw new Error('企业邀请码可用名额已用完，请联系管理员重新生成');
      }
    }
    database.exec('RELEASE SAVEPOINT create_self_registered_account');
    return account;
  } catch (error) {
    database.exec('ROLLBACK TO SAVEPOINT create_self_registered_account');
    database.exec('RELEASE SAVEPOINT create_self_registered_account');
    if (store.findAccountByPhone(normalized)) throw duplicatePhoneError();
    throw error;
  }
}

export function createPersonalRegisteredAccountInRepository<
  TAccountView extends AccountRegistrationView,
  TOrganizationView extends AccountRegistrationOrganizationView,
>(
  store: AccountRegistrationRepositoryStore<TAccountView, TOrganizationView>,
  input: CreatePersonalRegisteredAccountInput,
): TAccountView {
  const normalized = store.normalizePhone(input.phone);
  if (store.findAccountByPhone(normalized)) throw duplicatePhoneError();
  const name = input.name.trim();
  if (!name) throw new Error('name required');

  const digits = normalized.slice(3);
  const database = store.db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const organization = store.createOrganization({
      name: `${name.slice(0, 60)}的个人空间`,
      slug: `personal-${store.createPersonalSlugSuffix()}`,
    });
    const account = store.createAccount({
      organizationId: organization.id,
      accountType: 'personal',
      username: `otto_${digits.slice(-4)}_${store.createUsernameSuffix()}`,
      password: input.password,
      name,
      phone: normalized,
      role: '个人用户',
      tags: [],
      isAdmin: false,
    });
    database.exec('COMMIT');
    return account;
  } catch (error) {
    database.exec('ROLLBACK');
    if (store.findAccountByPhone(normalized)) throw duplicatePhoneError();
    throw error;
  }
}

export function joinOrganizationWithInviteInRepository<
  TAccountView extends AccountRegistrationView,
  TOrganizationView extends AccountRegistrationOrganizationView,
>(
  store: AccountRegistrationRepositoryStore<TAccountView, TOrganizationView>,
  accountId: string,
  inviteCode: string,
  now: number,
): TAccountView {
  const database = store.db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = store.getAccount(accountId);
    if (!current) throw new Error('账号不存在或已失效');
    if (current.accountType !== 'personal') {
      throw new Error('只有个人版账号可加入企业');
    }
    const invite = store.resolveOrganizationInviteWithDefaults(inviteCode, now);
    if (!invite) throw new Error('企业邀请码无效、已过期或名额已用完');
    const assignment = resolveCurrentRegistrationAssignment(
      database,
      invite.organization.id,
      {
        departmentId: invite.departmentId,
        positionId: invite.positionId,
        defaultRole: invite.defaultRole,
      },
    );

    const employeeId = store.createId('emp');
    store.createEmployee({
      id: employeeId,
      organizationId: invite.organization.id,
      name: current.name,
      role: assignment.role,
      department: assignment.department || undefined,
      departmentId: assignment.departmentId || undefined,
      positionId: assignment.positionId || undefined,
      positionTitle: assignment.positionTitle || undefined,
      inviteCode: store.normalizeOrganizationInviteCode(inviteCode),
    });

    const reserved = database
      .prepare(
        `UPDATE organization_invites
         SET used_count = used_count + 1
         WHERE id = ? AND organization_id = ?
           AND revoked_at_ms IS NULL AND expires_at_ms > ?
           AND (max_uses IS NULL OR used_count < max_uses)`,
      )
      .run(invite.inviteId, invite.organization.id, now);
    if (Number(reserved.changes) !== 1) {
      throw new Error('企业邀请码无效、已过期或名额已用完');
    }

    const moved = database
      .prepare(
        `UPDATE accounts
         SET organization_id = ?, account_type = 'enterprise', employee_id = ?,
             role = ?, department = ?, department_id = ?, position_id = ?,
             position_title = ?, is_admin = ?, updated_at = datetime('now')
         WHERE id = ? AND organization_id = ? AND account_type = 'personal'
           AND deleted_at IS NULL AND status = 'active'`,
      )
      .run(
        invite.organization.id,
        employeeId,
        assignment.role,
        assignment.department,
        assignment.departmentId,
        assignment.positionId,
        assignment.positionTitle,
        assignment.isAdmin ? 1 : 0,
        current.id,
        current.organizationId,
      );
    if (Number(moved.changes) !== 1) {
      throw new Error('只有个人版账号可加入企业');
    }

    database
      .prepare(
        `UPDATE auth_sessions SET organization_id = ?
         WHERE account_id = ? AND revoked_at IS NULL`,
      )
      .run(invite.organization.id, current.id);
    store.replaceMigratedAccountTags(current.id, invite.organization.id, [
      '普通成员',
    ]);
    store.logAudit(
      'personal_account_join_organization',
      employeeId,
      `Personal account ${current.username} joined by organization invite`,
      invite.organization.id,
    );
    const upgraded = store.getAccount(current.id, invite.organization.id);
    if (!upgraded) throw new Error('企业账号升级失败');
    database.exec('COMMIT');
    return upgraded;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
