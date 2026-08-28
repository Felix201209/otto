import {
  parseCustomerModuleManifest,
  type CustomerModuleManifestV1,
  type CustomerModuleReviewStatus,
} from 'otto-core';
import {
  InMemoryCustomerModuleMarketplaceStore,
  type CustomerModuleMarketplaceStore,
} from './customerModuleRepository.js';

export interface CustomerModuleScanReport {
  passed: boolean;
  findings: string[];
}

export interface CustomerModuleMarketVersion {
  manifest: CustomerModuleManifestV1;
  publisherId: string;
  status: CustomerModuleReviewStatus;
  scanReport: CustomerModuleScanReport | null;
  reviewerId: string | null;
  createdAt: string;
  updatedAt: string;
  installCount: number;
}

function key(moduleId: string, version: string): string {
  return `${moduleId}@${version}`;
}

export class CustomerModuleMarketplace {
  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly store: CustomerModuleMarketplaceStore = new InMemoryCustomerModuleMarketplaceStore(),
  ) {}

  get(moduleId: string, version: string): CustomerModuleMarketVersion | null {
    return this.store.list().find((record) => key(record.manifest.id, record.manifest.version) === key(moduleId, version)) ?? null;
  }

  listPublic(): CustomerModuleMarketVersion[] {
    return this.store.list().filter((record) => (
      record.status === 'approved' && Boolean(record.manifest.signature)
    ));
  }

  listPublisher(publisherId: string): CustomerModuleMarketVersion[] {
    return this.store.list().filter((record) => record.publisherId === publisherId);
  }

  listReviewQueue(): CustomerModuleMarketVersion[] {
    return this.store.list().filter((record) => record.status === 'scanning' || record.status === 'review');
  }

  createDraft(publisherId: string, rawManifest: unknown): CustomerModuleMarketVersion {
    const manifest = parseCustomerModuleManifest(rawManifest, { requireSignature: false });
    if (manifest.publisher.id !== publisherId) throw new Error('publisher does not own module manifest');
    if (this.get(manifest.id, manifest.version)) throw new Error('customer module version already exists');
    const timestamp = this.now();
    const record: CustomerModuleMarketVersion = {
      manifest, publisherId, status: 'draft', scanReport: null, reviewerId: null,
      createdAt: timestamp, updatedAt: timestamp, installCount: 0,
    };
    this.store.put(record);
    return record;
  }

  private owned(publisherId: string, moduleId: string, version: string): CustomerModuleMarketVersion {
    const record = this.get(moduleId, version);
    if (!record) throw new Error('customer module version not found');
    if (record.publisherId !== publisherId) throw new Error('publisher does not own module version');
    return record;
  }

  beginScan(publisherId: string, moduleId: string, version: string): CustomerModuleMarketVersion {
    const record = this.owned(publisherId, moduleId, version);
    if (record.status !== 'draft' && record.status !== 'rejected') throw new Error('module cannot enter scanning');
    return this.update(record, { status: 'scanning', scanReport: null });
  }

  recordScan(moduleId: string, version: string, report: CustomerModuleScanReport): CustomerModuleMarketVersion {
    const record = this.get(moduleId, version);
    if (!record || record.status !== 'scanning') throw new Error('module is not scanning');
    return this.update(record, { scanReport: { passed: report.passed, findings: [...report.findings] } });
  }

  submitForReview(publisherId: string, moduleId: string, version: string): CustomerModuleMarketVersion {
    const record = this.owned(publisherId, moduleId, version);
    if (record.status !== 'scanning' || !record.scanReport?.passed) throw new Error('passing scan is required');
    return this.update(record, { status: 'review' });
  }

  review(
    reviewerId: string,
    moduleId: string,
    version: string,
    decision: 'approve' | 'reject',
    signature?: { keyId: string; value: string },
  ): CustomerModuleMarketVersion {
    const record = this.get(moduleId, version);
    if (!record || record.status !== 'review') throw new Error('module is not awaiting review');
    if (decision === 'approve' && (!signature?.keyId || !signature.value.startsWith('ed25519:'))) {
      throw new Error('platform signature is required for approval');
    }
    const manifest = decision === 'approve'
      ? { ...record.manifest, signature: { algorithm: 'ed25519' as const, ...signature! } }
      : record.manifest;
    return this.update(record, {
      manifest,
      status: decision === 'approve' ? 'approved' : 'rejected',
      reviewerId,
    });
  }

  suspend(moduleId: string, version: string): CustomerModuleMarketVersion {
    const record = this.get(moduleId, version);
    if (!record || record.status !== 'approved') throw new Error('only approved modules may be suspended');
    return this.update(record, { status: 'suspended' });
  }

  withdraw(publisherId: string, moduleId: string, version: string): CustomerModuleMarketVersion {
    const record = this.owned(publisherId, moduleId, version);
    return this.update(record, { status: 'withdrawn' });
  }

  recordInstall(moduleId: string, version: string, receiptId: string): CustomerModuleMarketVersion {
    const record = this.get(moduleId, version);
    if (!record || record.status !== 'approved') throw new Error('only approved modules may be installed');
    if (this.store.hasInstallReceipt(moduleId, version, receiptId)) return record;
    if (!this.store.addInstallReceipt(moduleId, version, receiptId, this.now())) return record;
    return this.update(record, { installCount: record.installCount + 1 });
  }

  private update(
    record: CustomerModuleMarketVersion,
    patch: Partial<CustomerModuleMarketVersion>,
  ): CustomerModuleMarketVersion {
    const next = { ...record, ...patch, updatedAt: this.now() };
    this.store.put(next);
    return next;
  }
}
