/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * NSI-11: schema ownership for the ticket unread-notification escalation queue.
 * Business decisions remain in the repository/facade.
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';
import { createTicketEscalationTable } from './ticketEscalationRepository.js';

const SAFE_ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/**
 * Registered in the enterprise database lifecycle alongside park schemas.
 * Creates (idempotently) the durable escalation-jobs table and indexes.
 */
export function createTicketEscalationSchemaContributor(input: {
  defaultOrganizationId: string;
}): DatabaseSchemaContributor {
  if (!SAFE_ORGANIZATION_ID.test(input.defaultOrganizationId)) {
    throw new Error('Invalid default organization id for ticket escalation schema');
  }

  return {
    id: 'park_services_ticket_escalation',
    apply(database) {
      // apply() receives the DatabaseHandle which satisfies the minimal
      // EscalationDatabase surface used by the repository.
      createTicketEscalationTable(database as never);
    },
  };
}

export { createTicketEscalationTable as buildTicketEscalationTables };
