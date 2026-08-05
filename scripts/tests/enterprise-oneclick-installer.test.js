/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const COMMON_SH = path.resolve('deployment/enterprise-oneclick/lib/common.sh');
const INSTALL_SH = path.resolve('deployment/enterprise-oneclick/install.sh');
const EXPORT_MIGRATION_SH = path.resolve(
  'deployment/enterprise-oneclick/export-migration.sh',
);
const DB_TOOL = path.resolve(
  'deployment/enterprise-oneclick/tools/db-tool.mjs',
);
const MIGRATE_CHECK = path.resolve(
  'deployment/enterprise-oneclick/tools/migrate-check.mjs',
);
const HEALTH_CHECK = path.resolve(
  'deployment/enterprise-oneclick/tools/health-check.mjs',
);
const VERIFY_RELEASE = path.resolve(
  'deployment/enterprise-oneclick/tools/verify-release.mjs',
);
const ENV_EXAMPLE = path.resolve(
  'deployment/enterprise-oneclick/config/enterprise.env.example',
);
const README = path.resolve('deployment/enterprise-oneclick/README.zh-CN.md');
const BUNDLE_SCRIPT = path.resolve('scripts/build-enterprise-oneclick.mjs');
const SERVER_DATABASE = path.resolve('packages/server/src/enterprise/db.ts');
const RUNTIME_ENTRY = path.resolve(
  'deployment/enterprise-oneclick/runtime/run.mjs',
);
const SYSTEMD_SERVICE = path.resolve(
  'deployment/enterprise-oneclick/templates/otto-enterprise.service',
);
const SERVER_DATABASE_SOURCE = readFileSync(SERVER_DATABASE, 'utf8');
const ENTERPRISE_SCHEMA_VERSION = Number(
  /export const ENTERPRISE_SCHEMA_VERSION\s*=\s*(\d+)/.exec(
    SERVER_DATABASE_SOURCE,
  )?.[1],
);
if (!Number.isInteger(ENTERPRISE_SCHEMA_VERSION)) {
  throw new Error('unable to resolve ENTERPRISE_SCHEMA_VERSION for release tests');
}
const SUPPORTED_SCHEMA_VERSIONS = Array.from(
  { length: ENTERPRISE_SCHEMA_VERSION - 1 },
  (_, index) => index + 2,
);

function mode(target) {
  return statSync(target).mode & 0o777;
}

describe('enterprise one-click service layout', () => {
  it.skipIf(process.platform === 'win32')(
    'makes the root-owned runtime and release traversable by the systemd user',
    () => {
      const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-oneclick-layout-'));
      try {
        const installRoot = path.join(sandbox, 'opt', 'otto-enterprise');
        const runtime = path.join(installRoot, 'runtime');
        const nodeBin = path.join(runtime, 'node-v22', 'bin', 'node');
        const releases = path.join(installRoot, 'releases');
        const release = path.join(releases, 'v1.9.0-test');
        const serverEntry = path.join(release, 'src', 'enterprise', 'bin.js');

        mkdirSync(path.dirname(nodeBin), { recursive: true, mode: 0o700 });
        mkdirSync(path.dirname(serverEntry), { recursive: true, mode: 0o700 });
        writeFileSync(nodeBin, '#!/bin/sh\n', { mode: 0o700 });
        writeFileSync(serverEntry, 'export {};\n', { mode: 0o600 });
        for (const target of [
          installRoot,
          runtime,
          path.join(runtime, 'node-v22'),
          path.dirname(nodeBin),
          releases,
          release,
          path.join(release, 'src'),
          path.dirname(serverEntry),
        ]) {
          chmodSync(target, 0o700);
        }

        const result = spawnSync(
          '/bin/bash',
          [
            '-c',
            'source "$1"; shift; otto_prepare_service_layout "$@"',
            'bash',
            COMMON_SH,
            installRoot,
            release,
          ],
          { encoding: 'utf8' },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(mode(installRoot)).toBe(0o755);
        expect(mode(runtime)).toBe(0o755);
        expect(mode(path.join(runtime, 'node-v22', 'bin'))).toBe(0o755);
        expect(mode(nodeBin)).toBe(0o755);
        expect(mode(releases)).toBe(0o755);
        expect(mode(path.dirname(serverEntry))).toBe(0o755);
        expect(mode(serverEntry)).toBe(0o644);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    },
  );

  it('applies the service layout before systemd starts Otto', () => {
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const hardening = installer.indexOf(
      'otto_prepare_service_layout "$INSTALL_ROOT" "$TARGET_RELEASE"',
    );
    const serviceStart = installer.indexOf(
      'systemctl enable --now otto-enterprise',
    );
    expect(hardening).toBeGreaterThan(-1);
    expect(serviceStart).toBeGreaterThan(hardening);
  });

  it('loads License trust only from the signed release and enforces it in production', () => {
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');
    const runtime = readFileSync(RUNTIME_ENTRY, 'utf8');
    const service = readFileSync(SYSTEMD_SERVICE, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');

    expect(bundle).toContain('OTTO_LICENSE_PUBLIC_KEYS is required');
    expect(bundle).toContain(
      "path.join(releaseRoot, 'license-public-keys.json')",
    );
    expect(runtime).toContain("required('OTTO_LICENSE_TRUST_FILE')");
    expect(runtime).toContain("process.env.OTTO_LICENSE_ENFORCE = 'true'");
    expect(
      runtime.indexOf("await import('./src/enterprise/db.js')"),
    ).toBeGreaterThan(
      runtime.indexOf('OTTO_LICENSE_PUBLIC_KEYS = JSON.stringify'),
    );
    expect(service).toContain('Environment=NODE_ENV=production');
    expect(service).toContain('Environment=OTTO_LICENSE_ENFORCE=true');
    expect(service).toContain('license-public-keys.json');
    expect(installer).toContain('export OTTO_LICENSE_TRUST_FILE=');
  });
});

describe('enterprise one-click schema contract', () => {
  it('derives one enterprise schema contract from the server source and release manifest', () => {
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');
    const serverDatabase = SERVER_DATABASE_SOURCE;
    const databaseTool = readFileSync(DB_TOOL, 'utf8');
    const migrationCheck = readFileSync(MIGRATE_CHECK, 'utf8');
    const healthCheck = readFileSync(HEALTH_CHECK, 'utf8');
    const verifyRelease = readFileSync(VERIFY_RELEASE, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const exporter = readFileSync(EXPORT_MIGRATION_SH, 'utf8');

    expect(bundle).toContain(
      "const releaseChannel = process.env.OTTO_RELEASE_CHANNEL?.trim() || 'stable'",
    );
    expect(serverDatabase).toContain(
      `export const ENTERPRISE_SCHEMA_VERSION = ${ENTERPRISE_SCHEMA_VERSION}`,
    );
    expect(bundle).toContain('releaseChannel,');
    expect(bundle).toContain(
      'const schemaVersionMatch = /ENTERPRISE_SCHEMA_VERSION',
    );
    expect(bundle).toContain('schemaFrom: supportedSchemaFrom');
    expect(bundle).toContain('schemaTo: schemaVersion');
    expect(bundle).toContain("filesBelow(path.join(serverDist, 'src'))");
    expect(bundle).toContain(".filter((relative) => relative.endsWith('.js'))");
    expect(databaseTool).toContain('function expectedSchemaVersion()');
    expect(migrationCheck).toContain('manifest?.database?.schemaTo');
    expect(migrationCheck).toContain(
      'readiness.schemaVersion !== expectedSchemaVersion',
    );
    expect(healthCheck).toContain('body.apiVersion !== 4');
    expect(healthCheck).toContain('body.schemaVersion !== expectedSchema');
    expect(verifyRelease).toContain('manifest.database.schemaTo - 1');
    expect(verifyRelease).toContain(
      "!['stable', 'transition'].includes(manifest.releaseChannel)",
    );
    expect(installer).toContain('RELEASE_SCHEMA_TO=');
    expect(installer).toContain('"$IMPORT_SCHEMA" -le "$RELEASE_SCHEMA_TO"');
    expect(exporter).toContain('SCHEMA_TO=');
  });

  it(`accepts v3-v${ENTERPRISE_SCHEMA_VERSION} databases and rejects a future v${ENTERPRISE_SCHEMA_VERSION + 1} database`, () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-oneclick-schema-'));
    try {
      const createDatabase = (schemaVersion) => {
        const target = path.join(sandbox, `schema-${schemaVersion}.db`);
        const database = new DatabaseSync(target);
        database.exec(`
          CREATE TABLE sample (id TEXT PRIMARY KEY);
          INSERT INTO sample (id) VALUES ('preserve-me');
          PRAGMA user_version = ${schemaVersion};
        `);
        database.close();
        return target;
      };

      for (const schemaVersion of SUPPORTED_SCHEMA_VERSIONS.filter(
        (version) => version >= 3,
      )) {
        const inspected = spawnSync(
          process.execPath,
          [DB_TOOL, 'inspect', createDatabase(schemaVersion)],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              OTTO_EXPECTED_SCHEMA_VERSION: String(ENTERPRISE_SCHEMA_VERSION),
            },
          },
        );
        expect(inspected.status, inspected.stderr).toBe(0);
        expect(JSON.parse(inspected.stdout)).toMatchObject({
          userVersion: schemaVersion,
          quickCheck: 'ok',
          foreignKeyCheck: 'ok',
          rowCounts: { sample: 1 },
        });
      }

      const future = spawnSync(
        process.execPath,
        [DB_TOOL, 'inspect', createDatabase(ENTERPRISE_SCHEMA_VERSION + 1)],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            OTTO_EXPECTED_SCHEMA_VERSION: String(ENTERPRISE_SCHEMA_VERSION),
          },
        },
      );
      expect(future.status).toBe(5);
      expect(future.stderr).toContain(
        `高于部署包支持的 ${ENTERPRISE_SCHEMA_VERSION}`,
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 20_000);

  it(`backs up v3 before migration and verifies that v${ENTERPRISE_SCHEMA_VERSION} preserves every row`, () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-oneclick-upgrade-'));
    try {
      const source = path.join(sandbox, 'source-v3.db');
      const backup = path.join(sandbox, 'backup-v3.db');
      const migrated = path.join(
        sandbox,
        `migrated-v${ENTERPRISE_SCHEMA_VERSION}.db`,
      );
      const sourceDatabase = new DatabaseSync(source);
      sourceDatabase.exec(`
        CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO accounts (id, name) VALUES
          ('account-1', '保留账号一'),
          ('account-2', '保留账号二');
        PRAGMA user_version = 3;
      `);
      sourceDatabase.close();

      const backupResult = spawnSync(
        process.execPath,
        [DB_TOOL, 'backup', source, backup],
        { encoding: 'utf8' },
      );
      expect(backupResult.status, backupResult.stderr).toBe(0);
      expect(JSON.parse(backupResult.stdout)).toMatchObject({
        userVersion: 3,
        rowCounts: { accounts: 2 },
      });

      const copyResult = spawnSync(
        process.execPath,
        [DB_TOOL, 'backup', backup, migrated],
        { encoding: 'utf8' },
      );
      expect(copyResult.status, copyResult.stderr).toBe(0);
      const migratedDatabase = new DatabaseSync(migrated);
      migratedDatabase.exec(
        `PRAGMA user_version = ${ENTERPRISE_SCHEMA_VERSION};`,
      );
      migratedDatabase.close();

      const comparison = spawnSync(
        process.execPath,
        [DB_TOOL, 'compare', backup, migrated],
        { encoding: 'utf8' },
      );
      expect(comparison.status, comparison.stderr).toBe(0);
      expect(JSON.parse(comparison.stdout)).toMatchObject({
        before: { userVersion: 3, rowCounts: { accounts: 2 } },
        after: {
          userVersion: ENTERPRISE_SCHEMA_VERSION,
          rowCounts: { accounts: 2 },
        },
        preservedTables: 1,
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects a release manifest that omits its channel or has an inconsistent schema range', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-oneclick-manifest-'));
    try {
      const manifest = {
        format: 'otto-enterprise-release-v1',
        version: '1.9.0-test',
        releaseChannel: 'transition',
        buildCommit: '0'.repeat(40),
        sourceCommit: '1'.repeat(40),
        database: {
          schemaFrom: SUPPORTED_SCHEMA_VERSIONS,
          schemaTo: ENTERPRISE_SCHEMA_VERSION,
          futureSchemaPolicy: 'reject',
        },
        files: {},
      };
      const runtimePackage = `${JSON.stringify({ type: 'module', version: manifest.version })}\n`;
      writeFileSync(path.join(sandbox, 'package.json'), runtimePackage);
      manifest.files['package.json'] = createHash('sha256')
        .update(runtimePackage)
        .digest('hex');
      const manifestPath = path.join(sandbox, 'manifest.json');
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

      const valid = spawnSync(process.execPath, [VERIFY_RELEASE, sandbox], {
        encoding: 'utf8',
      });
      expect(valid.status, valid.stderr).toBe(0);
      expect(JSON.parse(valid.stdout)).toMatchObject({
        ok: true,
        releaseChannel: 'transition',
        database: {
          schemaFrom: SUPPORTED_SCHEMA_VERSIONS,
          schemaTo: ENTERPRISE_SCHEMA_VERSION,
          futureSchemaPolicy: 'reject',
        },
      });

      manifest.database.schemaFrom = [2, 3, 4];
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      const stale = spawnSync(process.execPath, [VERIFY_RELEASE, sandbox], {
        encoding: 'utf8',
      });
      expect(stale.status).toBe(3);
      expect(stale.stderr).toContain('manifest.json 格式不正确');

      manifest.database.schemaFrom = SUPPORTED_SCHEMA_VERSIONS;
      delete manifest.releaseChannel;
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      const unmarked = spawnSync(process.execPath, [VERIFY_RELEASE, sandbox], {
        encoding: 'utf8',
      });
      expect(unmarked.status).toBe(3);
      expect(unmarked.stderr).toContain('manifest.json 格式不正确');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it(`accepts only a completed v${ENTERPRISE_SCHEMA_VERSION} migration readiness result`, () => {
    const sandbox = mkdtempSync(
      path.join(tmpdir(), 'otto-oneclick-readiness-'),
    );
    try {
      const release = path.join(sandbox, 'release');
      const data = path.join(sandbox, 'data');
      const databaseModule = path.join(release, 'src', 'enterprise', 'db.js');
      mkdirSync(path.dirname(databaseModule), { recursive: true });
      mkdirSync(data, { recursive: true });
      writeFileSync(
        path.join(release, 'package.json'),
        `${JSON.stringify({ type: 'module' })}\n`,
      );
      writeFileSync(
        path.join(release, 'manifest.json'),
        `${JSON.stringify({ database: { schemaTo: ENTERPRISE_SCHEMA_VERSION } })}\n`,
      );
      const writeDatabaseModule = (schemaVersion) => {
        writeFileSync(
          databaseModule,
          [
            `export const getDatabaseReadiness = () => ({ ready: true, schemaVersion: ${schemaVersion} });`,
            'export const closeEnterpriseDatabase = () => {};',
            '',
          ].join('\n'),
        );
      };

      writeDatabaseModule(ENTERPRISE_SCHEMA_VERSION);
      const ready = spawnSync(
        process.execPath,
        [MIGRATE_CHECK, release, data],
        { encoding: 'utf8' },
      );
      expect(ready.status, ready.stderr).toBe(0);
      expect(JSON.parse(ready.stdout)).toEqual({
        ready: true,
        schemaVersion: ENTERPRISE_SCHEMA_VERSION,
      });

      writeDatabaseModule(3);
      const stale = spawnSync(
        process.execPath,
        [MIGRATE_CHECK, release, data],
        { encoding: 'utf8' },
      );
      expect(stale.status).toBe(5);
      expect(stale.stderr).toContain('"schemaVersion":3');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('migrates only an isolated copy and compares rows before installing it', () => {
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const stageCopy = installer.indexOf(
      'cp "$MIGRATION_DB" "${CANARY_DIR}/data.db"',
    );
    const migration = installer.indexOf(
      '"${SCRIPT_DIR}/tools/migrate-check.mjs"',
    );
    const rowComparison = installer.indexOf(
      'compare "$MIGRATION_DB" "${CANARY_DIR}/data.db"',
    );
    const finalInstall = installer.indexOf(
      '"${CANARY_DIR}/data.db" "${DATA_DIR}/data.db"',
    );

    expect(stageCopy).toBeGreaterThan(-1);
    expect(migration).toBeGreaterThan(stageCopy);
    expect(rowComparison).toBeGreaterThan(migration);
    expect(finalInstall).toBeGreaterThan(rowComparison);
  });
});

describe('enterprise one-click runtime configuration contract', () => {
  it('preserves data governance, telemetry and external encryption key settings', () => {
    const envExample = readFileSync(ENV_EXAMPLE, 'utf8');
    const common = readFileSync(COMMON_SH, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const readme = readFileSync(README, 'utf8');
    const allowlist =
      common.match(/case "\$key" in([\s\S]*?)\n\s*\*\)/)?.[1] ?? '';
    const runtimeEnv =
      installer.match(
        /write_env "\$ENV_TEMP" \\\n([\s\S]*?)\ninstall -o root/,
      )?.[1] ?? '';
    const keys = [
      'OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE',
      'OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE',
      'OTTO_FIELD_ENCRYPTION_KEY_FILE',
      'OTTO_TELEMETRY_ENDPOINT',
      'OTTO_TELEMETRY_RETENTION_DAYS',
      'OTTO_DATA_CONTROLLER_NAME',
      'OTTO_PRIVACY_CONTACT',
      'OTTO_DATA_REGION',
      'OTTO_DATA_RESIDENCY',
      'OTTO_STORAGE_VOLUME_ENCRYPTED',
      'OTTO_CROSS_BORDER_DATA_ENABLED',
    ];

    for (const key of keys) {
      expect(envExample).toMatch(new RegExp(`^${key}=`, 'm'));
      expect(allowlist).toContain(key);
      expect(runtimeEnv).toContain(`  ${key} `);
      expect(readme).toContain(`\`${key}\``);
    }
  });

  it('preserves repair notification and Feishu configuration through installation', () => {
    const envExample = readFileSync(ENV_EXAMPLE, 'utf8');
    const common = readFileSync(COMMON_SH, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const readme = readFileSync(README, 'utf8');
    const allowlist =
      common.match(/case "\$key" in([\s\S]*?)\n\s*\*\)/)?.[1] ?? '';
    const runtimeEnv =
      installer.match(
        /write_env "\$ENV_TEMP" \\\n([\s\S]*?)\ninstall -o root/,
      )?.[1] ?? '';
    const keys = [
      'ALIYUN_SMS_NOTIFICATION_TEMPLATE_ID',
      'OTTO_ENTERPRISE_FEISHU_APP_ID',
      'OTTO_ENTERPRISE_FEISHU_APP_SECRET',
      'OTTO_ENTERPRISE_FEISHU_DOMAIN',
    ];

    for (const key of keys) {
      expect(envExample).toMatch(new RegExp(`^${key}=`, 'm'));
      expect(allowlist).toContain(key);
      expect(runtimeEnv).toContain(`  ${key} "\${${key}:-}"`);
      expect(readme).toContain(`\`${key}\``);
    }
  });
});

describe('enterprise one-click health contract', () => {
  it('requires upgrade, A2A and park repair capabilities in canary and acceptance docs', () => {
    const healthCheck = readFileSync(HEALTH_CHECK, 'utf8');
    const readme = readFileSync(README, 'utf8');

    for (const capability of [
      'personal_enterprise_upgrade',
      'atoa',
      'park_repair_v1',
      'data_protection_v1',
      'encrypted_attachment_storage_v1',
      'encrypted_message_storage_v1',
      'signed_telemetry_transport_v1',
    ]) {
      expect(healthCheck).toContain(`  '${capability}',`);
      expect(readme).toContain(`\`${capability}\``);
    }
  });
});

describe('enterprise one-click provenance contract', () => {
  it('tracks every root build input in both dirty scope and source hashes', () => {
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');
    const sourceScope =
      bundle.match(/const sourceScope = \[([\s\S]*?)\n\];/)?.[1] ?? '';
    const sourceInputFiles =
      bundle.match(
        /const sourceInputFiles = \[([\s\S]*?)\n\]\.sort\(\);/,
      )?.[1] ?? '';

    for (const input of ['tsconfig.json', 'scripts/build_package.js']) {
      expect(sourceScope).toContain(`  '${input}',`);
      expect(sourceInputFiles).toContain(`  '${input}',`);
    }
  });
});
