/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
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
const DB_TOOL = path.resolve('deployment/enterprise-oneclick/tools/db-tool.mjs');
const MIGRATE_CHECK = path.resolve(
  'deployment/enterprise-oneclick/tools/migrate-check.mjs',
);
const HEALTH_CHECK = path.resolve(
  'deployment/enterprise-oneclick/tools/health-check.mjs',
);
const ENV_EXAMPLE = path.resolve(
  'deployment/enterprise-oneclick/config/enterprise.env.example',
);
const README = path.resolve('deployment/enterprise-oneclick/README.zh-CN.md');
const BUNDLE_SCRIPT = path.resolve('scripts/build-enterprise-oneclick.mjs');

function mode(target) {
  return statSync(target).mode & 0o777;
}

describe('enterprise one-click service layout', () => {
  it('makes the root-owned runtime and release traversable by the systemd user', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-oneclick-layout-'));
    try {
      const installRoot = path.join(sandbox, 'opt', 'otto-enterprise');
      const runtime = path.join(installRoot, 'runtime');
      const nodeBin = path.join(runtime, 'node-v22', 'bin', 'node');
      const releases = path.join(installRoot, 'releases');
      const release = path.join(releases, 'v1.8.9-test');
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
  });

  it('applies the service layout before systemd starts Otto', () => {
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const hardening = installer.indexOf(
      'otto_prepare_service_layout "$INSTALL_ROOT" "$TARGET_RELEASE"',
    );
    const serviceStart = installer.indexOf('systemctl enable --now otto-enterprise');
    expect(hardening).toBeGreaterThan(-1);
    expect(serviceStart).toBeGreaterThan(hardening);
  });
});

describe('enterprise one-click schema contract', () => {
  it('declares v2/v3 migration input and v3 output consistently', () => {
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');
    const databaseTool = readFileSync(DB_TOOL, 'utf8');
    const migrationCheck = readFileSync(MIGRATE_CHECK, 'utf8');
    const healthCheck = readFileSync(HEALTH_CHECK, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const exporter = readFileSync(EXPORT_MIGRATION_SH, 'utf8');

    expect(bundle).toContain('schemaFrom: [2, 3]');
    expect(bundle).toContain('schemaTo: 3');
    expect(bundle).toContain("'src/enterprise/repairNotifications.js',");
    expect(databaseTool).toContain('const EXPECTED_SCHEMA_VERSION = 3');
    expect(migrationCheck).toContain('readiness.schemaVersion !== 3');
    expect(healthCheck).toContain('body.apiVersion !== 3');
    expect(healthCheck).toContain('body.schemaVersion !== 3');
    expect(installer).toContain('2|3) ;;');
    expect(exporter).toContain('2|3) ;;');
  });

  it('accepts a current v3 database and rejects a future v4 database', () => {
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

      const v3 = spawnSync(
        process.execPath,
        [DB_TOOL, 'inspect', createDatabase(3)],
        { encoding: 'utf8' },
      );
      expect(v3.status, v3.stderr).toBe(0);
      expect(JSON.parse(v3.stdout)).toMatchObject({
        userVersion: 3,
        quickCheck: 'ok',
        foreignKeyCheck: 'ok',
        rowCounts: { sample: 1 },
      });

      const v4 = spawnSync(
        process.execPath,
        [DB_TOOL, 'inspect', createDatabase(4)],
        { encoding: 'utf8' },
      );
      expect(v4.status).toBe(5);
      expect(v4.stderr).toContain('高于部署包支持的 3');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('enterprise one-click runtime configuration contract', () => {
  it('preserves repair notification and Feishu configuration through installation', () => {
    const envExample = readFileSync(ENV_EXAMPLE, 'utf8');
    const common = readFileSync(COMMON_SH, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const readme = readFileSync(README, 'utf8');
    const allowlist = common.match(/case "\$key" in([\s\S]*?)\n\s*\*\)/)?.[1] ?? '';
    const runtimeEnv = installer.match(
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
  it('requires A2A and park repair capabilities in canary and acceptance docs', () => {
    const healthCheck = readFileSync(HEALTH_CHECK, 'utf8');
    const readme = readFileSync(README, 'utf8');

    for (const capability of ['atoa', 'park_repair_v1']) {
      expect(healthCheck).toContain(`  '${capability}',`);
      expect(readme).toContain(`\`${capability}\``);
    }
  });
});

describe('enterprise one-click provenance contract', () => {
  it('tracks every root build input in both dirty scope and source hashes', () => {
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');
    const sourceScope = bundle.match(/const sourceScope = \[([\s\S]*?)\n\];/)?.[1] ?? '';
    const sourceInputFiles = bundle.match(
      /const sourceInputFiles = \[([\s\S]*?)\n\]\.sort\(\);/,
    )?.[1] ?? '';

    for (const input of ['tsconfig.json', 'scripts/build_package.js']) {
      expect(sourceScope).toContain(`  '${input}',`);
      expect(sourceInputFiles).toContain(`  '${input}',`);
    }
  });
});
