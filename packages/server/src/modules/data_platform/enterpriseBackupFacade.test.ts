/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import { createEnterpriseBackupFacade } from './enterpriseBackupFacade.js';

describe('enterprise backup facade', () => {
  it('collects every backup section for the default organization', () => {
    const collectors = {
      listEmployees: vi.fn(() => [{ id: 'employee' }]),
      listTaskLogs: vi.fn(() => [{ id: 'task' }]),
      listKnowledge: vi.fn(() => [{ id: 'knowledge' }]),
      listInviteCodes: vi.fn(() => [{ id: 'invite' }]),
      listAuditLogs: vi.fn(() => [{ id: 'audit' }]),
      listAccounts: vi.fn(() => [{ id: 'account' }]),
      listAccountTags: vi.fn(() => [{ tag: 'IT' }]),
      listTickets: vi.fn(() => [{ id: 'ticket' }]),
      listTicketDeliveries: vi.fn(() => [{ id: 'delivery' }]),
    };
    const backup = createEnterpriseBackupFacade({
      defaultOrganizationId: 'org-default',
      ...collectors,
    });

    expect(backup.exportAll()).toEqual({
      employees: [{ id: 'employee' }],
      taskLogs: [{ id: 'task' }],
      knowledge: [{ id: 'knowledge' }],
      inviteCodes: [{ id: 'invite' }],
      auditLogs: [{ id: 'audit' }],
      accounts: [{ id: 'account' }],
      accountTags: [{ tag: 'IT' }],
      tickets: [{ id: 'ticket' }],
      ticketDeliveries: [{ id: 'delivery' }],
    });
    for (const collector of Object.values(collectors)) {
      expect(collector).toHaveBeenCalledOnce();
      expect(collector).toHaveBeenCalledWith('org-default');
    }
  });

  it('forwards an explicit tenant to every collector', () => {
    const organizationIds: string[] = [];
    const collect = (organizationId: string): unknown[] => {
      organizationIds.push(organizationId);
      return [];
    };
    const backup = createEnterpriseBackupFacade({
      defaultOrganizationId: 'org-default',
      listEmployees: collect,
      listTaskLogs: collect,
      listKnowledge: collect,
      listInviteCodes: collect,
      listAuditLogs: collect,
      listAccounts: collect,
      listAccountTags: collect,
      listTickets: collect,
      listTicketDeliveries: collect,
    });

    expect(backup.exportAll('org-selected')).toEqual({
      employees: [],
      taskLogs: [],
      knowledge: [],
      inviteCodes: [],
      auditLogs: [],
      accounts: [],
      accountTags: [],
      tickets: [],
      ticketDeliveries: [],
    });
    expect(organizationIds).toEqual(Array(9).fill('org-selected'));
  });
});
