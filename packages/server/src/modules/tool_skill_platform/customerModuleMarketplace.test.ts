import { describe, expect, it } from 'vitest';

import type { CustomerModuleManifestV1 } from 'otto-core';
import { CustomerModuleMarketplace } from './customerModuleMarketplace.js';

function manifest(): CustomerModuleManifestV1 {
  return {
    schemaVersion: 1, id: 'com.acme.report', name: 'Report', version: '1.0.0',
    publisher: { id: 'publisher-1', name: 'Acme' }, description: 'Report module',
    icon: 'icon.svg', entrypoint: 'module.wasm', hostApi: 'otto.customer-module.v1',
    minimumOttoVersion: '1.15.3', inputSchema: { type: 'object', properties: {} },
    outputs: ['text'], permissions: [],
    files: { 'module.wasm': 'a'.repeat(64), 'icon.svg': 'b'.repeat(64) },
    signature: { algorithm: 'ed25519', keyId: 'pending', value: 'ed25519:pending' },
  };
}

describe('CustomerModuleMarketplace', () => {
  it('requires a passing scan and human review before public listing', () => {
    const market = new CustomerModuleMarketplace(() => '2026-08-28T00:00:00.000Z');
    const unsigned = manifest();
    delete unsigned.signature;
    market.createDraft('publisher-1', unsigned);
    market.beginScan('publisher-1', 'com.acme.report', '1.0.0');
    expect(() => market.submitForReview('publisher-1', 'com.acme.report', '1.0.0')).toThrow(/scan/);
    market.recordScan('com.acme.report', '1.0.0', { passed: true, findings: [] });
    market.submitForReview('publisher-1', 'com.acme.report', '1.0.0');
    const approved = market.review('reviewer-1', 'com.acme.report', '1.0.0', 'approve', {
      keyId: 'market-v1', value: 'ed25519:approved',
    });
    expect(approved.status).toBe('approved');
    expect(market.listPublic()).toHaveLength(1);
  });

  it('fails closed for failed scans, non-owner submissions and suspended installs', () => {
    const market = new CustomerModuleMarketplace();
    market.createDraft('publisher-1', manifest());
    expect(() => market.beginScan('outsider', 'com.acme.report', '1.0.0')).toThrow(/publisher/);
    market.beginScan('publisher-1', 'com.acme.report', '1.0.0');
    market.recordScan('com.acme.report', '1.0.0', { passed: false, findings: ['unknown import'] });
    expect(() => market.submitForReview('publisher-1', 'com.acme.report', '1.0.0')).toThrow(/scan/);
  });

  it('deduplicates install receipts and blocks withdrawn versions', () => {
    const market = new CustomerModuleMarketplace();
    market.createDraft('publisher-1', manifest());
    market.beginScan('publisher-1', 'com.acme.report', '1.0.0');
    market.recordScan('com.acme.report', '1.0.0', { passed: true, findings: [] });
    market.submitForReview('publisher-1', 'com.acme.report', '1.0.0');
    market.review('reviewer', 'com.acme.report', '1.0.0', 'approve', { keyId: 'key', value: 'ed25519:sig' });
    market.recordInstall('com.acme.report', '1.0.0', 'install-1');
    market.recordInstall('com.acme.report', '1.0.0', 'install-1');
    expect(market.get('com.acme.report', '1.0.0')?.installCount).toBe(1);
    market.withdraw('publisher-1', 'com.acme.report', '1.0.0');
    expect(() => market.recordInstall('com.acme.report', '1.0.0', 'install-2')).toThrow(/approved/);
  });
});
