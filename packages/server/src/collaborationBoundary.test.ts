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
const legacyMessageRepositoryPath = path.join(
  sourceRoot,
  'enterprise',
  'directMessageRepository.ts',
);

describe('collaboration module boundary', () => {
  it('publishes presence through the collaboration public entrypoint', () => {
    expect(collaboration.createAccountPresenceFacade).toBeTypeOf('function');
    expect(collaboration.createCollaborationComposition).toBeTypeOf('function');
    expect(collaboration.touchAccountPresenceInRepository).toBeTypeOf(
      'function',
    );
    expect(collaboration.listAccountPresenceFromRepository).toBeTypeOf(
      'function',
    );
  });

  it('publishes direct messages and A2A through the public entrypoint', () => {
    expect(collaboration.COLLABORATION_SCHEMA_CONTRIBUTOR.id).toBe(
      'collaboration',
    );
    expect(collaboration.createDirectMessageFacade).toBeTypeOf('function');
    expect(collaboration.sendDirectMessageInRepository).toBeTypeOf('function');
    expect(collaboration.listPendingAtoaRequestsFromRepository).toBeTypeOf(
      'function',
    );
    expect(
      collaboration.markAtoaRequestReadFromResponseInRepository,
    ).toBeTypeOf('function');
  });

  it('keeps collaboration ownership aligned with the product module registry', () => {
    const manifest = PRODUCT_MODULES.find(
      (module) => module.id === 'collaboration',
    );
    expect(manifest?.dataOwnership).toContain('presence');
    expect(manifest?.dataOwnership).toEqual(
      expect.arrayContaining([
        'direct messages',
        'message attachments',
        'A2A requests',
      ]),
    );
    expect(manifest?.dependencies).toEqual(
      expect.arrayContaining([
        'identity_organization',
        'authorization',
        'secure_messaging',
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

  it('composes messaging and presence behind one module factory', () => {
    const databaseFacade = fs.readFileSync(databaseFacadePath, 'utf8');
    expect(databaseFacade).toContain('createCollaborationComposition');
    expect(databaseFacade).not.toContain('createDirectMessageFacade');
    expect(databaseFacade).not.toContain('createAccountPresenceFacade');
  });

  it('keeps presence SQL and policy behind the collaboration facade', () => {
    const databaseFacade = fs.readFileSync(databaseFacadePath, 'utf8');
    expect(databaseFacade).toContain('createCollaborationComposition');
    expect(databaseFacade).not.toContain('createAccountPresenceFacade');
    expect(databaseFacade).not.toMatch(
      /export function (?:touchAccountPresence|listAccountPresence)\s*\(/,
    );
    expect(databaseFacade).not.toContain(
      'SELECT account_id, MAX(last_seen_at_ms) AS last_seen_at_ms',
    );
    expect(databaseFacade).not.toContain('INSERT INTO account_presence');
  });

  it('removes the legacy message repository and injects the collaboration facade', () => {
    const databaseFacade = fs.readFileSync(databaseFacadePath, 'utf8');
    expect(fs.existsSync(legacyMessageRepositoryPath)).toBe(false);
    expect(databaseFacade).toContain('createCollaborationComposition');
    expect(databaseFacade).not.toContain('createDirectMessageFacade');
    expect(databaseFacade).not.toContain("from './directMessageRepository.js'");
    expect(databaseFacade).not.toContain('INSERT INTO direct_messages');
    expect(databaseFacade).toContain('COLLABORATION_SCHEMA_CONTRIBUTOR');
    expect(databaseFacade).not.toMatch(
      /CREATE TABLE IF NOT EXISTS (?:account_presence|direct_messages|direct_message_attachments)/,
    );
  });
});
