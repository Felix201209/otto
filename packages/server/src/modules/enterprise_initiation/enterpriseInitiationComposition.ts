/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '../data_platform/index.js';
import {
  executeEnterpriseInitiationInRepository,
  type EnterpriseInitiationStore,
} from './enterpriseInitiationRepository.js';
import {
  createFirstLoginTokenInRepository,
  redeemFirstLoginTokenInRepository,
  revokeFirstLoginTokens,
  type FirstLoginPurpose,
} from './firstLoginToken.js';
import type {
  EnterpriseInitiationCommand,
  EnterpriseInitiationResult,
} from './enterpriseInitiationType.js';

export interface EnterpriseInitiationCompositionDeps {
  db(): Database;
  now?(): number;
  resolveOrganizationSlug?(name: string, requestedSlug?: string): string;
  assertAccountIdentifierAvailable?(
    organizationId: string,
    username: string,
    phone: string | null,
  ): void;
}

export function createEnterpriseInitiationComposition(
  dependencies: EnterpriseInitiationCompositionDeps,
) {
  const now = dependencies.now ?? Date.now;
  const store: EnterpriseInitiationStore = {
    db: dependencies.db,
    now,
    createOrganizationId: () => `org_${randomUUID()}`,
    createAccountId: () => `acct_${randomUUID()}`,
    createDepartmentId: () => `dept_${randomUUID()}`,
    createDeploymentBindingId: () => `binding_${randomUUID()}`,
    createTokenId: () => `flt_${randomUUID()}`,
    resolveOrganizationSlug:
      dependencies.resolveOrganizationSlug ??
      ((name: string) => name.trim().toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '-')),
    assertAccountIdentifierAvailable:
      dependencies.assertAccountIdentifierAvailable ?? (() => {}),
  };

  return {
    /** 原子、幂等地开通一个企业（企业 + CEO + 默认部门 + 系统角色绑定 + 首次登录令牌）。 */
    executeInitiation(command: EnterpriseInitiationCommand): EnterpriseInitiationResult {
      return executeEnterpriseInitiationInRepository(store, command);
    },
    /** 核销首次登录令牌（用于设置密码）。 */
    redeemFirstLoginToken(token: string, purpose: FirstLoginPurpose) {
      return redeemFirstLoginTokenInRepository(store, token, purpose);
    },
    /** 撤销某账号某目的的未使用令牌（管理员邮箱变更/重新签发）。 */
    revokeFirstLoginTokens(accountId: string, purpose: FirstLoginPurpose) {
      return revokeFirstLoginTokens(store, accountId, purpose);
    },
    /** 签发一个新的首次登录令牌（重新签发语义，自动撤销旧令牌）。 */
    issueFirstLoginToken(input: {
      organizationId: string;
      accountId: string;
      purpose: FirstLoginPurpose;
      ttlMs: number;
    }) {
      return createFirstLoginTokenInRepository(store, {
        ...input,
        now: now(),
      });
    },
  };
}

export type EnterpriseInitiationComposition = ReturnType<
  typeof createEnterpriseInitiationComposition
>;
