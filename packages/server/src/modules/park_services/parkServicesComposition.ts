/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import { createParkLifecycleFacade } from './parkLifecycleFacade.js';
import { createParkMembershipFacade } from './parkMembershipFacade.js';
import {
  listParkTenantOrganizationsFromRepository,
  type ParkTenantOrganizationRepositoryStore,
} from './parkMembershipRepository.js';
import { createParkPublicationFacade } from './parkPublicationFacade.js';
import { createParkResourceFacade } from './parkResourceFacade.js';
import {
  DEFAULT_PARK_SERVICES,
  isParkRequestServiceId,
} from './parkServiceCatalog.js';
import { createParkServiceConfigurationFacade } from './parkServiceConfigurationFacade.js';
import { createParkStatisticsFacade } from './parkStatisticsFacade.js';
import type { ParkStatisticsOrganization } from './parkStatisticsRepository.js';
import { createParkTicketFacade } from './parkTicketFacade.js';
import type { ParkTicketAccount } from './parkTicketTypes.js';

export interface ParkServicesCompositionAccount extends ParkTicketAccount {
  department: string | null;
  tags: string[];
}

export type ParkServicesCompositionOrganization = ParkStatisticsOrganization;

export interface ParkServicesCompositionOptions<
  TAccount extends ParkServicesCompositionAccount,
  TOrganization extends ParkServicesCompositionOrganization,
> {
  db(): Database;
  getAccount(accountId: string, organizationId?: string): TAccount | null;
  getOrganization(organizationId: string): TOrganization | null;
  isOrganizationActive(organizationId: string): boolean;
  listAccounts(organizationId?: string): TAccount[];
  getOrganizationFeatures(organizationId: string): { park_service: boolean };
  toOrganizationView: ParkTenantOrganizationRepositoryStore<TOrganization>['toOrganizationView'];
  normalizeOptionalText(
    value: string,
    field: string,
    maxLength?: number,
  ): string | null;
  normalizeSlug(value: string): string;
  normalizeInviteCode(code: string): string;
  normalizeTags(tags: string[] | undefined): string[];
  createUuid(): string;
  createRandomHex(byteLength: number): string;
  inviteValidityMs: number;
  inviteAlphabet: string;
  inviteCodeRawLength: number;
  audit(
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
  now?(): Date;
}

/** Builds all park capabilities around one tenant-scoped dependency graph. */
export function createParkServicesComposition<
  TAccount extends ParkServicesCompositionAccount,
  TOrganization extends ParkServicesCompositionOrganization,
>(options: ParkServicesCompositionOptions<TAccount, TOrganization>) {
  const now = options.now ?? (() => new Date());
  const activeAccounts = (organizationId: string) =>
    options
      .listAccounts(organizationId)
      .filter((account) => account.status === 'active');
  const lifecycle = createParkLifecycleFacade({
    db: options.db,
    getAccount: options.getAccount,
    getOrganization: options.getOrganization,
    getActiveOrganizationAdmin: (organizationId) =>
      activeAccounts(organizationId).find((account) => account.isAdmin) ?? null,
    normalizeOptionalText: options.normalizeOptionalText,
    normalizeSlug: options.normalizeSlug,
    createParkId: () => `park_${options.createUuid()}`,
    createDefaultSlug: () => `park-${options.createRandomHex(5)}`,
    createInviteSecret: () => options.createRandomHex(32),
    defaultServices: DEFAULT_PARK_SERVICES,
  });
  const getPark = lifecycle.getPark;
  const getParkForOrganization = lifecycle.getParkForOrganization;

  const serviceConfiguration = createParkServiceConfigurationFacade({
    db: options.db,
    getAccount: options.getAccount,
    getPark,
    normalizeOptionalText: options.normalizeOptionalText,
  });
  const listParkServices = serviceConfiguration.listServices;
  const listParkServiceSpecialists = serviceConfiguration.listSpecialists;

  const tenantOrganizations: ParkTenantOrganizationRepositoryStore<TOrganization> =
    {
      db: options.db,
      getPark,
      toOrganizationView: options.toOrganizationView,
    };
  const listParkTenantOrganizations = (parkId: string) =>
    listParkTenantOrganizationsFromRepository(tenantOrganizations, parkId);

  const membership = createParkMembershipFacade({
    db: options.db,
    getAccount: options.getAccount,
    getPark,
    getParkForOrganization,
    createInviteId: () => `park_invite_${options.createUuid()}`,
    createInviteNonce: () => options.createRandomHex(20),
    inviteValidityMs: options.inviteValidityMs,
    inviteAlphabet: options.inviteAlphabet,
    inviteCodeRawLength: options.inviteCodeRawLength,
    normalizeInviteCode: options.normalizeInviteCode,
    normalizeOptionalText: options.normalizeOptionalText,
  });
  const publications = createParkPublicationFacade({
    db: options.db,
    getAccount: options.getAccount,
    getParkForOrganization,
    createPublicationId: () => `park_publication_${options.createUuid()}`,
    audit: options.audit,
  });
  const statistics = createParkStatisticsFacade({
    db: options.db,
    getAccount: options.getAccount,
    getPark,
    getParkForOrganization,
    getOrganizationFeatures: options.getOrganizationFeatures,
    listAccounts: options.listAccounts,
    listParkServices,
    listParkTenantOrganizations,
    createTaskId: () => `park_statistics_${options.createUuid()}`,
    createAssignmentId: () =>
      `park_statistics_assignment_${options.createUuid()}`,
    nowISO: () => now().toISOString(),
    audit: options.audit,
  });
  const tickets = createParkTicketFacade<TAccount>({
    db: options.db,
    getAccount: options.getAccount,
    isOrganizationActive: options.isOrganizationActive,
    getOrganizationFeatures: options.getOrganizationFeatures,
    getPark,
    getParkForOrganization,
    listParkServices,
    listParkServiceSpecialists,
    listActiveOrganizationAdmins: (organizationId) =>
      activeAccounts(organizationId).filter((account) => account.isAdmin),
    listActiveAccountsByDepartment: (
      organizationId,
      department,
      excludeAccountId,
    ) =>
      activeAccounts(organizationId).filter(
        (account) =>
          account.department === department && account.id !== excludeAccountId,
      ),
    listActiveAccountsByTags: (organizationId, tags) =>
      activeAccounts(organizationId).filter((account) =>
        tags.every((tag) => account.tags.includes(tag)),
      ),
    normalizeTags: options.normalizeTags,
    isParkServiceId: isParkRequestServiceId,
    createTicketId: () => `ticket_${options.createUuid()}`,
    createTicketEventId: () => `ticket_event_${options.createUuid()}`,
    createTicketNotificationId: () => `ticket_notice_${options.createUuid()}`,
    now,
    audit: options.audit,
  });
  const resources = createParkResourceFacade({
    db: options.db,
    createMeetingRoomId: () => `park_room_${options.createUuid()}`,
    createMeetingBookingId: () => `park_booking_${options.createUuid()}`,
    now,
  });

  return {
    getPark,
    getParkForOrganization,
    createPark: lifecycle.createPark,
    createParkAsPlatform: lifecycle.createParkAsPlatform,
    updateParkAsPlatform: lifecycle.updateParkAsPlatform,
    listParkServices,
    updateParkService: serviceConfiguration.updateService,
    listParkServiceSpecialists,
    setParkServiceSpecialist: serviceConfiguration.setSpecialist,
    removeParkServiceSpecialist: serviceConfiguration.removeSpecialist,
    listParkTenantOrganizations,
    getParkTenantProfile: membership.getTenantProfile,
    updateParkTenantProfile: membership.updateTenantProfile,
    issueParkInvite: membership.issueInvite,
    joinOrganizationToPark: membership.joinOrganization,
    ...publications,
    ...statistics,
    ...tickets,
    ...resources,
  };
}
