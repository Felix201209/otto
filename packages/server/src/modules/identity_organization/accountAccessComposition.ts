/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import { createAccountDirectoryFacade } from './accountDirectoryFacade.js';
import type {
  AccountDirectoryRow,
  AccountDirectoryView,
} from './accountDirectoryRepository.js';
import { createAuthSessionFacade } from './authSessionFacade.js';
import type {
  AuthSessionAccountRow,
  AuthSessionAccountView,
} from './authSessionRepository.js';
import { createSmsChallengeFacade } from './smsChallengeFacade.js';
import type { SmsChallengeAccountView } from './smsChallengeRepository.js';

export interface AccountAccessCompositionOptions<
  TAccountView extends AccountDirectoryView &
    AuthSessionAccountView &
    SmsChallengeAccountView,
  TAccountRow extends AccountDirectoryRow & AuthSessionAccountRow,
> {
  db(): Database;
  defaultOrganizationId: string;
  now(): number;
  normalizeIdentifier(identifier: string): string;
  normalizePhone(phone: string): string;
  passwordMatches(password: string, stored: string): boolean;
  isOrganizationActive(organizationId: string): boolean;
  organizationExists(organizationId: string): boolean;
  toAccountView(row: TAccountRow): TAccountView;
  hashSecret(secret: string): string;
  secretMatches(secret: string, stored: string): boolean;
  createChallengeId(kind: 'login' | 'registration'): string;
  audit(
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
}

/** Builds account lookup, session and SMS authentication as one access boundary. */
export function createAccountAccessComposition<
  TAccountView extends AccountDirectoryView &
    AuthSessionAccountView &
    SmsChallengeAccountView,
  TAccountRow extends AccountDirectoryRow & AuthSessionAccountRow,
>(options: AccountAccessCompositionOptions<TAccountView, TAccountRow>) {
  const accountDirectory = createAccountDirectoryFacade<
    TAccountView,
    TAccountRow
  >({
    db: options.db,
    defaultOrganizationId: options.defaultOrganizationId,
    normalizeIdentifier: options.normalizeIdentifier,
    normalizePhone: options.normalizePhone,
    passwordMatches: options.passwordMatches,
    isOrganizationActive: options.isOrganizationActive,
    toAccountView: options.toAccountView,
  });
  const authSessions = createAuthSessionFacade<TAccountView, TAccountRow>({
    db: options.db,
    now: options.now,
    getAccount: accountDirectory.getAccount,
    isOrganizationActive: options.isOrganizationActive,
    toAccountView: options.toAccountView,
  });
  const smsChallenges = createSmsChallengeFacade<TAccountView>({
    db: options.db,
    defaultOrganizationId: options.defaultOrganizationId,
    getAccount: accountDirectory.getAccount,
    organizationExists: options.organizationExists,
    normalizePhone: options.normalizePhone,
    hashSecret: options.hashSecret,
    secretMatches: options.secretMatches,
    createChallengeId: options.createChallengeId,
    audit: options.audit,
  });

  return {
    ...accountDirectory,
    ...authSessions,
    ...smsChallenges,
  };
}
