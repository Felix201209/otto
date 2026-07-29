/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import { createDirectMessageFacade } from './directMessageFacade.js';
import { createAccountPresenceFacade } from './presenceFacade.js';

export interface CollaborationCompositionAccount {
  id: string;
  name: string;
  status: 'active' | 'disabled';
}

export interface CollaborationCompositionOptions<
  TAccount extends CollaborationCompositionAccount,
> {
  db(): Database;
  now(): number;
  createId(): string;
  getAccount(accountId: string, organizationId: string): TAccount | null;
}

/** Builds messaging and presence around one tenant-scoped active-account rule. */
export function createCollaborationComposition<
  TAccount extends CollaborationCompositionAccount,
>(options: CollaborationCompositionOptions<TAccount>) {
  const getActiveAccount = (accountId: string, organizationId: string) => {
    const account = options.getAccount(accountId, organizationId);
    return account?.status === 'active' ? account : null;
  };
  const directMessages = createDirectMessageFacade({
    db: options.db,
    createId: options.createId,
    getActiveAccountInOrganization(accountId, organizationId) {
      const account = getActiveAccount(accountId, organizationId);
      return account ? { id: account.id, name: account.name } : null;
    },
  });
  const presence = createAccountPresenceFacade({
    db: options.db,
    now: options.now,
    isActiveAccountInOrganization: (accountId, organizationId) =>
      getActiveAccount(accountId, organizationId) !== null,
  });

  return {
    ...directMessages,
    ...presence,
  };
}
