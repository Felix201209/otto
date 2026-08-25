/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

/** 中心组织树经 Electron main 规整后传给本机可信控制面的成员形状。 */
export interface AuthenticatedEnterpriseOrganizationMemberInput {
  id: string;
  username: string;
  name: string;
  role: string | null;
  department: string | null;
  positionId: string | null;
  positionTitle: string | null;
  isAdmin: boolean;
  status: 'active' | 'disabled';
}

/**
 * 企业服务器代当前账号换取的短期模型网关凭据。
 *
 * 该对象只通过受保护的本机 controlToken 通道进入 OttoServer 内存；不得写入
 * renderer 快照、会话文件或日志。企业登录 token 与部署 License leaseToken
 * 永远不会进入本机 Agent 运行时。
 */
export interface AuthenticatedManagedModelGatewayInput {
  baseUrl: string;
  accessToken: string;
  expiresAt: string;
  allowedModels: string[];
}

/** Electron main 传给本机 OttoServer 可信控制面的最小中心账号形状。 */
export interface AuthenticatedEnterpriseAccountInput {
  id: string;
  organizationId: string;
  organizationName?: string;
  name: string;
  isAdmin: boolean;
  role?: string | null;
  tags?: string[];
  department?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
  /** 仅来自中心 `/enterprise/organization/view`；读取失败时省略，绝不本机臆造。 */
  organizationMembers?: AuthenticatedEnterpriseOrganizationMemberInput[];
  /** 中心身份短租约；本机 server 到期后必须 fail closed。 */
  leaseExpiresAt: string;
  /** 可选托管模型短凭据；旧企业服务器不支持时省略，BYOK 仍可正常使用。 */
  managedModelGateway?: AuthenticatedManagedModelGatewayInput;
}
