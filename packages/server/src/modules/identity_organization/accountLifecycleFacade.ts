/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createAccountInRepository,
  deleteAccountInRepository,
  updateAccountInRepository,
  type AccountLifecycleRepositoryStore,
  type AccountLifecycleView,
  type CreateAccountInput,
  type UpdateAccountPatch,
} from './accountLifecycleRepository.js';

export interface AccountLifecycleFacade<
  TAccountView extends AccountLifecycleView,
> {
  createAccount(input: CreateAccountInput): TAccountView;
  updateAccount(
    id: string,
    patch: UpdateAccountPatch,
    organizationId?: string,
  ): TAccountView;
  deleteAccount(
    id: string,
    organizationId: string,
    actorAccountId: string,
  ): { id: string; deleted: true };
}

export function createAccountLifecycleFacade<
  TAccountView extends AccountLifecycleView,
>(
  store: AccountLifecycleRepositoryStore<TAccountView>,
): AccountLifecycleFacade<TAccountView> {
  return {
    createAccount(input) {
      return createAccountInRepository(store, input);
    },
    updateAccount(id, patch, organizationId) {
      return updateAccountInRepository(store, id, patch, organizationId);
    },
    deleteAccount(id, organizationId, actorAccountId) {
      return deleteAccountInRepository(
        store,
        id,
        organizationId,
        actorAccountId,
      );
    },
  };
}
