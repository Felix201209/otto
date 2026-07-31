/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';

export interface DeploymentSettingsRepository {
  readSetting(key: string): string | null;
  writeSetting(key: string, value: string): void;
}

/** Owns persisted key/value access for private deployment configuration. */
export function createDeploymentSettingsRepository(
  getDatabase: () => Database,
): DeploymentSettingsRepository {
  return {
    readSetting(key) {
      const row = getDatabase()
        .prepare('SELECT value FROM deployment_settings WHERE key = ?')
        .get(key) as { value: string } | undefined;
      return typeof row?.value === 'string' ? row.value : null;
    },
    writeSetting(key, value) {
      getDatabase()
        .prepare(
          `INSERT INTO deployment_settings (key, value, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE
             SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, value);
    },
  };
}
