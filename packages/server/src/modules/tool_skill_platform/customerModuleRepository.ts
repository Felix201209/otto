import type { Database } from '../data_platform/index.js';
import type { CustomerModuleMarketVersion } from './customerModuleMarketplace.js';

export interface CustomerModuleMarketplaceStore {
  list(): CustomerModuleMarketVersion[];
  put(record: CustomerModuleMarketVersion): void;
  hasInstallReceipt(moduleId: string, version: string, receiptId: string): boolean;
  addInstallReceipt(moduleId: string, version: string, receiptId: string, createdAt: string): boolean;
  putArtifacts(moduleId: string, version: string, files: ReadonlyMap<string, Uint8Array>, hashes: Readonly<Record<string, string>>): void;
  getArtifacts(moduleId: string, version: string): Map<string, Uint8Array>;
}

interface VersionRow {
  module_id: string;
  version: string;
  publisher_id: string;
  status: CustomerModuleMarketVersion['status'];
  manifest_json: string;
  scan_report_json: string | null;
  reviewer_id: string | null;
  created_at: string;
  updated_at: string;
  install_count: number;
}

export class SqliteCustomerModuleMarketplaceStore implements CustomerModuleMarketplaceStore {
  constructor(private readonly database: Database) {}

  list(): CustomerModuleMarketVersion[] {
    return (this.database.prepare('SELECT * FROM customer_module_versions').all() as VersionRow[])
      .map((row) => ({
        manifest: JSON.parse(row.manifest_json) as CustomerModuleMarketVersion['manifest'],
        publisherId: row.publisher_id,
        status: row.status,
        scanReport: row.scan_report_json ? JSON.parse(row.scan_report_json) as CustomerModuleMarketVersion['scanReport'] : null,
        reviewerId: row.reviewer_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        installCount: row.install_count,
      }));
  }

  put(record: CustomerModuleMarketVersion): void {
    this.database.prepare(`
      INSERT INTO customer_module_versions
        (module_id, version, publisher_id, status, manifest_json, scan_report_json,
         reviewer_id, created_at, updated_at, install_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(module_id, version) DO UPDATE SET
        status = excluded.status, manifest_json = excluded.manifest_json,
        scan_report_json = excluded.scan_report_json, reviewer_id = excluded.reviewer_id,
        updated_at = excluded.updated_at, install_count = excluded.install_count
    `).run(
      record.manifest.id, record.manifest.version, record.publisherId, record.status,
      JSON.stringify(record.manifest), record.scanReport ? JSON.stringify(record.scanReport) : null,
      record.reviewerId, record.createdAt, record.updatedAt, record.installCount,
    );
  }

  hasInstallReceipt(moduleId: string, version: string, receiptId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM customer_module_install_receipts
      WHERE module_id = ? AND version = ? AND receipt_id = ?
    `).get(moduleId, version, receiptId));
  }

  addInstallReceipt(moduleId: string, version: string, receiptId: string, createdAt: string): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO customer_module_install_receipts
        (module_id, version, receipt_id, created_at) VALUES (?, ?, ?, ?)
    `).run(moduleId, version, receiptId, createdAt);
    return Number(result.changes) > 0;
  }

  putArtifacts(moduleId: string, version: string, files: ReadonlyMap<string, Uint8Array>, hashes: Readonly<Record<string, string>>): void {
    const statement = this.database.prepare(`
      INSERT INTO customer_module_artifacts (module_id, version, path, sha256, body)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(module_id, version, path) DO UPDATE SET sha256 = excluded.sha256, body = excluded.body
    `);
    for (const [path, body] of files) statement.run(moduleId, version, path, hashes[path], Buffer.from(body));
  }

  getArtifacts(moduleId: string, version: string): Map<string, Uint8Array> {
    const rows = this.database.prepare(`
      SELECT path, body FROM customer_module_artifacts WHERE module_id = ? AND version = ?
    `).all(moduleId, version) as Array<{ path: string; body: Uint8Array }>;
    return new Map(rows.map((row) => [row.path, Uint8Array.from(row.body)]));
  }
}

export class InMemoryCustomerModuleMarketplaceStore implements CustomerModuleMarketplaceStore {
  private readonly records = new Map<string, CustomerModuleMarketVersion>();
  private readonly receipts = new Set<string>();
  private readonly artifacts = new Map<string, Map<string, Uint8Array>>();
  list(): CustomerModuleMarketVersion[] { return [...this.records.values()]; }
  put(record: CustomerModuleMarketVersion): void { this.records.set(`${record.manifest.id}@${record.manifest.version}`, record); }
  hasInstallReceipt(moduleId: string, version: string, receiptId: string): boolean { return this.receipts.has(`${moduleId}@${version}:${receiptId}`); }
  addInstallReceipt(moduleId: string, version: string, receiptId: string): boolean {
    const key = `${moduleId}@${version}:${receiptId}`;
    if (this.receipts.has(key)) return false;
    this.receipts.add(key); return true;
  }
  putArtifacts(moduleId: string, version: string, files: ReadonlyMap<string, Uint8Array>): void {
    this.artifacts.set(`${moduleId}@${version}`, new Map(
      [...files].map(([path, body]) => [path, Uint8Array.from(body)]),
    ));
  }
  getArtifacts(moduleId: string, version: string): Map<string, Uint8Array> {
    return new Map(this.artifacts.get(`${moduleId}@${version}`) ?? []);
  }
}
