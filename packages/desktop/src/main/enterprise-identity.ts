/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

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
  /** 中心身份短租约；本机 server 到期后必须 fail closed。 */
  leaseExpiresAt: string;
}
