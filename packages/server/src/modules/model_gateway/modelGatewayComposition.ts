/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import { createModelUsageFacade } from './modelUsageFacade.js';
import type { ModelUsageRepositoryStore } from './modelUsageRepository.js';
import type {
  ModelUsageAccount,
  ModelUsageOrganization,
} from './modelUsageTypes.js';

export interface ModelGatewayCompositionOptions<
  TAccount extends ModelUsageAccount,
  TOrganization extends ModelUsageOrganization,
> {
  db(): Database;
  getAccount(accountId: string): TAccount | null;
  getOrganization(organizationId: string): TOrganization | null;
  listOrganizationAccounts(organizationId: string): TAccount[];
  createId(): string;
  onRecordedUsage?: ModelUsageRepositoryStore<TAccount, TOrganization>['onRecordedUsage'];
}

/** Builds tenant-scoped model metering around one stable usage ID policy. */
export function createModelGatewayComposition<
  TAccount extends ModelUsageAccount,
  TOrganization extends ModelUsageOrganization,
>(options: ModelGatewayCompositionOptions<TAccount, TOrganization>) {
  return createModelUsageFacade({
    db: options.db,
    getAccount: options.getAccount,
    getOrganization: options.getOrganization,
    listOrganizationAccounts: options.listOrganizationAccounts,
    createUsageId: () => `usage_${options.createId()}`,
    onRecordedUsage: options.onRecordedUsage,
  });
}
