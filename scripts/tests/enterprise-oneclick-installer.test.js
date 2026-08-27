/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  existsSync,
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
const STAGE_ENROLLMENT_SECRET = path.resolve(
  'deployment/enterprise-oneclick/tools/stage-enrollment-secret.mjs',
);
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
const UPGRADE_SH = path.resolve('deployment/enterprise-oneclick/upgrade.sh');
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
  throw new Error(
    'unable to resolve ENTERPRISE_SCHEMA_VERSION for release tests',
  );
}
const SUPPORTED_SCHEMA_VERSIONS = Array.from(
  { length: ENTERPRISE_SCHEMA_VERSION - 1 },
  (_, index) => index + 2,
);

function mode(target) {
  return statSync(target).mode & 0o777;
}

function readFirstLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(
      () => reject(new Error('fixture server did not start in time')),
      5_000,
    );
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolve(buffer.slice(0, newline).trim());
    });
    stream.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
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

  it('transactionally installs the enrollment secret in a service-writable directory', () => {
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const service = readFileSync(SYSTEMD_SERVICE, 'utf8');
    const readme = readFileSync(README, 'utf8');
    const backup = installer.indexOf(
      'BOOTSTRAP_SECRET_BACKUP="${TXN_DIR}/previous-deployment-bootstrap-secret"',
    );
    const replacement = installer.indexOf(
      'install -o otto-enterprise -g otto-enterprise -m 0600 \\\n    "$BOOTSTRAP_SECRET_STAGED" "$BOOTSTRAP_SECRET_TARGET"',
    );
    const rollback = installer.indexOf(
      '"$BOOTSTRAP_SECRET_BACKUP" "$BOOTSTRAP_SECRET_TARGET"',
    );
    const successfulCleanup = installer.lastIndexOf(
      'rm -f "$BOOTSTRAP_SECRET_BACKUP"',
    );
    const commitMarker = installer.indexOf('rm -f "$TRANSACTION_MARKER"');

    expect(installer).toContain('BOOTSTRAP_SECRET_DIR="${DATA_DIR}/bootstrap"');
    expect(installer).toContain(
      'BOOTSTRAP_SECRET_TARGET="${BOOTSTRAP_SECRET_DIR}/deployment-enrollment.secret"',
    );
    expect(installer).toContain(
      'install -d -o otto-enterprise -g otto-enterprise -m 0700',
    );
    expect(service).toContain('ReadWritePaths=/var/lib/otto-enterprise');
    expect(readme).toContain(
      '/var/lib/otto-enterprise/bootstrap/deployment-enrollment.secret',
    );
    expect(backup).toBeGreaterThan(-1);
    expect(replacement).toBeGreaterThan(backup);
    expect(rollback).toBeGreaterThan(-1);
    expect(successfulCleanup).toBeGreaterThan(replacement);
    expect(commitMarker).toBeGreaterThan(successfulCleanup);
    expect(installer).toContain('已有部署登记密钥不是普通文件，拒绝替换');
  });

  it('lets Control create the CEO without a legacy default administrator', () => {
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const config = readFileSync(ENV_EXAMPLE, 'utf8');

    expect(installer).toContain(
      'if [ "$ACCOUNT_COUNT" -eq 0 ] && [ -z "$BOOTSTRAP_SECRET_STAGED" ]; then',
    );
    expect(installer).toContain(
      'if [ "$ACCOUNT_COUNT" -eq 0 ] && [ -z "$BOOTSTRAP_SECRET_STAGED" ] && [ "$OTTO_BOOTSTRAP_PASSWORD" != "auto" ]; then',
    );
    expect(config).toContain('仅离线空库时 auto 生成一次性密码');
  });
  it('installs Control command trust independently and rolls it back transactionally', () => {
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const runtime = readFileSync(RUNTIME_ENTRY, 'utf8');
    const backup = installer.indexOf(
      'CONTROL_TRUST_BACKUP="${TXN_DIR}/previous-control-public-keys.json"',
    );
    const replacement = installer.indexOf(
      'install -o root -g otto-enterprise -m 0640 \\\n    "$CONTROL_TRUST_STAGED" "$CONTROL_TRUST_TARGET"',
    );
    const successfulCleanup = installer.lastIndexOf(
      'rm -f "$CONTROL_TRUST_BACKUP"',
    );
    const commitMarker = installer.indexOf('rm -f "$TRANSACTION_MARKER"');

    expect(installer).toContain(
      'OTTO_CONTROL_TRUST_FILE "$CONTROL_TRUST_TARGET"',
    );
    expect(installer).toContain('-u OTTO_CONTROL_TRUST_FILE');
    expect(backup).toBeGreaterThan(-1);
    expect(replacement).toBeGreaterThan(backup);
    expect(successfulCleanup).toBeGreaterThan(replacement);
    expect(commitMarker).toBeGreaterThan(successfulCleanup);
    expect(runtime).toContain(
      "'OTTO_CONTROL_TRUST_FILE is required for automatic deployment enrollment'",
    );
    expect(runtime).toContain('let bootstrapSecretFileExists = false;');
    expect(runtime).toContain("if (error?.code !== 'ENOENT') throw error;");
    expect(runtime).toContain(
      'if (bootstrapSecretFileExists && !controlTrustFileValue)',
    );
    expect(runtime).not.toContain(
      'process.env.OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE?.trim() &&',
    );
    expect(runtime).toMatch(
      /process\.env\.OTTO_ENTERPRISE_CONTROL_PUBLIC_KEYS\s*=\s*JSON\.stringify\(controlPublicKeys\)/u,
    );
    expect(runtime).not.toContain(
      'OTTO_ENTERPRISE_CONTROL_PUBLIC_KEYS = JSON.stringify(licensePublicKeys)',
    );
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
  it('verifies redacted public health through local database and authenticated status', async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-health-check-'));
    const database = new DatabaseSync(path.join(sandbox, 'data.db'));
    database.exec(`PRAGMA user_version = ${ENTERPRISE_SCHEMA_VERSION}`);
    database.close();

    const capabilities = [
      'password_auth',
      'sms_registration',
      'personal_enterprise_upgrade',
      'organization_invites',
      'usage_summary',
      'admin_console',
      'direct_messages',
      'atoa',
      'position_invites',
      'park_service_push',
      'park_repair_v1',
      'data_protection_v1',
      'encrypted_attachment_storage_v1',
      'encrypted_message_storage_v1',
      'signed_telemetry_transport_v1',
      'data_governance_v1',
      'privacy_self_service',
      'managed_model_gateway_v1',
    ];
    const adminToken = 'health-check-admin-token-at-least-32-characters';
    const fixture = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import { createServer } from 'node:http';
          const health = JSON.parse(process.env.HEALTH_FIXTURE);
          const server = createServer((request, response) => {
            response.setHeader('content-type', 'application/json');
            if (request.url === '/enterprise/health') {
              response.end(JSON.stringify(health));
              return;
            }
            if (
              request.url === '/enterprise/deployment/status'
              && request.headers['x-otto-admin-token'] === process.env.ADMIN_TOKEN
            ) {
              response.end(JSON.stringify({
                license: {
                  enforce: true,
                  status: 'active',
                  lease: { required: false, status: 'not_required' },
                },
                runtime: {
                  version: '1.9.11',
                  buildCommit: 'a'.repeat(40),
                  database: {
                    ready: true,
                    schemaVersion: ${ENTERPRISE_SCHEMA_VERSION},
                  },
                  smsConfigured: false,
                },
                operationsSecurity: { sqlCipher: { state: 'active' } },
              }));
              return;
            }
            if (
              request.url === '/enterprise/bootstrap/prepare'
              && request.method === 'POST'
            ) {
              response.end(JSON.stringify({
                readiness: {
                  state: 'ready',
                  canAuthenticate: true,
                  canUseLicensedFeatures: true,
                },
              }));
              return;
            }
            response.statusCode = 401;
            response.end(JSON.stringify({ error: 'unauthorized' }));
          });
          server.listen(0, '127.0.0.1', () => {
            console.log(server.address().port);
          });
        `,
      ],
      {
        env: {
          ...process.env,
          ADMIN_TOKEN: adminToken,
          HEALTH_FIXTURE: JSON.stringify({
            status: 'ok',
            service: 'otto-enterprise',
            apiVersion: 4,
            version: '1.9.11',
            capabilities,
          }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    try {
      const port = Number(await readFirstLine(fixture.stdout));
      expect(Number.isInteger(port)).toBe(true);
      const build = 'a'.repeat(40);
      const result = spawnSync(
        process.execPath,
        [
          HEALTH_CHECK,
          `http://127.0.0.1:${port}`,
          '1.9.11',
          build,
          String(ENTERPRISE_SCHEMA_VERSION),
          'allow-sms-disabled',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            OTTO_BUILD_COMMIT: build,
            OTTO_ENTERPRISE_ADMIN_TOKEN: adminToken,
            OTTO_ENTERPRISE_DIR: sandbox,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        service: 'otto-enterprise',
        version: '1.9.11',
        schemaVersion: ENTERPRISE_SCHEMA_VERSION,
        sqlCipher: 'active',
        licenseEnforced: true,
        deploymentReady: true,
      });
    } finally {
      fixture.kill('SIGTERM');
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 15_000);

  it('derives one enterprise schema contract from the server source and release manifest', () => {
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');
    const serverDatabase = SERVER_DATABASE_SOURCE;
    const databaseTool = readFileSync(DB_TOOL, 'utf8');
    const migrationCheck = readFileSync(MIGRATE_CHECK, 'utf8');
    const healthCheck = readFileSync(HEALTH_CHECK, 'utf8');
    const verifyRelease = readFileSync(VERIFY_RELEASE, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const upgrader = readFileSync(UPGRADE_SH, 'utf8');
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
    expect(bundle).toContain(
      '${buildCommit.slice(0, 12)}-${sourceInputSha256.slice(0, 12)}',
    );
    expect(bundle).toContain("filesBelow(path.join(serverDist, 'src'))");
    expect(bundle).toContain(".filter((relative) => relative.endsWith('.js'))");
    expect(databaseTool).toContain('function expectedSchemaVersion()');
    expect(migrationCheck).toContain('manifest?.database?.schemaTo');
    expect(migrationCheck).toContain(
      'readiness.schemaVersion !== expectedSchemaVersion',
    );
    expect(healthCheck).toContain('publicHealth.apiVersion !== 4');
    expect(migrationCheck).toContain("handle.prepare('PRAGMA quick_check')");
    expect(migrationCheck).toContain(
      "handle.prepare('PRAGMA foreign_key_check')",
    );
    expect(healthCheck).toContain(
      'runtime?.database?.schemaVersion !== expectedSchema',
    );
    expect(healthCheck).toContain(
      "operationsSecurity?.sqlCipher?.state !== 'active'",
    );
    expect(healthCheck).toContain('/enterprise/deployment/status');
    expect(healthCheck).toContain("'x-otto-admin-token': adminToken");
    expect(healthCheck).toContain('public health leaks private fields');
    expect(verifyRelease).toContain('manifest.database.schemaTo - 1');
    expect(verifyRelease).toContain("options.delete('--allow-legacy-lstc')");
    expect(verifyRelease).toContain("? ['stable', 'transition', 'lstc']");
    expect(upgrader).toContain(
      'CURRENT_VERIFY_OPTIONS=(--allow-legacy-lstc --allow-legacy-sqlite)',
    );
    expect(upgrader).toContain(
      'CURRENT_VERIFY_OPTIONS+=(--allow-registration-legal-hotfix)',
    );
    expect(upgrader).toContain(
      '"$CURRENT_REAL" "${CURRENT_VERIFY_OPTIONS[@]}"',
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
          encryption: 'sqlcipher-required',
          nativeRuntime: 'node',
          nativeRuntimeVersion: '22.23.1',
          nativeTargets: ['linux-x64', 'linux-arm64'],
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

      manifest.releaseChannel = 'lstc';
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      const legacyByDefault = spawnSync(
        process.execPath,
        [VERIFY_RELEASE, sandbox],
        { encoding: 'utf8' },
      );
      expect(legacyByDefault.status).toBe(3);
      const legacyUpgrade = spawnSync(
        process.execPath,
        [VERIFY_RELEASE, sandbox, '--allow-legacy-lstc'],
        { encoding: 'utf8' },
      );
      expect(legacyUpgrade.status, legacyUpgrade.stderr).toBe(0);
      expect(JSON.parse(legacyUpgrade.stdout)).toMatchObject({
        ok: true,
        releaseChannel: 'lstc',
      });

      manifest.releaseChannel = 'transition';

      const sqlCipherContract = { ...manifest.database };
      delete manifest.database.encryption;
      delete manifest.database.nativeRuntime;
      delete manifest.database.nativeRuntimeVersion;
      delete manifest.database.nativeTargets;
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      const plaintextByDefault = spawnSync(
        process.execPath,
        [VERIFY_RELEASE, sandbox],
        { encoding: 'utf8' },
      );
      expect(plaintextByDefault.status).toBe(3);
      const plaintextUpgrade = spawnSync(
        process.execPath,
        [VERIFY_RELEASE, sandbox, '--allow-legacy-sqlite'],
        { encoding: 'utf8' },
      );
      expect(plaintextUpgrade.status, plaintextUpgrade.stderr).toBe(0);
      manifest.database = sqlCipherContract;

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

  it('accepts only the audited V1.9.11 registration legal hotfix delta', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-oneclick-hotfix-'));
    try {
      const authDirectory = path.join(sandbox, 'src', 'enterprise');
      mkdirSync(authDirectory, { recursive: true });
      const packageText = `${JSON.stringify({ type: 'module', version: '1.9.11' })}\n`;
      const importMarker = "import * as db from './db.js';\n";
      const responseMarker =
        '            organization: invite ? { id: organization.id, name: organization.name } : null,\n';
      const legalImport =
        "import { CURRENT_LEGAL_DOCUMENTS, legalDocumentHash } from '../modules/data_governance/legalDocuments.js';\n";
      const legalResponse =
        '            legalDocuments: CURRENT_LEGAL_DOCUMENTS.map((document) => ({ id: document.id, version: document.version, hash: legalDocumentHash(document) })),\n';
      const originalAuth = `${importMarker}const invite = null;\nconst organization = { id: 'o', name: 'Otto' };\nconst result = {\n${responseMarker}};\n`;
      const patchedAuth = originalAuth
        .replace(importMarker, importMarker + legalImport)
        .replace(responseMarker, responseMarker + legalResponse);
      const authPath = path.join(authDirectory, 'authRoutes.js');
      writeFileSync(path.join(sandbox, 'package.json'), packageText);
      writeFileSync(authPath, patchedAuth);
      writeFileSync(
        path.join(sandbox, 'HOTFIX-INFO'),
        'registration legal documents response; GitHub Actions run 33029322305\n',
      );
      writeFileSync(
        path.join(sandbox, 'HOTFIX-PREVIOUS-RELEASE'),
        '/opt/otto-enterprise/releases/1.9.11-reviewed\n',
      );
      const hash = (value) => createHash('sha256').update(value).digest('hex');
      const manifest = {
        format: 'otto-enterprise-release-v1',
        version: '1.9.11',
        releaseChannel: 'stable',
        buildCommit: '0'.repeat(40),
        sourceCommit: '1'.repeat(40),
        database: {
          schemaFrom: SUPPORTED_SCHEMA_VERSIONS,
          schemaTo: ENTERPRISE_SCHEMA_VERSION,
          futureSchemaPolicy: 'reject',
          encryption: 'sqlcipher-required',
          nativeRuntime: 'node',
          nativeRuntimeVersion: '22.23.1',
          nativeTargets: ['linux-x64', 'linux-arm64'],
        },
        files: {
          'package.json': hash(packageText),
          'src/enterprise/authRoutes.js': hash(originalAuth),
        },
      };
      writeFileSync(
        path.join(sandbox, 'manifest.json'),
        `${JSON.stringify(manifest)}\n`,
      );

      const strict = spawnSync(process.execPath, [VERIFY_RELEASE, sandbox], {
        encoding: 'utf8',
      });
      expect(strict.status).toBe(3);

      const audited = spawnSync(
        process.execPath,
        [VERIFY_RELEASE, sandbox, '--allow-registration-legal-hotfix'],
        { encoding: 'utf8' },
      );
      expect(audited.status, audited.stderr).toBe(0);

      writeFileSync(authPath, `${patchedAuth}// unrelated mutation\n`);
      const mutated = spawnSync(
        process.execPath,
        [VERIFY_RELEASE, sandbox, '--allow-registration-legal-hotfix'],
        { encoding: 'utf8' },
      );
      expect(mutated.status).toBe(3);
      expect(mutated.stderr).toContain('基线 SHA-256 不匹配');
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
            `export const getDB = () => ({ prepare(sql) { return { all() { if (sql.includes('quick_check')) return [{ quick_check: 'ok' }]; if (sql.includes('foreign_key_check')) return []; if (sql.includes('sqlite_schema')) return [{ name: 'accounts' }]; return []; }, get() { return { count: 2 }; } }; } });`,
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
        format: 'otto-enterprise-sqlcipher-inspection-v1',
        ready: true,
        schemaVersion: ENTERPRISE_SCHEMA_VERSION,
        quickCheck: 'ok',
        foreignKeyCheck: 'ok',
        tables: ['accounts'],
        rowCounts: { accounts: 2 },
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
    const rowComparison = installer.indexOf(
      'MIGRATION_CHECK_ARGS+=(--baseline "$IMPORT_INSPECTION")',
    );
    const migration = installer.indexOf('MIGRATED_INFO="$(');
    const finalInstall = installer.indexOf(
      '"${CANARY_DIR}/data.db" "${DATA_DIR}/data.db"',
    );

    expect(stageCopy).toBeGreaterThan(-1);
    expect(rowComparison).toBeGreaterThan(stageCopy);
    expect(migration).toBeGreaterThan(rowComparison);
    expect(finalInstall).toBeGreaterThan(migration);
  });

  it('takes a consistent database snapshot before a formal cutover', () => {
    const upgrader = readFileSync(UPGRADE_SH, 'utf8');
    const stopBeforeSnapshot = upgrader.indexOf(
      'systemctl stop otto-enterprise\n  SERVICE_STOPPED=1',
    );
    const sqliteSnapshot = upgrader.indexOf(
      '"${SCRIPT_DIR}/tools/db-tool.mjs" backup',
    );
    const migration = upgrader.indexOf(
      '"${SCRIPT_DIR}/tools/migrate-check.mjs"',
    );
    const cutover = upgrader.indexOf(
      '"${CANARY_DIR}/data.db" "${DATA_DIR}/data.db"',
    );

    expect(stopBeforeSnapshot).toBeGreaterThan(-1);
    expect(sqliteSnapshot).toBeGreaterThan(stopBeforeSnapshot);
    expect(migration).toBeGreaterThan(sqliteSnapshot);
    expect(cutover).toBeGreaterThan(migration);
    expect(upgrader).toContain(
      'if [ "$SERVICE_STOPPED" -eq 1 ]; then\n      systemctl daemon-reload',
    );
    expect(upgrader).toContain('UPGRADE_SUCCEEDED=1');
  });
});

describe('enterprise one-click runtime configuration contract', () => {
  it('stages a valid enrollment secret without printing it', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-enrollment-secret-'));
    const source = path.join(sandbox, 'source.secret');
    const target = path.join(sandbox, 'staged.secret');
    const secret = `enrollment_${'a'.repeat(48)}`;

    try {
      writeFileSync(source, `${secret}\n`, { mode: 0o600 });
      chmodSync(source, 0o600);
      const result = spawnSync(
        process.execPath,
        [STAGE_ENROLLMENT_SECRET, source, target],
        { encoding: 'utf8' },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(readFileSync(target, 'utf8')).toBe(`${secret}\n`);
      if (process.platform !== 'win32') expect(mode(target)).toBe(0o600);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects malformed enrollment secrets without leaking their content', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-enrollment-secret-'));
    const source = path.join(sandbox, 'source.secret');
    const target = path.join(sandbox, 'staged.secret');
    const sentinel = `do-not-log-${'b'.repeat(40)}`;

    try {
      writeFileSync(source, `${sentinel}\nsecond-line\n`, { mode: 0o600 });
      chmodSync(source, 0o600);
      const result = spawnSync(
        process.execPath,
        [STAGE_ENROLLMENT_SECRET, source, target],
        { encoding: 'utf8' },
      );

      expect(result.status).toBe(3);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(sentinel);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'rejects an enrollment secret readable by group or others',
    () => {
      const sandbox = mkdtempSync(
        path.join(tmpdir(), 'otto-enrollment-secret-'),
      );
      const source = path.join(sandbox, 'source.secret');
      const target = path.join(sandbox, 'staged.secret');

      try {
        writeFileSync(source, `${'c'.repeat(48)}\n`, { mode: 0o644 });
        chmodSync(source, 0o644);
        const result = spawnSync(
          process.execPath,
          [STAGE_ENROLLMENT_SECRET, source, target],
          { encoding: 'utf8' },
        );

        expect(result.status).toBe(3);
        expect(result.stderr).toContain('group/others');
        expect(existsSync(target)).toBe(false);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    },
  );
  it('accepts every runtime key emitted by the installer during upgrades', () => {
    const common = readFileSync(COMMON_SH, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const allowlist =
      common.match(/case "\$key" in([\s\S]*?)\n\s*\*\)/)?.[1] ?? '';
    const runtimeEnv =
      installer.match(
        /write_env "\$ENV_TEMP" \\\n([\s\S]*?)\ninstall -o root/,
      )?.[1] ?? '';
    const emittedKeys = [
      ...runtimeEnv.matchAll(/^\s{2}([A-Z][A-Z0-9_]+)\s+/gm),
    ].map((match) => match[1]);

    expect(emittedKeys.length).toBeGreaterThan(30);
    for (const key of emittedKeys) expect(allowlist).toContain(key);
  });

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
      'OTTO_BACKUP_ENCRYPTION_KEY_RECOVERY_FILE',
      'OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE',
      'OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE',
      'OTTO_FIELD_ENCRYPTION_KEY_FILE',
      'OTTO_DATABASE_ENCRYPTION_KEY_FILE',
      'OTTO_TELEMETRY_ENDPOINT',
      'OTTO_TELEMETRY_RETENTION_DAYS',
      'OTTO_FEDERATION_ENABLED',
      'OTTO_FEDERATION_GATEWAY_URL',
      'OTTO_FEDERATION_DISPLAY_NAME',
      'OTTO_FEDERATION_POLL_INTERVAL_MS',
      'OTTO_FEDERATION_SIGNING_KEY_FILE',
      'OTTO_EDGE_GATEWAY_URL',
      'OTTO_DATA_CONTROLLER_NAME',
      'OTTO_PRIVACY_CONTACT',
      'OTTO_LEGAL_DOCUMENTS_APPROVED',
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

  it('requires independently readable key custody before enabling backup replicas', () => {
    const installer = readFileSync(INSTALL_SH, 'utf8');

    expect(installer).toContain(
      '启用异地备份时必须配置独立的 OTTO_BACKUP_ENCRYPTION_KEY_RECOVERY_FILE',
    );
    expect(installer).toContain('独立备份恢复密钥与当前归档密钥不一致');
    expect(installer).toContain('服务账号无法读取独立备份恢复密钥');
  });

  it('packages the pinned Linux SQLCipher runtime and persists fail-closed custody settings', () => {
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');
    const common = readFileSync(COMMON_SH, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const migrationCheck = readFileSync(MIGRATE_CHECK, 'utf8');

    expect(bundle).toContain('verifySqlCipherNativeAssets(');
    expect(bundle).toContain("'native', 'sqlcipher-node'");
    expect(bundle).toContain('const betterSqliteTarget = path.join(');
    expect(bundle).toContain("'better-sqlite3',");
    expect(installer).toContain('export OTTO_DATABASE_ENCRYPTION="required"');
    expect(installer).toContain('database-sqlcipher.key');
    expect(installer).toContain('OTTO_DATABASE_ENCRYPTION_KEY_READONLY "true"');
    expect(installer).toContain(
      'native/sqlcipher/linux-${RUNTIME_ARCH}/better_sqlite3.node',
    );
    expect(common).toContain('OTTO_SQLCIPHER_NATIVE_BINDING');
    expect(migrationCheck).toContain(
      "'otto-enterprise-sqlcipher-inspection-v1'",
    );
    expect(migrationCheck).toContain(
      'migration row-count reconciliation failed',
    );
  });

  it('upgrades plaintext and encrypted databases without overwriting custody or allowing downgrade', () => {
    const upgrade = readFileSync(UPGRADE_SH, 'utf8');
    const releaseVerifier = readFileSync(VERIFY_RELEASE, 'utf8');

    expect(upgrade).toContain(
      'CURRENT_VERIFY_OPTIONS=(--allow-legacy-lstc --allow-legacy-sqlite)',
    );
    expect(upgrade).toContain(
      'if [ -f "${CURRENT_REAL}/HOTFIX-INFO" ] || [ -f "${CURRENT_REAL}/HOTFIX-PREVIOUS-RELEASE" ]; then',
    );
    expect(upgrade).toContain(
      'CURRENT_VERIFY_OPTIONS+=(--allow-registration-legal-hotfix)',
    );
    expect(releaseVerifier).toContain(
      "options.delete('--allow-legacy-sqlite')",
    );
    expect(upgrade).toContain('otto_version_at_least "$RELEASE_VERSION"');
    expect(upgrade).toContain('拒绝将服务器从 v${CURRENT_VERSION} 降级');
    expect(upgrade).toContain('export OTTO_DATABASE_ENCRYPTION="required"');
    expect(upgrade).toContain('--snapshot "$OLD_DATA_BACKUP"');
    expect(upgrade).toContain('--baseline "$BASELINE_INSPECTION"');
    expect(upgrade).toContain(
      '"${TARGET_RELEASE}/native/sqlcipher/linux-${RUNTIME_ARCH}/better_sqlite3.node"',
    );
    expect(upgrade).toContain('"$RELEASE_VERSION" "$BUILD_ID" <<\'NODE\'');
    expect(upgrade).toContain("'OTTO_APP_VERSION'");
    expect(upgrade).toContain("'OTTO_BUILD_COMMIT'");
    expect(upgrade).toContain("['OTTO_APP_VERSION', appVersion]");
    expect(upgrade).toContain("['OTTO_BUILD_COMMIT', buildCommit]");
    expect(upgrade).toContain('enterprise.env.before');
    expect(upgrade).toContain(
      'install -o root -g root -m 0600 "$CONFIG_BACKUP" "$CONFIG_PATH"',
    );
    expect(upgrade).toContain('rm -f "$MANAGED_DATABASE_KEY_PATH"');
    expect(upgrade).toContain('拒绝覆盖');
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

  it('keeps enrollment secrets out of ordinary config, diagnostics and canaries', () => {
    const envExample = readFileSync(ENV_EXAMPLE, 'utf8');
    const common = readFileSync(COMMON_SH, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const upgrader = readFileSync(UPGRADE_SH, 'utf8');
    const readme = readFileSync(README, 'utf8');
    const gitignore = readFileSync(path.resolve('.gitignore'), 'utf8');
    const stagingTool = readFileSync(STAGE_ENROLLMENT_SECRET, 'utf8');
    const allowlist =
      common.match(/case "\$key" in([\s\S]*?)\n\s*\*\)/)?.[1] ?? '';
    const runtimeEnv =
      installer.match(
        /write_env "\$ENV_TEMP" \\\n([\s\S]*?)\ninstall -o root/,
      )?.[1] ?? '';

    for (const key of [
      'OTTO_CONTROL_URL',
      'OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE',
      'OTTO_DEPLOYMENT_KIND',
    ]) {
      expect(envExample).toMatch(new RegExp(`^${key}=`, 'm'));
      expect(allowlist).toContain(key);
      expect(readme).toContain(`\`${key}\``);
    }
    expect(envExample).not.toMatch(/^OTTO_DEPLOYMENT_BOOTSTRAP_SECRET=/m);
    expect(allowlist).not.toMatch(/OTTO_DEPLOYMENT_BOOTSTRAP_SECRET\|/);
    expect(readme).not.toContain('`OTTO_DEPLOYMENT_BOOTSTRAP_SECRET`');
    expect(runtimeEnv).toContain('OTTO_CONTROL_URL "$OTTO_CONTROL_URL"');
    expect(runtimeEnv).toContain(
      'OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE "$BOOTSTRAP_SECRET_TARGET"',
    );
    expect(installer).toContain('tools/stage-enrollment-secret.mjs');
    expect(installer).toContain('rm -f "$BOOTSTRAP_SECRET_TARGET"');
    expect(installer).not.toContain('failed-deployment-bootstrap-secret');
    expect(stagingTool).toContain('constants.O_NOFOLLOW');
    expect(stagingTool).not.toContain('console.log');
    expect(upgrader).toContain('-u OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE');
    expect(gitignore).toContain(
      'deployment/enterprise-oneclick/config/deployment-enrollment-secret*',
    );
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');
    expect(bundle).toContain('function isEnrollmentSecretArtifact(candidate)');
    expect(bundle).toContain('!isEnrollmentSecretArtifact(source)');
    expect(bundle).toContain(
      '!isEnrollmentSecretArtifact(path.join(sourceDir, relative))',
    );
  });
});

describe('enterprise one-click health contract', () => {
  it('lets every upgrade canary bind an isolated loopback port without a reserve race', () => {
    const upgrader = readFileSync(UPGRADE_SH, 'utf8');
    const runtime = readFileSync(RUNTIME_ENTRY, 'utf8');

    expect(upgrader).toContain(
      'CANARY_READY_FILE="${TXN_DIR}/canary-ready.json"',
    );
    expect(upgrader).toContain('export OTTO_ENTERPRISE_PORT="0"');
    expect(upgrader).toContain(
      'export OTTO_ENTERPRISE_READY_FILE="$CANARY_READY_FILE"',
    );
    expect(upgrader).toContain('升级 canary 启动后提前退出');
    expect(upgrader).toContain('升级 canary 就绪文件无效');
    expect(upgrader).toContain('"http://127.0.0.1:${CANARY_PORT}"');
    expect(upgrader).not.toContain('server.listen(0, "127.0.0.1"');
    expect(upgrader).not.toContain('OTTO_ENTERPRISE_PORT="17777"');
    expect(upgrader).toContain(
      '"${TARGET_RELEASE}/native/sqlcipher/linux-${RUNTIME_ARCH}/better_sqlite3.node"',
    );
    expect(upgrader).not.toContain(
      '"${INSTALL_ROOT}/current/native/sqlcipher/linux-${RUNTIME_ARCH}/better_sqlite3.node"',
    );
    expect(runtime).toContain('OTTO_ENTERPRISE_READY_FILE');
    expect(runtime).toContain("server.once('listening'");
    expect(runtime).toContain("flag: 'wx'");
  });

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

  it('keeps public health minimal and verifies protected runtime identity', () => {
    const healthCheck = readFileSync(HEALTH_CHECK, 'utf8');
    const verifier = readFileSync(
      path.resolve('deployment/enterprise-oneclick/verify.sh'),
      'utf8',
    );

    expect(healthCheck).toContain('/enterprise/health');
    expect(healthCheck).toContain('/enterprise/deployment/status');
    expect(healthCheck).toContain("'x-otto-admin-token': adminToken");
    expect(healthCheck).toContain('runtime?.buildCommit !== expectedBuild');
    expect(healthCheck).toContain(
      'runtime?.database?.schemaVersion !== expectedSchema',
    );
    expect(healthCheck).toContain(
      "operationsSecurity?.sqlCipher?.state !== 'active'",
    );
    expect(verifier).toContain('otto_load_config "$CONFIG_PATH"');
    expect(verifier).toContain('"$OTTO_ENTERPRISE_ADMIN_TOKEN"');
    expect(verifier).not.toContain('db-tool.mjs" inspect "$DATA_DB"');
  });
});

describe('enterprise one-click provenance contract', () => {
  it('normalizes executable modes inside archives built on Windows', () => {
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');

    expect(bundle).toContain('function normalizeTarExecutableModes(');
    expect(bundle).toContain('writeTarMode(tar, entry.offset, mode)');
    expect(bundle).toContain("'release/run.mjs'");
    expect(bundle).toMatch(
      /normalizeTarExecutableModes\(\s*temporaryTar,\s*finalPackageName,\s*executableFiles\s*\);/,
    );
    expect(bundle).toContain(
      "['--no-xattrs', '-cf', temporaryTar, '-C', temporaryRoot, finalPackageName]",
    );
    expect(bundle).toContain(
      'gzipSync(readFileSync(temporaryTar), { level: 9 })',
    );
  });

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
