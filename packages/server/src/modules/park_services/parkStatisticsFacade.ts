/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createParkDataStatisticsTask as createTaskInRepository,
  delegateParkDataStatistics as delegateInRepository,
  getParkDataStatisticsTemplate as getTemplateFromRepository,
  listParkDataStatisticsTasks as listTasksFromRepository,
  markParkDataStatisticsRead as markReadInRepository,
  remindParkDataStatistics as remindInRepository,
  returnParkDataStatistics as returnInRepository,
  reviewParkDataStatistics as reviewInRepository,
  submitParkDataStatisticsDraft as submitDraftInRepository,
  type ParkStatisticsRepositoryStore,
} from './parkStatisticsRepository.js';
import type { CreateParkDataStatisticsTaskInput } from './parkStatisticsTypes.js';
import { getParkServiceStatisticsFromRepository } from './parkUsageStatisticsRepository.js';

export function createParkStatisticsFacade(
  store: ParkStatisticsRepositoryStore,
) {
  return {
    createParkDataStatisticsTask(input: CreateParkDataStatisticsTaskInput) {
      return createTaskInRepository(store, input);
    },
    delegateParkDataStatistics(
      taskId: string,
      accountId: string,
      assigneeAccountId: string,
    ) {
      return delegateInRepository(
        store,
        taskId,
        accountId,
        assigneeAccountId,
      );
    },
    getParkDataStatisticsTemplate(taskId: string, accountId: string) {
      return getTemplateFromRepository(store, taskId, accountId);
    },
    getParkServiceStatistics(input: {
      parkId: string;
      actorAccountId: string;
    }) {
      return getParkServiceStatisticsFromRepository(store, input);
    },
    listParkDataStatisticsTasks(accountId: string) {
      return listTasksFromRepository(store, accountId);
    },
    markParkDataStatisticsRead(taskId: string, accountId: string) {
      return markReadInRepository(store, taskId, accountId);
    },
    remindParkDataStatistics(taskId: string, adminAccountId: string) {
      return remindInRepository(store, taskId, adminAccountId);
    },
    returnParkDataStatistics(
      taskId: string,
      adminAccountId: string,
      organizationId: string,
      reason: string,
    ) {
      return returnInRepository(
        store,
        taskId,
        adminAccountId,
        organizationId,
        reason,
      );
    },
    reviewParkDataStatistics(
      taskId: string,
      accountId: string,
      approved: boolean,
      reason?: string,
    ) {
      return reviewInRepository(
        store,
        taskId,
        accountId,
        approved,
        reason,
      );
    },
    submitParkDataStatisticsDraft(
      taskId: string,
      accountId: string,
      responseData: Record<string, string>,
    ) {
      return submitDraftInRepository(
        store,
        taskId,
        accountId,
        responseData,
      );
    },
  };
}
