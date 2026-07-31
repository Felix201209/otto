/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import { createAccountLifecycleFacade } from './accountLifecycleFacade.js';
import type {
  AccountLifecycleRoleMapping,
  AccountLifecycleView,
} from './accountLifecycleRepository.js';
import { createAccountRegistrationFacade } from './accountRegistrationFacade.js';
import type {
  AccountRegistrationOrganizationView,
  RegistrationInviteResolution,
} from './accountRegistrationRepository.js';
import type {
  AssignmentIdentity,
  AssignmentIdentityInput,
} from './assignmentIdentityTypes.js';
import { createOrganizationProvisioningFacade } from './organizationProvisioningFacade.js';
import type { OrganizationProvisioningOrganizationView } from './organizationProvisioningRepository.js';

export interface AccountMutationEmployeeInput {
  id: string;
  organizationId: string;
  name: string;
  role?: string;
  department?: string;
  departmentId?: string;
  positionId?: string;
  positionTitle?: string;
  inviteCode?: string;
}

export interface AccountMutationCompositionOptions<
  TAccountView extends AccountLifecycleView,
  TOrganizationView extends OrganizationProvisioningOrganizationView &
    AccountRegistrationOrganizationView,
  TInviteView,
> {
  db(): Database;
  defaultOrganizationId: string;
  now(): number;
  organizationExists(organizationId: string): boolean;
  normalizeUsername(username: string): string;
  normalizePhone(phone: string): string;
  normalizeOptionalPhone(value: string | null | undefined): string | null;
  normalizeOptionalFeishuOpenId(
    value: string | null | undefined,
  ): string | null;
  normalizeOptionalAvatarUrl(value: string | null | undefined): string | null;
  assertPassword(password: string): void;
  hashPassword(password: string): string;
  createAccountEntityId(prefix: 'acc' | 'emp'): string;
  createDeletionPasswordHash(): string;
  createOrganizationId(): string;
  createInviteSecret(): string;
  createDefaultSlugSuffix(): string;
  createUsernameSuffix(): string;
  createPersonalSlugSuffix(): string;
  resolveAssignmentIdentity(
    database: Database,
    organizationId: string,
    input: AssignmentIdentityInput,
  ): AssignmentIdentity;
  getPositionRoleMapping(
    database: Database,
    organizationId: string,
    positionId: string,
  ): AccountLifecycleRoleMapping | null;
  createEmployee(input: AccountMutationEmployeeInput): unknown;
  getAccount(id: string, organizationId?: string): TAccountView | null;
  findAccountByPhone(phone: string): TAccountView | null;
  getOrganization(id: string): TOrganizationView | null;
  issueOrganizationInvite(
    organizationId: string,
    now: number,
    createdByAccountId: string,
  ): TInviteView;
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
  audit(
    action: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
}

/** Builds account writes, tenant provisioning and registration in dependency order. */
export function createAccountMutationComposition<
  TAccountView extends AccountLifecycleView,
  TOrganizationView extends OrganizationProvisioningOrganizationView &
    AccountRegistrationOrganizationView,
  TInviteView,
>(
  options: AccountMutationCompositionOptions<
    TAccountView,
    TOrganizationView,
    TInviteView
  >,
) {
  const accountLifecycle = createAccountLifecycleFacade<TAccountView>({
    db: options.db,
    defaultOrganizationId: options.defaultOrganizationId,
    organizationExists: options.organizationExists,
    normalizeUsername: options.normalizeUsername,
    normalizeOptionalPhone: options.normalizeOptionalPhone,
    normalizeOptionalFeishuOpenId: options.normalizeOptionalFeishuOpenId,
    normalizeOptionalAvatarUrl: options.normalizeOptionalAvatarUrl,
    assertPassword: options.assertPassword,
    hashPassword: options.hashPassword,
    createId: options.createAccountEntityId,
    createDeletionPasswordHash: options.createDeletionPasswordHash,
    resolveAssignment(database, organizationId, input) {
      const assignment = options.resolveAssignmentIdentity(
        database,
        organizationId,
        input,
      );
      return {
        ...assignment,
        roleMapping: assignment.positionId
          ? options.getPositionRoleMapping(
              database,
              organizationId,
              assignment.positionId,
            )
          : null,
      };
    },
    createEmployee: options.createEmployee,
    getAccount: options.getAccount,
    logAudit: options.audit,
  });

  const organizationProvisioning = createOrganizationProvisioningFacade<
    TOrganizationView,
    TAccountView,
    TInviteView
  >({
    db: options.db,
    now: options.now,
    createOrganizationId: options.createOrganizationId,
    createInviteSecret: options.createInviteSecret,
    createDefaultSlugSuffix: options.createDefaultSlugSuffix,
    getOrganization: options.getOrganization,
    createAccount: accountLifecycle.createAccount,
    issueOrganizationInvite: options.issueOrganizationInvite,
    logAudit: options.audit,
  });

  const accountRegistration = createAccountRegistrationFacade<
    TAccountView,
    TOrganizationView
  >({
    db: options.db,
    now: options.now,
    normalizePhone: options.normalizePhone,
    findAccountByPhone: options.findAccountByPhone,
    createId: (_prefix) => options.createAccountEntityId('emp'),
    createUsernameSuffix: options.createUsernameSuffix,
    createPersonalSlugSuffix: options.createPersonalSlugSuffix,
    resolveAssignmentIdentity: options.resolveAssignmentIdentity,
    createEmployee: options.createEmployee,
    createAccount: accountLifecycle.createAccount,
    createOrganization: organizationProvisioning.createOrganization,
    getAccount: options.getAccount,
    resolveOrganizationInviteWithDefaults:
      options.resolveOrganizationInviteWithDefaults,
    normalizeOrganizationInviteCode: options.normalizeOrganizationInviteCode,
    replaceMigratedAccountTags: options.replaceMigratedAccountTags,
    logAudit: options.audit,
  });

  return {
    ...accountLifecycle,
    ...organizationProvisioning,
    ...accountRegistration,
  };
}
