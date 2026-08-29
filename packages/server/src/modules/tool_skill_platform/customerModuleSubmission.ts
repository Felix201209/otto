import {
  CustomerModuleRunner,
  scanCustomerModuleWasm,
  validateCustomerModuleArchiveEntries,
  verifyCustomerModuleFileHashes,
} from 'otto-core';
import type { CustomerModuleMarketplace } from './customerModuleMarketplace.js';
import type { CustomerModuleMarketplaceStore } from './customerModuleRepository.js';

export async function submitCustomerModulePackage(input: {
  publisherId: string;
  manifest: unknown;
  files: ReadonlyMap<string, Uint8Array>;
  market: CustomerModuleMarketplace;
  store: CustomerModuleMarketplaceStore;
}) {
  const draft = input.market.createDraft(input.publisherId, input.manifest);
  input.market.beginScan(input.publisherId, draft.manifest.id, draft.manifest.version);
  try {
    validateCustomerModuleArchiveEntries(draft.manifest, [...input.files].map(([path, body]) => ({
      path, kind: 'file' as const, size: body.byteLength,
    })), { requireSignature: false });
    await verifyCustomerModuleFileHashes(draft.manifest.files, input.files);
    await scanCustomerModuleWasm(input.files.get(draft.manifest.entrypoint) ?? new Uint8Array());
    const sandbox = await new CustomerModuleRunner().run({
      moduleId: draft.manifest.id,
      version: draft.manifest.version,
      wasm: input.files.get(draft.manifest.entrypoint) ?? new Uint8Array(),
      input: {},
      approvedCapabilities: [],
      limits: { timeoutMs: 250, maxOutputBytes: 64 * 1024 },
    });
    if (sandbox.status === 'timed_out') throw new Error('customer module failed sandbox negative test: execution timed out');
    if (sandbox.status === 'crashed') throw new Error(`customer module failed sandbox negative test: ${sandbox.error ?? 'worker crashed'}`);
    input.store.putArtifacts(
      draft.manifest.id,
      draft.manifest.version,
      input.files,
      draft.manifest.files,
    );
    input.market.recordScan(draft.manifest.id, draft.manifest.version, { passed: true, findings: [] });
    return input.market.submitForReview(input.publisherId, draft.manifest.id, draft.manifest.version);
  } catch (error) {
    input.market.recordScan(draft.manifest.id, draft.manifest.version, {
      passed: false,
      findings: [error instanceof Error ? error.message : String(error)],
    });
    throw error;
  }
}
