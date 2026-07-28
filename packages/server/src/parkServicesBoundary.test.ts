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
  it('publishes lifecycle, membership, publications, and service configuration through one entrypoint', () => {
    expect(parkServices.createParkLifecycleFacade).toBeTypeOf('function');
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
    expect(parkServices.createParkPublicationInRepository).toBeTypeOf(
      'function',
    );
    expect(parkServices.markParkPublicationReadInRepository).toBeTypeOf(
      'function',
    );
    expect(parkServices.submitParkSurveyInRepository).toBeTypeOf('function');
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

  it('removes legacy repositories and keeps owned write SQL behind facades', () => {
    const databaseFacade = fs.readFileSync(databaseFacadePath, 'utf8');
    expect(
      fs.existsSync(
        path.join(sourceRoot, 'enterprise', 'parkInviteRepository.ts'),
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
    expect(databaseFacade).toContain('createParkMembershipFacade');
    expect(databaseFacade).toContain('createParkLifecycleFacade');
    expect(databaseFacade).toContain('createParkServiceConfigurationFacade');
    expect(databaseFacade).toContain('createParkPublicationFacade');
    expect(databaseFacade).not.toContain("from './parkInviteRepository.js'");
    expect(databaseFacade).not.toContain("from './parkServiceRepository.js'");
    expect(databaseFacade).not.toContain(
      "from './parkPublicationRepository.js'",
    );
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
  });
});
