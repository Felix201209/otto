/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  getAuditLogsFromRepository,
  logAuditInRepository,
  type AuditLogRepositoryStore,
} from './auditLogRepository.js';

export function createAuditLogFacade(store: AuditLogRepositoryStore) {
  return {
    logAudit(
      event: string,
      employeeId: string | null,
      detail: string,
      organizationId = store.defaultOrganizationId,
    ) {
      return logAuditInRepository(store, {
        event,
        employeeId,
        detail,
        organizationId,
      });
    },
    getAuditLogs(limit = 50, organizationId = store.defaultOrganizationId) {
      return getAuditLogsFromRepository(store, limit, organizationId);
    },
  };
}
