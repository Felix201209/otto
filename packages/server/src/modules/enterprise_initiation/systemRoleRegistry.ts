/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 版本化系统角色注册表（SERVER-16）。
 *
 * 安全不变量：
 *  - 系统角色与权限集合只来自本注册表（代码拥有），外部开通 Payload 无法
 *    注入任意权限或任意角色；
 *  - CEO 角色只能由注册表授予且不可被 Payload 降级；
 *  - 每个角色带 schemaVersion，权限变更时递增版本，便于审计与迁移。
 *
 * 本文件为纯函数、无副作用，可完全脱离数据库单元测试。
 */

/**
 * 系统角色键。键语义与 accountLifecycle 的 roleMapping 对齐：
 *  - ceo           企业创始人 / 唯一最高管理员（首次登录入口目标账号）；
 *  - department_admin  默认管理部门负责人；
 *  - member        普通成员。
 */
export type SystemRoleKey = 'ceo' | 'department_admin' | 'member';

/** 一个系统角色的定义。 */
export interface SystemRoleDefinition {
  key: SystemRoleKey;
  /** 角色的稳定展示名。 */
  name: string;
  /** 该角色定义所属的注册表版本。权限变更必须递增。 */
  schemaVersion: number;
  /** 角色承载的权限键集合（versioned，见 SYSTEM_ROLES）。 */
  permissions: readonly string[];
  /** 是否为企业级管理角色（不可由普通 Payload 授予/降级）。 */
  administrative: boolean;
}

export const SYSTEM_ROLE_REGISTRY_VERSION = 1;

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    key: 'ceo',
    name: 'CEO（创始人）',
    schemaVersion: 1,
    permissions: [
      'organization.manage',
      'license.view',
      'department.manage',
      'member.manage',
      'role.assign',
      'data.export',
      'billing.view',
    ],
    administrative: true,
  },
  {
    key: 'department_admin',
    name: '部门管理员',
    schemaVersion: 1,
    permissions: [
      'member.view',
      'department.manage',
      'member.assign',
    ],
    administrative: true,
  },
  {
    key: 'member',
    name: '成员',
    schemaVersion: 1,
    permissions: [
      'member.view_self',
      'message.send',
      'knowledge.view',
    ],
    administrative: false,
  },
] as const;

const ROLE_BY_KEY: ReadonlyMap<SystemRoleKey, SystemRoleDefinition> = new Map(
  SYSTEM_ROLES.map((role) => [role.key, role]),
);

/** 按键取系统角色定义；未知键返回 null。 */
export function getSystemRole(key: string): SystemRoleDefinition | null {
  return ROLE_BY_KEY.get(key as SystemRoleKey) ?? null;
}

/**
 * 校验外部 Payload 请求的角色/权限不会越权。
 * 返回 { ok, reason }：仅允许注册表内已知角色，且 Payload 携带的权限
 * 必须是该角色自带权限的子集（Payload 不得新增任何权限）。
 */
export function validateRequestedRoleAssignment(input: {
  requestedRoleKey: string;
  requestedPermissions?: readonly string[];
  isCeo?: boolean;
}): { ok: true; role: SystemRoleDefinition } | { ok: false; reason: string } {
  const role = getSystemRole(input.requestedRoleKey);
  if (!role) {
    return { ok: false, reason: `unknown system role: ${input.requestedRoleKey}` };
  }
  // CEO 角色不接受任何外部权限覆盖（保证不被降级/越权）。
  if (role.key === 'ceo') {
    if (input.requestedPermissions && input.requestedPermissions.length > 0) {
      return {
        ok: false,
        reason: 'ceo role permissions are registry-owned and must not be overridden',
      };
    }
    return { ok: true, role };
  }
  // 非 CEO 角色：Payload 权限必须是注册表权限的子集。
  if (input.requestedPermissions && input.requestedPermissions.length > 0) {
    const allowed = new Set(role.permissions);
    for (const permission of input.requestedPermissions) {
      if (!allowed.has(permission)) {
        return {
          ok: false,
          reason: `permission not owned by role ${role.key}: ${permission}`,
        };
      }
    }
  }
  return { ok: true, role };
}
