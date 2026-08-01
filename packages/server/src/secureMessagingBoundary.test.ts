/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as secureMessaging from './modules/secure_messaging/index.js';
import { PRODUCT_MODULES } from './productModules.js';

const sourceRoot = path.resolve(import.meta.dirname);
const moduleDir = path.join(sourceRoot, 'modules', 'secure_messaging');
const databaseFacadePath = path.join(sourceRoot, 'enterprise', 'db.ts');

describe('secure messaging module boundary', () => {
  it('publishes device trust, transparency and release policy from one entrypoint', () => {
    expect(secureMessaging.SECURE_MESSAGING_SCHEMA_CONTRIBUTOR.id).toBe(
      'secure_messaging',
    );
    expect(secureMessaging.createSecureMessagingComposition).toBeTypeOf(
      'function',
    );
    expect(secureMessaging.verifyE2eeDeviceDirectorySnapshot).toBeTypeOf(
      'function',
    );
    expect(secureMessaging.E2EE_CAPABILITY_STATUS).toMatchObject({
      protocolId: 'otto-mls-v1',
      enabled: false,
      releaseState: 'foundation-only',
    });
  });

  it('owns trust proofs without taking ownership of enterprise content', () => {
    const manifest = PRODUCT_MODULES.find(
      (module) => module.id === 'secure_messaging',
    );
    expect(manifest?.dataOwnership).toEqual(
      expect.arrayContaining([
        'E2EE account trust roots',
        'device credentials',
        'MLS key packages',
        'signed device approval and revocation proofs',
        'key transparency checkpoints',
      ]),
    );
    expect(manifest?.dataOwnership).not.toContain('enterprise knowledge');
    expect(manifest?.dependencies).toEqual(
      expect.arrayContaining([
        'identity_organization',
        'authorization',
        'data_platform',
      ]),
    );
  });

  it('does not import the enterprise database facade', () => {
    const offenders = fs
      .readdirSync(moduleDir)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) =>
        /enterprise[\\/]db|\.\.\/\.\.\/enterprise/u.test(
          fs.readFileSync(path.join(moduleDir, file), 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('is composed by the database facade without leaking repository SQL', () => {
    const databaseFacade = fs.readFileSync(databaseFacadePath, 'utf8');
    expect(databaseFacade).toContain('createSecureMessagingComposition');
    expect(databaseFacade).toContain('SECURE_MESSAGING_SCHEMA_CONTRIBUTOR');
    expect(databaseFacade).not.toContain('INSERT INTO e2ee_devices');
    expect(databaseFacade).not.toContain('CREATE TABLE IF NOT EXISTS e2ee_devices');
  });
});
