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
  it('publishes the Feishu authorization policy from one public entrypoint', () => {
    expect(integrationAdapters.createFeishuAutoReplyFacade).toBeTypeOf(
      'function',
    );
    expect(
      integrationAdapters.isFeishuAutoReplyEnabledForOpenIdInPolicy,
    ).toBeTypeOf('function');
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

  it('keeps account SQL behind identity and policy logic behind integration adapters', () => {
    const databaseFacade = source('enterprise/db.ts');
    expect(databaseFacade).toContain('createFeishuAutoReplyFacade');
    expect(databaseFacade).toContain('listFeishuAccountBindings');
    expect(databaseFacade).not.toContain(
      'SELECT DISTINCT organization_id FROM accounts',
    );
    expect(databaseFacade).not.toMatch(
      /export function isFeishuAutoReplyEnabledForOpenId\s*\(/,
    );
  });
});
