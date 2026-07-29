/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as parkServices from './modules/park_services/index.js';
import { PRODUCT_MODULES } from './productModules.js';

const sourceRoot = path.resolve(import.meta.dirname);
const moduleDir = path.join(sourceRoot, 'modules', 'park_services');
const databaseFacadePath = path.join(sourceRoot, 'enterprise', 'db.ts');

describe('park services module boundary', () => {
  it('publishes lifecycle, membership, publications, resources, statistics, tickets, and service configuration through one entrypoint', () => {
    expect(parkServices.createParkLifecycleFacade).toBeTypeOf('function');
    expect(parkServices.PARK_CORE_SCHEMA_CONTRIBUTOR).toMatchObject({
      id: 'park_services_core',
    });
    expect(parkServices.createParkInRepository).toBeTypeOf('function');
    expect(parkServices.createParkAsPlatformInRepository).toBeTypeOf(
      'function',
    );
    expect(parkServices.updateParkAsPlatformInRepository).toBeTypeOf(
      'function',
    );
    expect(parkServices.createParkMembershipFacade).toBeTypeOf('function');
    expect(parkServices.issueParkInviteInRepository).toBeTypeOf('function');
    expect(parkServices.joinOrganizationToParkInRepository).toBeTypeOf(
      'function',
    );
    expect(parkServices.updateParkTenantProfileInRepository).toBeTypeOf(
      'function',
    );
    expect(parkServices.createParkPublicationFacade).toBeTypeOf('function');
    expect(parkServices.createParkPublicationSchemaContributor).toBeTypeOf(
      'function',
    );
    expect(parkServices.createParkPublicationInRepository).toBeTypeOf(
      'function',
    );
    expect(parkServices.markParkPublicationReadInRepository).toBeTypeOf(
      'function',
    );
    expect(parkServices.submitParkSurveyInRepository).toBeTypeOf('function');
    expect(parkServices.createParkResourceFacade).toBeTypeOf('function');
    expect(parkServices.createParkResourceRepository).toBeTypeOf('function');
    expect(parkServices.PARK_RESOURCE_SCHEMA_CONTRIBUTOR).toMatchObject({
      id: 'park_services_resources',
    });
    expect(parkServices.PARK_MEETING_TIME_SLOTS).toHaveLength(84);
    expect(parkServices.createParkStatisticsFacade).toBeTypeOf('function');
    expect(parkServices.PARK_STATISTICS_SCHEMA_CONTRIBUTOR).toMatchObject({
      id: 'park_services_statistics',
    });
    expect(parkServices.createParkDataStatisticsTask).toBeTypeOf('function');
    expect(parkServices.getParkServiceStatisticsFromRepository).toBeTypeOf(
      'function',
    );
    expect(parkServices.createParkTicketFacade).toBeTypeOf('function');
    expect(parkServices.createParkTicketSchemaContributor).toBeTypeOf(
      'function',
    );
    expect(parkServices.migrateLegacyParkTicketEvents).toBeTypeOf('function');
    expect(parkServices.createTicket).toBeTypeOf('function');
    expect(parkServices.updateTicket).toBeTypeOf('function');
    expect(parkServices.normalizeParkServiceFormData).toBeTypeOf('function');
    expect(parkServices.createParkServiceConfigurationFacade).toBeTypeOf(
      'function',
    );
    expect(parkServices.updateParkServiceInRepository).toBeTypeOf('function');
    expect(parkServices.setParkServiceSpecialistInRepository).toBeTypeOf(
      'function',
    );
    expect(parkServices.removeParkServiceSpecialistInRepository).toBeTypeOf(
      'function',
    );
  });

  it('matches the stable product registry ownership and dependencies', () => {
    const manifest = PRODUCT_MODULES.find(
      (module) => module.id === 'park_services',
    );
    expect(manifest?.dataOwnership).toEqual(
      expect.arrayContaining(['parks', 'park tenants']),
    );
    expect(manifest?.dependencies).toEqual(
      expect.arrayContaining([
        'identity_organization',
        'authorization',
        'collaboration',
        'data_platform',
      ]),
    );
  });

  it('does not import the enterprise database facade', () => {
    const offenders = fs
      .readdirSync(moduleDir)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) =>
        /enterprise[\\/]db|\.\.\/\.\.\/enterprise/.test(
          fs.readFileSync(path.join(moduleDir, file), 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('keeps park core schema ownership in the park services module', () => {
    const databaseFacade = fs.readFileSync(databaseFacadePath, 'utf8');
    for (const table of [
      'parks',
      'park_invites',
      'park_services',
      'park_tenant_profiles',
      'park_service_specialists',
    ]) {
      expect(databaseFacade).not.toContain(
        `CREATE TABLE IF NOT EXISTS ${table}`,
      );
    }
    expect(databaseFacade).not.toContain('idx_park_invites_active');
    expect(databaseFacade).toMatch(
      /createEnterpriseInviteSchemaContributor\(\{[\s\S]*?PARK_CORE_SCHEMA_CONTRIBUTOR,[\s\S]*?createCreditsSchemaContributor\(\{/,
    );
  });

  it('keeps park publication schema ownership in the park services module', () => {
    const databaseFacade = fs.readFileSync(databaseFacadePath, 'utf8');
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS park_publications',
    );
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS park_publication_recipients',
    );
    expect(databaseFacade).not.toContain(
      'idx_park_publications_org_created',
    );
    expect(databaseFacade).not.toContain(
      'idx_park_publication_recipients_account',
    );
    expect(databaseFacade).not.toMatch(
      /^\s*['"]park_publications['"],\s*$/m,
    );
    expect(databaseFacade).not.toMatch(
      /^\s*['"]park_publication_recipients['"],\s*$/m,
    );
    expect(databaseFacade).toMatch(
      /PARK_CORE_SCHEMA_CONTRIBUTOR,[\s\S]*?createParkPublicationSchemaContributor\(\{[\s\S]*?createCreditsSchemaContributor\(\{/,
    );
  });

  it('keeps park statistics schema ownership in the park services module', () => {
    const databaseFacade = fs.readFileSync(databaseFacadePath, 'utf8');
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS park_data_statistics_tasks',
    );
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS park_data_statistics_assignments',
    );
    expect(databaseFacade).not.toContain('idx_park_statistics_tasks_park');
    expect(databaseFacade).not.toContain(
      'idx_park_statistics_assignments_account',
    );
    expect(databaseFacade).not.toContain(
      'idx_park_statistics_assignments_org',
    );
    expect(databaseFacade).toMatch(
      /createParkPublicationSchemaContributor\(\{[\s\S]*?PARK_STATISTICS_SCHEMA_CONTRIBUTOR,[\s\S]*?createCreditsSchemaContributor\(\{/,
    );
  });

  it('keeps park resource schema ownership in the park services module', () => {
    const databaseFacade = fs.readFileSync(databaseFacadePath, 'utf8');
    for (const table of [
      'park_settings',
      'park_meeting_rooms',
      'park_meeting_slots',
      'park_meeting_bookings',
      'park_meeting_slot_overrides',
    ]) {
      expect(databaseFacade).not.toContain(
        `CREATE TABLE IF NOT EXISTS ${table}`,
      );
    }
    for (const index of [
      'idx_park_meeting_slots_booked_ticket',
      'idx_park_meeting_rooms_org_enabled',
      'idx_park_meeting_slots_org_date',
      'idx_park_meeting_bookings_org_date',
    ]) {
      expect(databaseFacade).not.toContain(index);
    }
    expect(databaseFacade).toMatch(
      /PARK_STATISTICS_SCHEMA_CONTRIBUTOR,[\s\S]*?PARK_RESOURCE_SCHEMA_CONTRIBUTOR,[\s\S]*?createCreditsSchemaContributor\(\{/,
    );
  });

  it('keeps park ticket schema and migrations in the park services module', () => {
    const databaseFacade = fs.readFileSync(databaseFacadePath, 'utf8');
    for (const table of [
      'it_tickets',
      'park_application_sequences',
      'ticket_events',
      'ticket_deliveries',
      'ticket_notifications',
    ]) {
      expect(databaseFacade).not.toContain(
        `CREATE TABLE IF NOT EXISTS ${table}`,
      );
    }
    for (const index of [
      'idx_ticket_deliveries_account',
      'idx_ticket_notifications_ticket',
      'idx_ticket_events_ticket_created',
      'idx_it_tickets_park_org_service_created',
      'idx_it_tickets_park_application_number',
      'idx_ticket_notifications_recipient',
    ]) {
      expect(databaseFacade).not.toContain(index);
    }
    expect(databaseFacade).not.toContain('ALTER TABLE it_tickets');
    expect(databaseFacade).not.toContain('backfillParkApplicationNumbers');
    expect(databaseFacade).not.toContain('migrateLegacyTicketEvents');
    expect(databaseFacade).toMatch(
      /PARK_STATISTICS_SCHEMA_CONTRIBUTOR,[\s\S]*?createParkTicketSchemaContributor\(\{[\s\S]*?PARK_RESOURCE_SCHEMA_CONTRIBUTOR,/,
    );
    expect(databaseFacade).toContain(
      'migrateLegacyParkTicketEvents(database)',
    );
  });

  it('removes legacy repositories and keeps owned write SQL behind facades', () => {
    const databaseFacade = fs.readFileSync(databaseFacadePath, 'utf8');
    expect(
      fs.existsSync(
        path.join(sourceRoot, 'enterprise', 'parkInviteRepository.ts'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(sourceRoot, 'enterprise', 'ticketRepository.ts'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(sourceRoot, 'enterprise', 'parkInviteTypes.ts')),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(sourceRoot, 'enterprise', 'parkServiceRepository.ts'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(sourceRoot, 'enterprise', 'parkServiceTypes.ts')),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(sourceRoot, 'enterprise', 'parkPublicationRepository.ts'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(sourceRoot, 'enterprise', 'parkMeetingRepository.ts'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(sourceRoot, 'enterprise', 'parkStatisticsRepository.ts'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(sourceRoot, 'enterprise', 'parkStatisticsTypes.ts'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          sourceRoot,
          'enterprise',
          'parkUsageStatisticsRepository.ts',
        ),
      ),
    ).toBe(false);
    expect(databaseFacade).toContain('createParkMembershipFacade');
    expect(databaseFacade).toContain('createParkLifecycleFacade');
    expect(databaseFacade).toContain('createParkServiceConfigurationFacade');
    expect(databaseFacade).toContain('createParkPublicationFacade');
    expect(databaseFacade).toContain('createParkResourceFacade');
    expect(databaseFacade).toContain('createParkStatisticsFacade');
    expect(databaseFacade).toContain('createParkTicketFacade');
    expect(databaseFacade).not.toContain("from './parkInviteRepository.js'");
    expect(databaseFacade).not.toContain("from './parkServiceRepository.js'");
    expect(databaseFacade).not.toContain(
      "from './parkPublicationRepository.js'",
    );
    expect(databaseFacade).not.toContain(
      "from './parkMeetingRepository.js'",
    );
    expect(databaseFacade).not.toContain(
      "from './parkStatisticsRepository.js'",
    );
    expect(databaseFacade).not.toContain(
      "from './parkUsageStatisticsRepository.js'",
    );
    expect(databaseFacade).not.toContain("from './ticketRepository.js'");
    expect(databaseFacade).not.toContain('INSERT INTO park_invites');
    expect(databaseFacade).not.toContain('INSERT INTO park_tenant_profiles');
    expect(databaseFacade).not.toContain('INSERT INTO parks');
    expect(databaseFacade).not.toContain('UPDATE park_services SET');
    expect(databaseFacade).not.toContain(
      'INSERT OR IGNORE INTO park_service_specialists',
    );
    expect(databaseFacade).not.toContain(
      'DELETE FROM park_service_specialists',
    );
    expect(databaseFacade).not.toContain('function toParkView');
    expect(databaseFacade).not.toContain('INSERT INTO park_publications');
    expect(databaseFacade).not.toContain(
      'UPDATE park_publication_recipients',
    );
    expect(databaseFacade).not.toContain('INSERT INTO park_meeting_rooms');
    expect(databaseFacade).not.toContain('INSERT INTO park_meeting_bookings');
    expect(databaseFacade).not.toContain(
      'INSERT INTO park_data_statistics_tasks',
    );
    expect(databaseFacade).not.toContain('INSERT INTO it_tickets');
    expect(databaseFacade).not.toContain(
      'UPDATE it_tickets SET response_type',
    );
  });
});
