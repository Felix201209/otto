/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as integrationAdapters from './modules/integration_adapters/index.js';
import { PRODUCT_MODULES } from './productModules.js';

const sourceRoot = path.resolve(import.meta.dirname);
const moduleDir = path.join(sourceRoot, 'modules', 'integration_adapters');

function source(file: string): string {
  return fs.readFileSync(path.join(sourceRoot, file), 'utf8');
}

describe('integration_adapters module boundary', () => {
  it('publishes composition, policy and notification adapters from one public entrypoint', () => {
    expect(integrationAdapters.createIntegrationAdaptersComposition).toBeTypeOf(
      'function',
    );
    expect(integrationAdapters.createFeishuAutoReplyFacade).toBeTypeOf(
      'function',
    );
    expect(
      integrationAdapters.isFeishuAutoReplyEnabledForOpenIdInPolicy,
    ).toBeTypeOf('function');
    expect(integrationAdapters.createRepairSmsSenderFromEnv).toBeTypeOf(
      'function',
    );
    expect(integrationAdapters.createRepairFeishuSenderFromEnv).toBeTypeOf(
      'function',
    );
  });

  it('declares identity and authorization dependencies in the product registry', () => {
    const manifest = PRODUCT_MODULES.find(
      (entry) => entry.id === 'integration_adapters',
    );
    expect(manifest?.dependencies).toEqual(
      expect.arrayContaining(['identity_organization', 'authorization']),
    );
  });

  it('does not let the integration module import the enterprise database or identity tables', () => {
    const files = fs
      .readdirSync(moduleDir)
      .filter((file) => file.endsWith('.ts'));
    const combined = files
      .map((file) => fs.readFileSync(path.join(moduleDir, file), 'utf8'))
      .join('\n');
    expect(combined).not.toMatch(/enterprise[\\/]db|\.\.\/\.\.\/enterprise/);
    expect(combined).not.toMatch(/\b(?:FROM|JOIN)\s+accounts\b/i);
  });

  it('keeps the adapter registration pure and composes authorization in the server shell', () => {
    const registration = source('feishu/register.ts');
    const server = source('server.ts');
    expect(registration).not.toContain('../enterprise/db.js');
    expect(registration).toContain('shouldAutoReply: deps.shouldAutoReply');
    expect(registration).toContain('deps.shouldAutoReply ?? (() => false)');
    expect(server).toContain('isFeishuAutoReplyEnabledForOpenId');
    expect(server).toContain(
      'shouldAutoReply: isFeishuAutoReplyEnabledForOpenId',
    );
  });

  it('keeps account SQL behind identity and integration assembly behind one composition', () => {
    const databaseFacade = source('enterprise/db.ts');
    expect(databaseFacade).toContain('createIntegrationAdaptersComposition');
    expect(databaseFacade).not.toContain('createFeishuAutoReplyFacade');
    expect(databaseFacade).toContain('listFeishuAccountBindings');
    expect(databaseFacade).not.toContain(
      'SELECT DISTINCT organization_id FROM accounts',
    );
    expect(databaseFacade).not.toMatch(
      /export function isFeishuAutoReplyEnabledForOpenId\s*\(/,
    );
  });

  it('keeps notification implementations out of the enterprise shell', () => {
    const server = source('enterprise/server.ts');
    const compatibilityExport = source('enterprise/repairNotifications.ts');
    const notificationSenders = source(
      'modules/integration_adapters/repairNotificationSenders.ts',
    );
    expect(server).toContain('../modules/integration_adapters/index.js');
    expect(server).not.toContain('./repairNotifications.js');
    expect(compatibilityExport).toContain(
      "from '../modules/integration_adapters/index.js'",
    );
    expect(compatibilityExport).not.toContain('export *');
    expect(compatibilityExport).toContain('createRepairSmsSenderFromEnv');
    expect(compatibilityExport).toContain('createRepairFeishuSenderFromEnv');
    expect(compatibilityExport).toContain('type RepairNotificationSender');
    expect(notificationSenders).not.toMatch(
      /^import .* from ['"]otto-core['"];$/m,
    );
    expect(notificationSenders).toContain("await import('otto-core')");
  });
});
