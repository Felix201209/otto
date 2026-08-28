/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  getOrganizationUsageSummaryFromRepository,
  getPersonalTokenUsageProfileFromRepository,
  recordModelUsageInRepository,
  type ModelUsageRepositoryStore,
} from './modelUsageRepository.js';
import type {
  ModelUsageAccount,
  ModelUsageOrganization,
  RecordModelUsageInput,
} from './modelUsageTypes.js';

export function createModelUsageFacade<
  TAccount extends ModelUsageAccount,
  TOrganization extends ModelUsageOrganization,
>(store: ModelUsageRepositoryStore<TAccount, TOrganization>) {
  return {
    recordTokenUsage(input: RecordModelUsageInput) {
      return recordModelUsageInRepository(store, input);
    },
    getOrganizationUsageSummary(organizationId: string, periodDays = 30) {
      return getOrganizationUsageSummaryFromRepository(
        store,
        organizationId,
        periodDays,
      );
    },
    getPersonalTokenUsageProfile(accountId: string, periodDays = 30) {
      return getPersonalTokenUsageProfileFromRepository(store, accountId, periodDays);
    },
  };
}
