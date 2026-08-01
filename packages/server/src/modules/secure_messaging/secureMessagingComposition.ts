/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import { E2EE_CAPABILITY_STATUS } from './e2eeReleasePolicy.js';
import { createSecureMessagingFacade } from './secureMessagingFacade.js';

export interface SecureMessagingCompositionAccount {
  id: string;
  status: 'active' | 'disabled';
}

export interface SecureMessagingCompositionOptions<
  TAccount extends SecureMessagingCompositionAccount,
> {
  db(): Database;
  now(): number;
  getAccount(accountId: string, organizationId: string): TAccount | null;
}

export function createSecureMessagingComposition<
  TAccount extends SecureMessagingCompositionAccount,
>(options: SecureMessagingCompositionOptions<TAccount>) {
  return {
    ...createSecureMessagingFacade({
      db: options.db,
      now: options.now,
      isActiveAccountInOrganization(accountId, organizationId) {
        return options.getAccount(accountId, organizationId)?.status === 'active';
      },
    }),
    getE2eeCapabilityStatus: () => ({ ...E2EE_CAPABILITY_STATUS }),
  };
}
