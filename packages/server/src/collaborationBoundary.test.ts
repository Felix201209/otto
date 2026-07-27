/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as collaboration from './modules/collaboration/index.js';
import { PRODUCT_MODULES } from './productModules.js';

const sourceRoot = path.resolve(import.meta.dirname);
const moduleDir = path.join(sourceRoot, 'modules', 'collaboration');
const databaseFacadePath = path.join(sourceRoot, 'enterprise', 'db.ts');

describe('collaboration module boundary', () => {
  it('publishes presence through the collaboration public entrypoint', () => {
    expect(collaboration.createAccountPresenceFacade).toBeTypeOf('function');
    expect(collaboration.touchAccountPresenceInRepository).toBeTypeOf(
      'function',
    );
    expect(collaboration.listAccountPresenceFromRepository).toBeTypeOf(
      'function',
    );
  });

  it('keeps presence ownership aligned with the product module registry', () => {
    const manifest = PRODUCT_MODULES.find(
      (module) => module.id === 'collaboration',
    );
    expect(manifest?.dataOwnership).toContain('presence');
    expect(manifest?.dependencies).toEqual(
      expect.arrayContaining([
        'identity_organization',
        'authorization',
        'data_platform',
      ]),
    );
  });

  it('does not depend on the enterprise database facade', () => {
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

  it('keeps presence SQL and policy behind the collaboration facade', () => {
    const databaseFacade = fs.readFileSync(databaseFacadePath, 'utf8');
    expect(databaseFacade).toContain('createAccountPresenceFacade');
    expect(databaseFacade).not.toMatch(
      /export function (?:touchAccountPresence|listAccountPresence)\s*\(/,
    );
    expect(databaseFacade).not.toContain(
      'SELECT account_id, MAX(last_seen_at_ms) AS last_seen_at_ms',
    );
    expect(databaseFacade).not.toContain('INSERT INTO account_presence');
  });
});
