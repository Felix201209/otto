/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  getTaskHistoryFromRepository,
  getWorklogReportFromRepository,
  logWorkTaskInRepository,
  type WorklogRepositoryStore,
} from './worklogRepository.js';
import type {
  LogWorkTaskInput,
  PersonalWorklogEmployee,
  PersonalWorklogOrganization,
} from './worklogTypes.js';

export function createWorklogFacade<
  TEmployee extends PersonalWorklogEmployee,
  TOrganization extends PersonalWorklogOrganization,
>(store: WorklogRepositoryStore<TEmployee, TOrganization>) {
  return {
    logTask(input: LogWorkTaskInput) {
      return logWorkTaskInRepository(store, input);
    },
    getTaskHistory(
      employeeId: string,
      limit = 20,
      organizationId = store.defaultOrganizationId,
    ) {
      return getTaskHistoryFromRepository(
        store,
        employeeId,
        limit,
        organizationId,
      );
    },
    getReport(
      periodDays = 30,
      department?: string,
      organizationId = store.defaultOrganizationId,
    ) {
      return getWorklogReportFromRepository(
        store,
        periodDays,
        department,
        organizationId,
      );
    },
  };
}
