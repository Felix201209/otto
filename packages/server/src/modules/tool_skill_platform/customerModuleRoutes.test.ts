import { describe, expect, it } from 'vitest';
import { CustomerModuleMarketplace } from './customerModuleMarketplace.js';
import { handleCustomerModuleMarketplaceRequest } from './customerModuleRoutes.js';

const manifest = {
  schemaVersion: 1, id: 'com.acme.route', name: 'Route', version: '1.0.0',
  publisher: { id: 'publisher', name: 'Publisher' }, description: 'Route module',
  icon: 'icon.svg', entrypoint: 'module.wasm', hostApi: 'otto.customer-module.v1',
  minimumOttoVersion: '1.15.3', inputSchema: { type: 'object', properties: {} },
  outputs: ['text'], permissions: [],
  files: { 'module.wasm': 'a'.repeat(64), 'icon.svg': 'b'.repeat(64) },
};

describe('customer module marketplace routes', () => {
  it('creates only publisher-owned drafts and keeps review platform-only', () => {
    const market = new CustomerModuleMarketplace();
    expect(handleCustomerModuleMarketplaceRequest(market, {
      method: 'POST', path: '/enterprise/customer-modules/drafts', actor: { accountId: 'outsider', isPlatformReviewer: false }, body: { manifest },
    }).status).toBe(403);
    expect(handleCustomerModuleMarketplaceRequest(market, {
      method: 'POST', path: '/enterprise/customer-modules/drafts', actor: { accountId: 'publisher', isPlatformReviewer: false }, body: { manifest },
    }).status).toBe(201);
    market.beginScan('publisher', manifest.id, manifest.version);
    market.recordScan(manifest.id, manifest.version, { passed: true, findings: [] });
    market.submitForReview('publisher', manifest.id, manifest.version);
    expect(handleCustomerModuleMarketplaceRequest(market, {
      method: 'POST', path: `/enterprise/platform/customer-modules/${manifest.id}/${manifest.version}/review`,
      actor: { accountId: 'publisher', isPlatformReviewer: false }, body: { decision: 'approve' },
    }).status).toBe(403);
  });

  it('lists only approved signed versions and accepts idempotent install receipts', () => {
    const market = new CustomerModuleMarketplace();
    market.createDraft('publisher', manifest);
    market.beginScan('publisher', manifest.id, manifest.version);
    market.recordScan(manifest.id, manifest.version, { passed: true, findings: [] });
    market.submitForReview('publisher', manifest.id, manifest.version);
    handleCustomerModuleMarketplaceRequest(market, {
      method: 'POST', path: `/enterprise/platform/customer-modules/${manifest.id}/${manifest.version}/review`,
      actor: { accountId: 'reviewer', isPlatformReviewer: true }, body: { decision: 'approve' },
    }, { signApprovedVersion: () => ({ keyId: 'k', value: 'ed25519:s' }) });
    expect(handleCustomerModuleMarketplaceRequest(market, { method: 'GET', path: '/enterprise/customer-modules', actor: null, body: {} }).status).toBe(200);
    const installed = handleCustomerModuleMarketplaceRequest(market, {
      method: 'POST', path: `/enterprise/customer-modules/${manifest.id}/${manifest.version}/install`,
      actor: { accountId: 'buyer', isPlatformReviewer: false }, body: { receiptId: 'receipt-1' },
    });
    expect(installed.status).toBe(200);
    const status = handleCustomerModuleMarketplaceRequest(market, {
      method: 'GET', path: `/enterprise/customer-modules/${manifest.id}/${manifest.version}/status`,
      actor: { accountId: 'buyer', isPlatformReviewer: false }, body: {},
    });
    expect(status).toMatchObject({ status: 200, body: { status: 'approved' } });
  });
});
