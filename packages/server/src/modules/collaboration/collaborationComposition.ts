/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  Database,
  EncryptedFieldCipher,
  EncryptedObjectStore,
} from '../data_platform/index.js';
import { createDirectMessageFacade } from './directMessageFacade.js';
import { createE2eeFacade } from './e2eeRepository.js';
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
  fieldCipher?: EncryptedFieldCipher;
  attachmentObjectStore?: EncryptedObjectStore;
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
  const directMessageStore = {
    db: options.db,
    createId: options.createId,
    fieldCipher: options.fieldCipher,
    attachmentObjectStore: options.attachmentObjectStore,
    getActiveAccountInOrganization(
      accountId: string,
      organizationId: string,
    ) {
      const account = getActiveAccount(accountId, organizationId);
      return account ? { id: account.id, name: account.name } : null;
    },
  };
  const directMessages = createDirectMessageFacade(directMessageStore);
  const e2ee = createE2eeFacade(directMessageStore);
  const presence = createAccountPresenceFacade({
    db: options.db,
    now: options.now,
    isActiveAccountInOrganization: (accountId, organizationId) =>
      getActiveAccount(accountId, organizationId) !== null,
  });

  return {
    ...directMessages,
    ...e2ee,
    ...presence,
  };
}
