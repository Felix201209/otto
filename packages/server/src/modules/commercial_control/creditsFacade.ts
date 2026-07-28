/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  checkAndReserveCreditsInRepository,
  createRedeemCodesInRepository,
  deductCreditsInRepository,
  getCreditBalanceFromRepository,
  listCreditTransactionsFromRepository,
  listRedeemCodesFromRepository,
  redeemCodeInRepository,
  revokeRedeemCodeInRepository,
  topUpCreditsInRepository,
  type CreditsRepositoryStore,
  type RedeemCodeInfo,
} from './creditsRepository.js';

export function createCreditsFacade(store: CreditsRepositoryStore) {
  return {
    createRedeemCodes(
      organizationId: string,
      adminAccountId: string,
      creditAmount: number,
      count = 1,
    ) {
      return createRedeemCodesInRepository(
        store,
        organizationId,
        adminAccountId,
        creditAmount,
        count,
      );
    },
    redeemCode(code: string, accountId: string) {
      return redeemCodeInRepository(store, code, accountId);
    },
    getCreditBalance(organizationId: string) {
      return getCreditBalanceFromRepository(store, organizationId);
    },
    checkAndReserveCredits(
      organizationId: string,
      accountId: string,
      estimatedTokens: number,
    ) {
      return checkAndReserveCreditsInRepository(
        store,
        organizationId,
        accountId,
        estimatedTokens,
      );
    },
    deductCredits(
      organizationId: string,
      accountId: string,
      amount: number,
      description: string,
      model?: string | null,
      messageId?: string,
    ) {
      return deductCreditsInRepository(
        store,
        organizationId,
        accountId,
        amount,
        description,
        model,
        messageId,
      );
    },
    topUpCredits(
      organizationId: string,
      adminAccountId: string,
      amount: number,
      note?: string,
    ) {
      return topUpCreditsInRepository(
        store,
        organizationId,
        adminAccountId,
        amount,
        note,
      );
    },
    listRedeemCodes(organizationId: string, status?: RedeemCodeInfo['status']) {
      return listRedeemCodesFromRepository(store, organizationId, status);
    },
    revokeRedeemCode(codeId: string, organizationId: string) {
      return revokeRedeemCodeInRepository(store, codeId, organizationId);
    },
    listCreditTransactions(organizationId: string, limit = 50) {
      return listCreditTransactionsFromRepository(store, organizationId, limit);
    },
  };
}
