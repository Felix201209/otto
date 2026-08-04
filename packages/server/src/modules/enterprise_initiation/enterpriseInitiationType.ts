/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { SystemRoleKey } from './systemRoleRegistry.js';

/** 开通指令的授权输入（由调用方提供经验证的开通参数，未来由 CONTROL-12 签名队列喂入）。 */
export interface EnterpriseInitiationCommand {
  /** CONTROL 部署标识。 */
  deploymentId: string;
  /** 指令唯一标识。 */
  commandId: string;
  /** 幂等键（与 deploymentId 一起构成唯一初始化键）。 */
  idempotencyKey: string;
  /** 指令版本号，用于拒绝越界 schemaVersion。 */
  schemaVersion: number;
  organization: {
    name: string;
    slug?: string;
  };
  ceo: {
    username: string;
    name: string;
    phone?: string | null;
  };
  /** 企业名称可直接显示；此处不需要额外的规范化唯一标识，由系统生成并在入库时校验。 */
  defaultDepartmentName: string;
  /** 套餐模块映射（来自已核验 License），非任意权限。 */
  modules?: readonly string[];
}

/** 初始化过程中的系统角色绑定视图。 */
export interface SystemRoleAssignmentView {
  accountId: string;
  organizationId: string;
  roleKey: SystemRoleKey;
  roleName: string;
  schemaVersion: number;
}

/** 原子初始化结果的对外视图（不包含任何秘密）。 */
export interface EnterpriseInitiationResult {
  deploymentId: string;
  commandId: string;
  idempotencyKey: string;
  organizationId: string;
  ceoAccountId: string;
  defaultDepartmentId: string | null;
  roleAssignments: SystemRoleAssignmentView[];
  /** true 表示本次为重复指令，返回首次执行的结果。 */
  replayed: boolean;
  /** 首次登录令牌（单次、短时、绑定账号/目的；仅在此处一次性暴露）。 */
  firstLoginToken: {
    tokenHashPrefix: string;
    expiresAt: string;
    purpose: 'ceo_password_set';
  };
}
