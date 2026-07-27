/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  getOrganizationInvite as getOrganizationInviteFromRepository,
  inspectOrganizationInvite as inspectOrganizationInviteFromRepository,
  issueOrganizationInvite as issueOrganizationInviteInRepository,
  normalizeOrganizationInviteCode as normalizeOrganizationInviteCodeFromRepository,
  resolveOrganizationInvite as resolveOrganizationInviteFromRepository,
  resolveOrganizationInviteWithDefaults as resolveOrganizationInviteWithDefaultsFromRepository,
  type OrganizationInviteRepositoryStore,
} from './organizationInviteRepository.js';
import type {
  OrganizationInviteInspection,
  OrganizationInviteIssueInput,
  OrganizationInviteOrganizationView,
  OrganizationInviteResolution,
  OrganizationInviteView,
} from './organizationInviteTypes.js';

export interface OrganizationInviteFacade {
  normalizeOrganizationInviteCode(code: string): string;
  inspectOrganizationInvite(
    code: string,
    now?: number,
  ): OrganizationInviteInspection;
  issueOrganizationInvite(
    organizationId: string,
    now?: number,
    createdByAccountId?: string | null,
    input?: string | OrganizationInviteIssueInput | null,
  ): OrganizationInviteView;
  getOrganizationInvite(
    organizationId: string,
    now?: number,
  ): OrganizationInviteView | null;
  resolveOrganizationInviteWithDefaults(
    code: string,
    now?: number,
  ): OrganizationInviteResolution | null;
  resolveOrganizationInvite(
    code: string,
    now?: number,
  ): OrganizationInviteOrganizationView | null;
}

export function createOrganizationInviteFacade(
  store: OrganizationInviteRepositoryStore,
): OrganizationInviteFacade {
  return {
    normalizeOrganizationInviteCode(code) {
      return normalizeOrganizationInviteCodeFromRepository(code);
    },
    inspectOrganizationInvite(code, now = Date.now()) {
      return inspectOrganizationInviteFromRepository(store, code, now);
    },
    issueOrganizationInvite(
      organizationId,
      now = Date.now(),
      createdByAccountId,
      input,
    ) {
      return issueOrganizationInviteInRepository(
        store,
        organizationId,
        now,
        createdByAccountId,
        input,
      );
    },
    getOrganizationInvite(organizationId, now = Date.now()) {
      return getOrganizationInviteFromRepository(store, organizationId, now);
    },
    resolveOrganizationInviteWithDefaults(code, now = Date.now()) {
      return resolveOrganizationInviteWithDefaultsFromRepository(
        store,
        code,
        now,
      );
    },
    resolveOrganizationInvite(code, now = Date.now()) {
      return resolveOrganizationInviteFromRepository(store, code, now);
    },
  };
}
