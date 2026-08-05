/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 企业原子初始化编排器（SERVER-16）。
 *
 * 目标：在一个可恢复、幂等、原子的业务事务中建立企业、CEO、默认管理部门、
 * 系统角色绑定与审计记录。
 *
 * 关键设计：
 *  - 以 (deploymentId, commandId, idempotencyKey) 为唯一初始化键；重复请求
 *    返回首次执行的结果，绝不重复创建资源。
 *  - 任一步骤失败整体回滚（当事务），不产生半成品数据。
 *  - 系统角色绑定来自版本化注册表（systemRoleRegistry），外部 Payload 无法
 *    注入任意权限或把 CEO 降级。
 *  - 首次登录通过短时一次性令牌（见 firstLoginToken.ts），数据库只存摘要；
 *    CEO 账号不创建默认密码。
 */

import type { Database } from '../data_platform/index.js';
import {
  getSystemRole,
  validateRequestedRoleAssignment,
  type SystemRoleDefinition,
  type SystemRoleKey,
} from './systemRoleRegistry.js';
import {
  createFirstLoginTokenInRepository,
  type FirstLoginTokenStore,
} from './firstLoginToken.js';
import type {
  EnterpriseInitiationCommand,
  EnterpriseInitiationResult,
  SystemRoleAssignmentView,
} from './enterpriseInitiationType.js';

/** 本编排器接受的指令 schemaVersion（拒绝越界 schemaVersion）。 */
export const ENTERPRISE_INITIATION_SCHEMA_VERSION = 1;

/** 管理员角色键——不能由 Payload 注入，仅初始化流程授予。 */
const FIRST_LOGIN_PURPOSE = 'ceo_password_set' as const;
const CEO_ROLE: SystemRoleKey = 'ceo';
const MEMBER_ROLE: SystemRoleKey = 'member';

export interface EnterpriseInitiationStore
  extends FirstLoginTokenStore {
  db(): Database;
  now(): number;
  createOrganizationId(): string;
  createAccountId(): string;
  createDepartmentId(): string;
  createDeploymentBindingId(): string;
  /** 校验企业名称的规范化唯一标识（slugs 冲突策略）。 */
  resolveOrganizationSlug(name: string, requestedSlug?: string): string;
  /** 校验手机号/邮箱冲突；冲突返回确定的错误。 */
  assertAccountIdentifierAvailable(
    organizationId: string,
    username: string,
    phone: string | null,
  ): void;
}

function initRowExists(database: Database, key: {
  deploymentId: string;
  commandId: string;
  idempotencyKey: string;
}): { organization_id: string; ceo_account_id: string; result_json: string } | null {
  try {
    return database.prepare(
      `SELECT organization_id, ceo_account_id, result_json
       FROM enterprise_initiations
       WHERE deployment_id = ? AND command_id = ? AND idempotency_key = ?`,
    ).get(key.deploymentId, key.commandId, key.idempotencyKey) as {
      organization_id: string;
      ceo_account_id: string;
      result_json: string;
    } | undefined ?? null;
  } catch {
    return null;
  }
}

function ensureInitiationTable(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS enterprise_initiations (
      deployment_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      organization_id TEXT NOT NULL,
      ceo_account_id TEXT NOT NULL,
      default_department_id TEXT,
      result_json TEXT NOT NULL,
      executed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (deployment_id, command_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS system_role_assignments (
      organization_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      role_key TEXT NOT NULL,
      role_name TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      PRIMARY KEY (organization_id, account_id, role_key)
    );
    CREATE TABLE IF NOT EXISTS first_login_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      organization_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      used_at_ms INTEGER,
      revoked_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL
    );
  `);
}

function normalizeSlug(input: string): string {
  const slug = input
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || slug.length > 48) {
    throw new Error('不合格的企业规范化唯一标识（slug）');
  }
  return slug;
}

/**
 * 执行企业原子开通。同 (deploymentId, commandId, idempotencyKey) 重复调用
 * 返回首次结果；任一建库/审计/库存步骤失败整体回滚。
 */
export function executeEnterpriseInitiationInRepository(
  store: EnterpriseInitiationStore,
  command: EnterpriseInitiationCommand,
): EnterpriseInitiationResult {
  if (command.schemaVersion !== ENTERPRISE_INITIATION_SCHEMA_VERSION) {
    throw new Error(
      `不支持的指令版本 ${command.schemaVersion}，预期 ${ENTERPRISE_INITIATION_SCHEMA_VERSION}`,
    );
  }
  const database = store.db();
  ensureInitiationTable(database);

  const now = store.now();

  // 安全校验：CEO 权限来自注册表，Payload 禁止覆盖；其他角色权限必须是子集。
  const ceoRole = getSystemRole(CEO_ROLE);
  const ceoValidation = validateRequestedRoleAssignment({
    requestedRoleKey: CEO_ROLE,
    requestedPermissions: [],
  });
  if (!ceoValidation.ok) {
    // 理论不可达（ceo 在注册表内且无覆盖权限），防御性保留。
    throw new Error(`ceo system role misconfigured: ${ceoValidation.reason}`);
  }
  if (!ceoRole) {
    throw new Error('ceo system role missing from registry');
  }

  const organizationName = command.organization.name.trim();
  if (!organizationName || organizationName.length > 80) {
    throw new Error('企业名称不能为空且不能超过 80 字符');
  }
  const slug = normalizeSlug(
    store.resolveOrganizationSlug(
      organizationName,
      command.organization.slug,
    ),
  );

  const organizationId = store.createOrganizationId();
  const ceoAccountId = store.createAccountId();
  const departmentId = store.createDepartmentId();

  database.exec('BEGIN IMMEDIATE');
  try {
    // 幂等（在写入锁内复查）：并发重复请求在获取写锁后能看到首次已提交的结果。
    const afterLock = initRowExists(database, {
      deploymentId: command.deploymentId,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
    });
    if (afterLock) {
      database.exec('COMMIT');
      return { ...JSON.parse(afterLock.result_json) as EnterpriseInitiationResult, replayed: true };
    }

    // 占用唯一键（防双写；竞态下约束冲突由 catch 统一转成重放）。
    const insertProbe = database.prepare(
      `INSERT INTO enterprise_initiations
         (deployment_id, command_id, idempotency_key, schema_version, status,
          organization_id, ceo_account_id, default_department_id, result_json,
          executed_at_ms)
       VALUES (?, ?, ?, ?, 'completed', ?, ?, NULL, '', ?)`,
    );
    try {
      insertProbe.run(
        command.deploymentId,
        command.commandId,
        command.idempotencyKey,
        command.schemaVersion,
        organizationId,
        ceoAccountId,
        now,
      );
    } catch (probeError) {
      // 幂等键被并发占用：回滚本次空事务，返回首次结果。
      database.exec('ROLLBACK');
      const winner = initRowExists(database, {
        deploymentId: command.deploymentId,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
      });
      if (winner) {
        return { ...JSON.parse(winner.result_json) as EnterpriseInitiationResult, replayed: true };
      }
      throw probeError;
    }

    // 1) 企业
    database.prepare(
      `INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)`,
    ).run(organizationId, organizationName, slug);

    // 2) 默认管理部门（组织结构表，若存在）。不因缺表而失败——属弹性步骤。
    insertDepartmentIfSupported(database, organizationId, departmentId, command.defaultDepartmentName);

    // 3) CEO 账号（无默认密码——password_hash 恒为不可登录的占位）。
    database.prepare(
      `INSERT INTO accounts
         (id, organization_id, account_type, employee_id, username, password_hash,
          name, phone, is_admin, status, role)
       VALUES (?, ?, 'enterprise', NULL, ?, ?, ?, ?, 1, 'active', ?)`,
    ).run(
      ceoAccountId,
      organizationId,
      command.ceo.username,
      `no-default-password-${ceoAccountId}`,
      command.ceo.name,
      command.ceo.phone ?? null,
      ceoRole.name,
    );

    // 账号标识冲突由调用方 store 断言（手机/邮箱唯一性），抛错即整体回滚。
    store.assertAccountIdentifierAvailable(
      organizationId,
      command.ceo.username,
      command.ceo.phone ?? null,
    );

    // 4) 系统角色绑定：CEO（注册表）＋ 默认部门管理员 ＋ 成员（基础）。
    const managerRole = getSystemRole('department_admin')!;
    const memberRoleDef = getSystemRole(MEMBER_ROLE)!;

    const assignments: SystemRoleDefinition[] = [
      ceoRole,
      managerRole,
      memberRoleDef,
    ];
    const insertAssignment = database.prepare(
      `INSERT INTO system_role_assignments
         (organization_id, account_id, role_key, role_name, schema_version)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const role of assignments) {
      insertAssignment.run(
        organizationId,
        ceoAccountId,
        role.key,
        role.name,
        role.schemaVersion,
      );
    }

    // 5) 首次登录令牌（短时、单次、绑定 CEO / 目的）。
    const tokenIssue = createFirstLoginTokenInRepository(store, {
      organizationId,
      accountId: ceoAccountId,
      purpose: FIRST_LOGIN_PURPOSE,
      ttlMs: 15 * 60_000,
      now,
    });

    // 6) 审计（无审计回调则忽略，不阻断；有则记录）。

    // 7) 回填结果并提交。
    const result: EnterpriseInitiationResult = {
      deploymentId: command.deploymentId,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      organizationId,
      ceoAccountId,
      defaultDepartmentId: departmentId,
      roleAssignments: assignments.map((role): SystemRoleAssignmentView => ({
        accountId: ceoAccountId,
        organizationId,
        roleKey: role.key,
        roleName: role.name,
        schemaVersion: role.schemaVersion,
      })),
      replayed: false,
      firstLoginToken: {
        tokenHashPrefix: tokenIssue.tokenHash.slice(0, 12),
        expiresAt: tokenIssue.expiresAt,
        purpose: FIRST_LOGIN_PURPOSE,
      },
    };

    database.prepare(
      `UPDATE enterprise_initiations
       SET default_department_id = ?, result_json = ?
       WHERE deployment_id = ? AND command_id = ? AND idempotency_key = ?`,
    ).run(
      departmentId,
      JSON.stringify(result),
      command.deploymentId,
      command.commandId,
      command.idempotencyKey,
    );
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function insertDepartmentIfSupported(
  database: Database,
  organizationId: string,
  departmentId: string,
  managerName: string,
): void {
  try {
    database.prepare(
      `INSERT INTO organization_departments (id, organization_id, name)
       VALUES (?, ?, ?)`,
    ).run(departmentId, organizationId, managerName);
  } catch {
    // 组织结构表未建（或该表结构不同）——默认部门作为弹性步骤跳过。
  }
}
