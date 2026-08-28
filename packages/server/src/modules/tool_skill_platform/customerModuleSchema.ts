import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const CUSTOMER_MODULE_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor = {
  id: 'tool_skill_platform_customer_modules',
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS customer_module_versions (
        module_id TEXT NOT NULL,
        version TEXT NOT NULL,
        publisher_id TEXT NOT NULL,
        status TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        scan_report_json TEXT,
        reviewer_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        install_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (module_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_customer_module_public
        ON customer_module_versions(status, updated_at);
      CREATE TABLE IF NOT EXISTS customer_module_install_receipts (
        module_id TEXT NOT NULL,
        version TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (module_id, version, receipt_id),
        FOREIGN KEY (module_id, version)
          REFERENCES customer_module_versions(module_id, version) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS customer_module_artifacts (
        module_id TEXT NOT NULL,
        version TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        body BLOB NOT NULL,
        PRIMARY KEY (module_id, version, path),
        FOREIGN KEY (module_id, version)
          REFERENCES customer_module_versions(module_id, version) ON DELETE CASCADE
      );
    `);
  },
};
