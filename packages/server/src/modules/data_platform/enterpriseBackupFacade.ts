/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface EnterpriseBackupSnapshot {
  employees: unknown[];
  taskLogs: unknown[];
  knowledge: unknown[];
  inviteCodes: unknown[];
  auditLogs: unknown[];
  accounts: unknown[];
  accountTags: unknown[];
  tickets: unknown[];
  ticketDeliveries: unknown[];
}

export interface EnterpriseBackupFacadeStore {
  defaultOrganizationId: string;
  listEmployees(organizationId: string): unknown[];
  listTaskLogs(organizationId: string): unknown[];
  listKnowledge(organizationId: string): unknown[];
  listInviteCodes(organizationId: string): unknown[];
  listAuditLogs(organizationId: string): unknown[];
  listAccounts(organizationId: string): unknown[];
  listAccountTags(organizationId: string): unknown[];
  listTickets(organizationId: string): unknown[];
  listTicketDeliveries(organizationId: string): unknown[];
}

/** Aggregates one tenant snapshot without depending on any domain table. */
export function createEnterpriseBackupFacade(
  store: EnterpriseBackupFacadeStore,
) {
  return {
    exportAll(
      organizationId = store.defaultOrganizationId,
    ): EnterpriseBackupSnapshot {
      return {
        employees: store.listEmployees(organizationId),
        taskLogs: store.listTaskLogs(organizationId),
        knowledge: store.listKnowledge(organizationId),
        inviteCodes: store.listInviteCodes(organizationId),
        auditLogs: store.listAuditLogs(organizationId),
        accounts: store.listAccounts(organizationId),
        accountTags: store.listAccountTags(organizationId),
        tickets: store.listTickets(organizationId),
        ticketDeliveries: store.listTicketDeliveries(organizationId),
      };
    },
  };
}
