/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as modelGateway from './modules/model_gateway/index.js';
import { PRODUCT_MODULES } from './productModules.js';

const sourceRoot = path.resolve(import.meta.dirname);
const moduleDir = path.join(sourceRoot, 'modules', 'model_gateway');
const databaseFacadePath = path.join(sourceRoot, 'enterprise', 'db.ts');

describe('model gateway module boundary', () => {
  it('publishes model usage metering through one public entrypoint', () => {
    expect(modelGateway.MODEL_GATEWAY_SCHEMA_CONTRIBUTOR.id).toBe(
      'model_gateway',
    );
    expect(modelGateway.createModelGatewayComposition).toBeTypeOf('function');
    expect(modelGateway.createModelUsageFacade).toBeTypeOf('function');
    expect(modelGateway.recordModelUsageInRepository).toBeTypeOf('function');
    expect(modelGateway.getOrganizationUsageSummaryFromRepository).toBeTypeOf(
      'function',
    );
  });

  it('matches the stable product registry ownership and dependencies', () => {
    const manifest = PRODUCT_MODULES.find(
      (module) => module.id === 'model_gateway',
    );
    expect(manifest?.dataOwnership).toContain('normalized token usage');
    expect(manifest?.dependencies).toContain('data_platform');
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

  it('removes the legacy repository and composes the gateway in db.ts', () => {
    expect(
      fs.existsSync(
        path.join(sourceRoot, 'enterprise', 'tokenUsageRepository.ts'),
      ),
    ).toBe(false);
    const databaseFacade = fs.readFileSync(databaseFacadePath, 'utf8');
    expect(databaseFacade).toContain('createModelGatewayComposition');
    expect(databaseFacade).not.toContain('createModelUsageFacade');
    expect(databaseFacade).not.toContain('createUsageId');
    expect(databaseFacade).toContain('../modules/model_gateway/index.js');
    expect(databaseFacade).not.toContain("from './tokenUsageRepository.js'");
    expect(databaseFacade).not.toContain('INSERT INTO account_token_usage');
    expect(databaseFacade).toContain('MODEL_GATEWAY_SCHEMA_CONTRIBUTOR');
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS account_token_usage',
    );
  });
});
