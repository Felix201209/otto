/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  authenticateAccountInRepository,
  findAccountByPhoneFromRepository,
  findActiveAccountByPhoneFromRepository,
  getAccountFromRepository,
  listAccountsFromRepository,
  type AccountDirectoryRepositoryStore,
  type AccountDirectoryRow,
  type AccountDirectoryView,
} from './accountDirectoryRepository.js';

export interface AccountDirectoryFacade<
  TAccountView extends AccountDirectoryView,
> {
  getAccount(id: string, organizationId?: string): TAccountView | null;
  listAccounts(organizationId?: string): TAccountView[];
  authenticateAccount(
    identifier: string,
    password: string,
  ): TAccountView | null;
  findAccountByPhone(phone: string): TAccountView | null;
  findActiveAccountByPhone(phone: string): TAccountView | null;
}

export function createAccountDirectoryFacade<
  TAccountView extends AccountDirectoryView,
  TAccountRow extends AccountDirectoryRow,
>(
  store: AccountDirectoryRepositoryStore<TAccountView, TAccountRow>,
): AccountDirectoryFacade<TAccountView> {
  return {
    getAccount(id, organizationId) {
      return getAccountFromRepository(store, id, organizationId);
    },
    listAccounts(organizationId) {
      return listAccountsFromRepository(store, organizationId);
    },
    authenticateAccount(identifier, password) {
      return authenticateAccountInRepository(store, identifier, password);
    },
    findAccountByPhone(phone) {
      return findAccountByPhoneFromRepository(store, phone);
    },
    findActiveAccountByPhone(phone) {
      return findActiveAccountByPhoneFromRepository(store, phone);
    },
  };
}
