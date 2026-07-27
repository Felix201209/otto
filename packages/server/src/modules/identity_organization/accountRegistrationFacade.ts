/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createPersonalRegisteredAccountInRepository,
  createSelfRegisteredAccountInRepository,
  joinOrganizationWithInviteInRepository,
  type AccountRegistrationOrganizationView,
  type AccountRegistrationRepositoryStore,
  type AccountRegistrationView,
  type CreatePersonalRegisteredAccountInput,
  type CreateSelfRegisteredAccountInput,
} from './accountRegistrationRepository.js';

export interface AccountRegistrationFacade<
  TAccountView extends AccountRegistrationView,
> {
  createSelfRegisteredAccount(
    input: CreateSelfRegisteredAccountInput,
  ): TAccountView;
  createPersonalRegisteredAccount(
    input: CreatePersonalRegisteredAccountInput,
  ): TAccountView;
  joinOrganizationWithInvite(
    accountId: string,
    inviteCode: string,
    now?: number,
  ): TAccountView;
}

export function createAccountRegistrationFacade<
  TAccountView extends AccountRegistrationView,
  TOrganizationView extends AccountRegistrationOrganizationView,
>(
  store: AccountRegistrationRepositoryStore<TAccountView, TOrganizationView>,
): AccountRegistrationFacade<TAccountView> {
  return {
    createSelfRegisteredAccount(input) {
      return createSelfRegisteredAccountInRepository(store, input);
    },
    createPersonalRegisteredAccount(input) {
      return createPersonalRegisteredAccountInRepository(store, input);
    },
    joinOrganizationWithInvite(accountId, inviteCode, now = store.now()) {
      return joinOrganizationWithInviteInRepository(
        store,
        accountId,
        inviteCode,
        now,
      );
    },
  };
}
