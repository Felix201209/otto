/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import type { AccountSyncEncryptionKeyProvider } from './accountSyncCrypto.js';
import { createAccountSyncFacade } from './accountSyncFacade.js';
import { createWorklogFacade } from './worklogFacade.js';
import { listWorklogsForBackup as listWorklogsForBackupFromRepository } from './worklogRepository.js';
import type {
  PersonalWorklogEmployee,
  PersonalWorklogOrganization,
} from './worklogTypes.js';

export interface PersonalIntelligenceCompositionAccount {
  id: string;
  organizationId: string;
  status: 'active' | 'disabled';
}

export interface PersonalIntelligenceCompositionOptions<
  TAccount extends PersonalIntelligenceCompositionAccount,
  TEmployee extends PersonalWorklogEmployee,
  TOrganization extends PersonalWorklogOrganization,
> {
  db(): Database;
  defaultOrganizationId: string;
  keyProvider: AccountSyncEncryptionKeyProvider;
  getAccount(accountId: string): TAccount | null;
  getOrganization(organizationId: string): TOrganization | null;
  getEmployee(employeeId: string, organizationId: string): TEmployee | null;
  listActiveEmployees(
    department: string | undefined,
    organizationId: string,
  ): TEmployee[];
  audit(
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
  now?(): number;
}

/** Builds account restoration and worklogs around one active identity rule. */
export function createPersonalIntelligenceComposition<
  TAccount extends PersonalIntelligenceCompositionAccount,
  TEmployee extends PersonalWorklogEmployee,
  TOrganization extends PersonalWorklogOrganization,
>(
  options: PersonalIntelligenceCompositionOptions<
    TAccount,
    TEmployee,
    TOrganization
  >,
) {
  const accountSync = createAccountSyncFacade({
    db: options.db,
    keyProvider: options.keyProvider,
    now: options.now,
    resolveActiveIdentity(accountId) {
      const account = options.getAccount(accountId);
      if (account?.status !== 'active') return null;
      const organization = options.getOrganization(account.organizationId);
      if (organization?.status !== 'active') return null;
      return {
        accountId: account.id,
        organizationId: account.organizationId,
      };
    },
  });
  const worklogs = createWorklogFacade<TEmployee, TOrganization>({
    db: options.db,
    defaultOrganizationId: options.defaultOrganizationId,
    getOrganization: options.getOrganization,
    getEmployee: options.getEmployee,
    listActiveEmployees: options.listActiveEmployees,
    audit: options.audit,
  });

  return {
    ...accountSync,
    ...worklogs,
    listWorklogsForBackup: (organizationId: string) =>
      listWorklogsForBackupFromRepository({ db: options.db }, organizationId),
  };
}
