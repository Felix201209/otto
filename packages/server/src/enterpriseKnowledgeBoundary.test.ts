/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as enterpriseKnowledge from './modules/enterprise_knowledge/index.js';
import { PRODUCT_MODULES } from './productModules.js';

const sourceRoot = path.resolve(import.meta.dirname);
const moduleDir = path.join(sourceRoot, 'modules', 'enterprise_knowledge');
const databaseFacadePath = path.join(sourceRoot, 'enterprise', 'db.ts');
const legacyRepositoryPath = path.join(
  sourceRoot,
  'enterprise',
  'knowledgeRepository.ts',
);

describe('enterprise knowledge module boundary', () => {
  it('publishes repository and facade capabilities through one entrypoint', () => {
    expect(enterpriseKnowledge.createEnterpriseKnowledgeFacade).toBeTypeOf(
      'function',
    );
    expect(enterpriseKnowledge.addEnterpriseKnowledgeInRepository).toBeTypeOf(
      'function',
    );
    expect(
      enterpriseKnowledge.listMemberEnterpriseKnowledgeFromRepository,
    ).toBeTypeOf('function');
  });

  it('matches the stable product registry ownership and dependencies', () => {
    const manifest = PRODUCT_MODULES.find(
      (module) => module.id === 'enterprise_knowledge',
    );
    expect(manifest?.dataOwnership).toEqual(
      expect.arrayContaining(['enterprise knowledge', 'knowledge scopes']),
    );
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
        /enterprise[\\/]db|\.\.\/\.\.\/enterprise/.test(
          fs.readFileSync(path.join(moduleDir, file), 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('removes the legacy repository and keeps SQL behind the facade', () => {
    const databaseFacade = fs.readFileSync(databaseFacadePath, 'utf8');
    expect(fs.existsSync(legacyRepositoryPath)).toBe(false);
    expect(databaseFacade).toContain('createEnterpriseKnowledgeFacade');
    expect(databaseFacade).not.toContain("from './knowledgeRepository.js'");
    expect(databaseFacade).not.toContain('INSERT INTO knowledge');
    expect(databaseFacade).not.toContain('content LIKE ?');
  });
});
