/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import { createAssignmentIdentityFacade } from './assignmentIdentityFacade.js';
import { createDepartmentInviteFacade } from './departmentInviteFacade.js';
import { createMemberDirectoryFacade } from './memberFacade.js';
import { createOrganizationDirectoryFacade } from './organizationDirectoryFacade.js';
import { toOrganizationDirectoryView } from './organizationDirectoryRepository.js';
import { createOrganizationInviteFacade } from './organizationInviteFacade.js';
import { createOrganizationStructureFacade } from './organizationStructureFacade.js';

export interface OrganizationWorkforceCompositionOptions {
  db(): Database;
  defaultOrganizationId: string;
  organizationInviteValidityMs: number;
  organizationInviteAlphabet: string;
  organizationInviteCodeRawLength: number;
  normalizeOptionalText(
    value: string | null | undefined,
    label: string,
    maxLength?: number,
  ): string | null;
  audit(
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId?: string,
  ): void;
}

/** Builds the organization directory, structure and workforce APIs as one module boundary. */
export function createOrganizationWorkforceComposition(
  options: OrganizationWorkforceCompositionOptions,
) {
  const organizationDirectory = createOrganizationDirectoryFacade({
    db: options.db,
  });
  const assignmentIdentities = createAssignmentIdentityFacade();

  const departmentInvites = createDepartmentInviteFacade({
    db: options.db,
    defaultOrganizationId: options.defaultOrganizationId,
    getOrganization: organizationDirectory.getOrganization,
    logAudit: options.audit,
  });
  const organizationStructure = createOrganizationStructureFacade({
    db: options.db,
    logAudit: options.audit,
  });
  const memberDirectory = createMemberDirectoryFacade({
    db: options.db,
    defaultOrganizationId: options.defaultOrganizationId,
    organizationExists: (organizationId) =>
      organizationDirectory.getOrganization(organizationId) !== null,
    resolveAssignmentIdentity: assignmentIdentities.resolveAssignmentIdentity,
    audit: options.audit,
  });
  const organizationInvites = createOrganizationInviteFacade({
    db: options.db,
    inviteValidityMs: options.organizationInviteValidityMs,
    inviteAlphabet: options.organizationInviteAlphabet,
    inviteCodeRawLength: options.organizationInviteCodeRawLength,
    toOrganizationView: toOrganizationDirectoryView,
    resolveAssignmentIdentity: assignmentIdentities.resolveAssignmentIdentity,
    normalizeOptionalText: options.normalizeOptionalText,
    logAudit: options.audit,
  });

  return {
    ...organizationDirectory,
    ...departmentInvites,
    ...organizationStructure,
    ...assignmentIdentities,
    ...memberDirectory,
    ...organizationInvites,
  };
}
