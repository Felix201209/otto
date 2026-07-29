/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as dataGovernance from './modules/data_governance/index.js';
import { PRODUCT_MODULES } from './productModules.js';

const sourceRoot = path.resolve(import.meta.dirname);
const moduleDirectory = path.join(sourceRoot, 'modules', 'data_governance');
const publicImport = '../modules/data_governance/index.js';

describe('data_governance module boundary', () => {
  it('publishes consent, privacy-rights and deletion-ledger capabilities', () => {
    expect(dataGovernance.createDataGovernanceComposition).toBeTypeOf('function');
    expect(dataGovernance.handleDataGovernanceRoute).toBeTypeOf('function');
    expect(dataGovernance.createPrivacyDeletionLedger).toBeTypeOf('function');
    expect(dataGovernance.DATA_GOVERNANCE_SCHEMA_CONTRIBUTOR.id).toBe(
      'data_governance',
    );
  });

  it('is represented as a fail-closed platform module', () => {
    const manifest = PRODUCT_MODULES.find((entry) => entry.id === 'data_governance');
    expect(manifest?.layer).toBe('platform');
    expect(manifest?.dependencies).toEqual(expect.arrayContaining([
      'identity_organization',
      'authorization',
      'data_platform',
      'commercial_control',
    ]));
    expect(manifest?.dataOwnership).toEqual(expect.arrayContaining([
      'consent records',
      'privacy requests',
      'deletion tombstones',
    ]));
  });

  it('routes enterprise integration through the public module entrypoint', () => {
    const databaseFacade = fs.readFileSync(
      path.join(sourceRoot, 'enterprise', 'db.ts'),
      'utf8',
    );
    const routeDispatcher = fs.readFileSync(
      path.join(sourceRoot, 'enterprise', 'enterpriseRouteDispatcher.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain(publicImport);
    expect(routeDispatcher).toContain(publicImport);
    expect(databaseFacade).not.toContain('CREATE TABLE IF NOT EXISTS legal_consents');
    expect(databaseFacade).not.toContain('CREATE TABLE IF NOT EXISTS privacy_requests');
  });

  it('does not depend on the enterprise composition root', () => {
    for (const file of fs.readdirSync(moduleDirectory)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const source = fs.readFileSync(path.join(moduleDirectory, file), 'utf8');
      expect(source).not.toMatch(/enterprise[\\/]db|\.\.\/\.\.\/enterprise/);
    }
  });
});
