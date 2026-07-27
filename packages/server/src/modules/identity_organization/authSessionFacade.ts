/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createAuthSessionInRepository,
  getAccountBySessionFromRepository,
  revokeAuthSessionInRepository,
  type AuthSessionAccountRow,
  type AuthSessionAccountView,
  type AuthSessionIssueResult,
  type AuthSessionRepositoryStore,
} from './authSessionRepository.js';

export interface AuthSessionFacade<
  TAccountView extends AuthSessionAccountView,
> {
  createAuthSession(accountId: string, ttlMs?: number): AuthSessionIssueResult;
  getAccountBySession(token: string): TAccountView | null;
  revokeAuthSession(token: string): void;
}

export function createAuthSessionFacade<
  TAccountView extends AuthSessionAccountView,
  TAccountRow extends AuthSessionAccountRow,
>(
  store: AuthSessionRepositoryStore<TAccountView, TAccountRow>,
): AuthSessionFacade<TAccountView> {
  return {
    createAuthSession(accountId, ttlMs) {
      return createAuthSessionInRepository(store, accountId, ttlMs);
    },
    getAccountBySession(token) {
      return getAccountBySessionFromRepository(store, token);
    },
    revokeAuthSession(token) {
      return revokeAuthSessionInRepository(store, token);
    },
  };
}
