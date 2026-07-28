/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as personalIntelligence from './modules/personal_intelligence/index.js';
import { PRODUCT_MODULES } from './productModules.js';

const sourceRoot = path.resolve(import.meta.dirname);
const moduleDir = path.join(sourceRoot, 'modules', 'personal_intelligence');
const databaseFacadePath = path.join(sourceRoot, 'enterprise', 'db.ts');

describe('personal intelligence module boundary', () => {
  it('publishes worklogs and account restoration from one entrypoint', () => {
    expect(personalIntelligence.createWorklogFacade).toBeTypeOf('function');
    expect(personalIntelligence.logWorkTaskInRepository).toBeTypeOf('function');
    expect(personalIntelligence.buildWorklogReport).toBeTypeOf('function');
    expect(personalIntelligence.createWorklogSchemaContributor).toBeTypeOf(
      'function',
    );
    expect(personalIntelligence.normalizeCostCNY).toBeTypeOf('function');
    expect(personalIntelligence.createAccountSyncFacade).toBeTypeOf('function');
    expect(
      personalIntelligence.PERSONAL_INTELLIGENCE_SCHEMA_CONTRIBUTOR.id,
    ).toBe('personal_intelligence');
    expect(personalIntelligence.ACCOUNT_SYNC_SCOPES).toEqual([
      'personal_memory',
      'worklog',
      'auto_skills',
    ]);
  });

  it('matches the stable product registry ownership and dependencies', () => {
    const manifest = PRODUCT_MODULES.find(
      (module) => module.id === 'personal_intelligence',
    );
    expect(manifest?.dataOwnership).toContain('worklogs');
    expect(manifest?.dependencies).toEqual(
      expect.arrayContaining([
        'agent_runtime',
        'identity_organization',
        'data_platform',
      ]),
    );
  });

  it('does not import enterprise/db or read identity-owned employee tables', () => {
    const offenders = fs
      .readdirSync(moduleDir)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter((file) => {
        const source = fs.readFileSync(path.join(moduleDir, file), 'utf8');
        return (
          /enterprise[\\/]db|\.\.\/\.\.\/enterprise/.test(source) ||
          /\b(?:FROM|JOIN)\s+(?:employees|accounts|organizations)\b/i.test(
            source,
          )
        );
      });
    expect(offenders).toEqual([]);
  });

  it('removes the legacy repository and composes the facade in db.ts', () => {
    expect(
      fs.existsSync(
        path.join(sourceRoot, 'enterprise', 'taskReportRepository.ts'),
      ),
    ).toBe(false);
    const databaseFacade = fs.readFileSync(databaseFacadePath, 'utf8');
    expect(databaseFacade).toContain('createWorklogFacade');
    expect(databaseFacade).toContain('createAccountSyncFacade');
    expect(databaseFacade).toContain(
      '../modules/personal_intelligence/index.js',
    );
    expect(databaseFacade).not.toContain("from './taskReportRepository.js'");
    expect(databaseFacade).not.toContain('INSERT INTO task_logs');
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS task_logs',
    );
    expect(databaseFacade).not.toContain('idx_tasks_organization');
    expect(databaseFacade).toContain('createWorklogSchemaContributor');
    expect(databaseFacade).not.toContain('INSERT INTO account_sync_snapshots');
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS account_sync_snapshots',
    );
    expect(databaseFacade).not.toContain(
      'idx_account_sync_snapshots_org_updated',
    );
    expect(databaseFacade).toContain(
      'PERSONAL_INTELLIGENCE_SCHEMA_CONTRIBUTOR',
    );
    expect(databaseFacade).not.toContain('createCipheriv');
  });
});
