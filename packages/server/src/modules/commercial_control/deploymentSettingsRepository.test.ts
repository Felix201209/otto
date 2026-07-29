/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { createDeploymentSettingsRepository } from './deploymentSettingsRepository.js';
import { PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR } from './privateDeploymentSchema.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  applyDatabaseSchemaContributors(database, [
    PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR,
  ]);
  return database;
}

describe('deployment settings repository', () => {
  it('returns null for an unset deployment setting', () => {
    const database = createDatabase();
    try {
      const settings = createDeploymentSettingsRepository(() => database);
      expect(settings.readSetting('missing')).toBeNull();
    } finally {
      database.close();
    }
  });

  it('upserts a setting without creating duplicate rows', () => {
    const database = createDatabase();
    try {
      const settings = createDeploymentSettingsRepository(() => database);
      settings.writeSetting('telemetry_enabled', 'true');
      settings.writeSetting('telemetry_enabled', 'false');

      expect(settings.readSetting('telemetry_enabled')).toBe('false');
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count, MAX(updated_at) AS updated_at
             FROM deployment_settings WHERE key = ?`,
          )
          .get('telemetry_enabled'),
      ).toEqual({ count: 1, updated_at: expect.any(String) });
    } finally {
      database.close();
    }
  });

  it('binds keys and values without changing query semantics', () => {
    const database = createDatabase();
    try {
      const settings = createDeploymentSettingsRepository(() => database);
      const specialKey = "channel' OR 1 = 1 --";
      const specialValue = JSON.stringify({ url: "https://otto.example/a'b" });

      settings.writeSetting('channel', 'stable');
      settings.writeSetting(specialKey, specialValue);

      expect(settings.readSetting('channel')).toBe('stable');
      expect(settings.readSetting(specialKey)).toBe(specialValue);
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM deployment_settings')
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it('resolves the active database lazily for every operation', () => {
    const first = createDatabase();
    const second = createDatabase();
    try {
      let active = first;
      let resolutions = 0;
      const settings = createDeploymentSettingsRepository(() => {
        resolutions += 1;
        return active;
      });

      expect(resolutions).toBe(0);
      settings.writeSetting('deployment_id', 'first-deployment');
      active = second;
      settings.writeSetting('deployment_id', 'second-deployment');

      expect(resolutions).toBe(2);
      expect(
        first
          .prepare('SELECT value FROM deployment_settings WHERE key = ?')
          .get('deployment_id'),
      ).toEqual({ value: 'first-deployment' });
      expect(settings.readSetting('deployment_id')).toBe('second-deployment');
      expect(resolutions).toBe(3);
    } finally {
      first.close();
      second.close();
    }
  });
});
