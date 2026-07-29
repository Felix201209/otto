/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import { getOrganizationPositionRoleMappingFromRepository } from './organizationStructureRepository.js';

describe('organization structure repository role mapping', () => {
  it('returns a position mapping only inside the requested organization', () => {
    const database = new Database(':memory:');
    try {
      database.exec(`
        CREATE TABLE organization_positions (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          role_mapping TEXT NOT NULL
        );
        INSERT INTO organization_positions (id, organization_id, role_mapping)
        VALUES
          ('position-a', 'organization-a', 'department_admin'),
          ('position-b', 'organization-b', 'enterprise_admin');
      `);

      expect(
        getOrganizationPositionRoleMappingFromRepository(
          database,
          'organization-a',
          'position-a',
        ),
      ).toBe('department_admin');
      expect(
        getOrganizationPositionRoleMappingFromRepository(
          database,
          'organization-b',
          'position-a',
        ),
      ).toBeNull();
      expect(
        getOrganizationPositionRoleMappingFromRepository(
          database,
          'organization-a',
          'missing-position',
        ),
      ).toBeNull();
    } finally {
      database.close();
    }
  });
});
