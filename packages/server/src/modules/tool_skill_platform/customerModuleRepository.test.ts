import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import { CustomerModuleMarketplace } from './customerModuleMarketplace.js';
import { SqliteCustomerModuleMarketplaceStore } from './customerModuleRepository.js';
import { CUSTOMER_MODULE_SCHEMA_CONTRIBUTOR } from './customerModuleSchema.js';

describe('SQLite customer module marketplace store', () => {
  it('persists versions and idempotent install receipts across marketplace instances', () => {
    const database = new Database(':memory:');
    CUSTOMER_MODULE_SCHEMA_CONTRIBUTOR.apply(database);
    const store = new SqliteCustomerModuleMarketplaceStore(database);
    const unsigned = {
      schemaVersion: 1, id: 'com.acme.persisted', name: 'Persisted', version: '1.0.0',
      publisher: { id: 'publisher', name: 'Publisher' }, description: 'Persisted module',
      icon: 'icon.svg', entrypoint: 'module.wasm', hostApi: 'otto.customer-module.v1',
      minimumOttoVersion: '1.15.3', inputSchema: { type: 'object', properties: {} },
      outputs: ['text'], permissions: [],
      files: { 'module.wasm': 'a'.repeat(64), 'icon.svg': 'b'.repeat(64) },
    };
    const market = new CustomerModuleMarketplace(() => '2026-08-28T00:00:00.000Z', store);
    market.createDraft('publisher', unsigned);
    market.beginScan('publisher', unsigned.id, unsigned.version);
    market.recordScan(unsigned.id, unsigned.version, { passed: true, findings: [] });
    market.submitForReview('publisher', unsigned.id, unsigned.version);
    market.review('reviewer', unsigned.id, unsigned.version, 'approve', { keyId: 'key', value: 'ed25519:sig' });
    market.recordInstall(unsigned.id, unsigned.version, 'receipt-1');

    const restored = new CustomerModuleMarketplace(undefined, store);
    expect(restored.listPublic()).toHaveLength(1);
    restored.recordInstall(unsigned.id, unsigned.version, 'receipt-1');
    expect(restored.get(unsigned.id, unsigned.version)?.installCount).toBe(1);
    database.close();
  });
});
