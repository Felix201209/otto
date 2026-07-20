/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { EnterpriseAccount } from '../../preload/index.js';
import {
  getEnterpriseAgentProfiles,
  getPersonalAgentProfiles,
  type AgentProfile,
} from '../agents/departmentAgents.js';

/**
 * 客户端只接受中心服务签发的管理员布尔值，不解析可编辑的 role / tags 文本。
 * 这两个角色正好对应服务端允许的企业基础 Agent。
 */
export type CentralEnterpriseRole = 'company_admin' | 'member';

export interface CentralEnterpriseIdentity {
  edition: 'personal' | 'enterprise';
  role: CentralEnterpriseRole;
  identityLabel: string;
  profiles: readonly AgentProfile[];
}

export function resolveCentralEnterpriseIdentity(
  account: EnterpriseAccount,
): CentralEnterpriseIdentity {
  if (account.accountType === 'personal') {
    return {
      edition: 'personal',
      role: 'member',
      identityLabel: `${account.name} · 个人空间`,
      profiles: getPersonalAgentProfiles(),
    };
  }
  const role: CentralEnterpriseRole = account.isAdmin ? 'company_admin' : 'member';
  const identityLabel = [
    account.organizationName,
    account.department,
    account.positionTitle,
    account.isAdmin ? '企业管理员' : '企业成员',
  ].filter((value): value is string => Boolean(value?.trim())).join(' · ');

  return {
    edition: 'enterprise',
    role,
    identityLabel,
    profiles: getEnterpriseAgentProfiles(role, null),
  };
}
