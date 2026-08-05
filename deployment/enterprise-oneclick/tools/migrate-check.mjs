#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

function fail(message) {
  process.stderr.write(`[Otto Migration] ${message}\n`);
  process.exit(5);
}

const releaseDir = path.resolve(process.argv[2] || '');
const dataDir = path.resolve(process.argv[3] || '');
const baselineInspectionPath = process.argv[4]
  ? path.resolve(process.argv[4])
  : null;
if (!process.argv[2] || !process.argv[3]) {
  fail(
    '用法：migrate-check.mjs <release-dir> <isolated-data-dir> [baseline-inspection.json]',
  );
}
process.env.OTTO_ENTERPRISE_DIR = dataDir;
const manifest = JSON.parse(
  await readFile(path.join(releaseDir, 'manifest.json'), 'utf8'),
);
const expectedSchemaVersion = Number(manifest?.database?.schemaTo);
if (!Number.isInteger(expectedSchemaVersion) || expectedSchemaVersion < 2) {
  fail('release manifest does not declare a valid schema target');
}

const dbModuleUrl = pathToFileURL(
  path.join(releaseDir, 'src/enterprise/db.js'),
).href;
let database;
try {
  database = await import(dbModuleUrl);
  const readiness = database.getDatabaseReadiness();
  if (
    readiness.ready !== true ||
    readiness.schemaVersion !== expectedSchemaVersion
  ) {
    fail(`迁移后 readiness 不正确：${JSON.stringify(readiness)}`);
  }
  const handle = database.getDB();
  const quickCheck = handle.prepare('PRAGMA quick_check').all();
  if (
    quickCheck.length !== 1 ||
    String(quickCheck[0]?.quick_check ?? '') !== 'ok'
  ) {
    fail('SQLCipher PRAGMA quick_check failed');
  }
  const foreignKeyProblems = handle.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyProblems.length > 0) {
    fail(
      `SQLCipher foreign_key_check found ${foreignKeyProblems.length} problem(s)`,
    );
  }
  const tables = handle
    .prepare(
      `
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `,
    )
    .all()
    .map((row) => String(row.name));
  const rowCounts = {};
  for (const table of tables) {
    const quotedTable = `"${table.replaceAll('"', '""')}"`;
    rowCounts[table] = Number(
      handle.prepare(`SELECT COUNT(*) AS count FROM ${quotedTable}`).get()
        ?.count ?? 0,
    );
  }
  if (baselineInspectionPath) {
    const baseline = JSON.parse(await readFile(baselineInspectionPath, 'utf8'));
    if (
      baseline?.format !== 'otto-enterprise-sqlite-inspection-v1' ||
      !baseline.rowCounts ||
      typeof baseline.rowCounts !== 'object'
    ) {
      fail('baseline database inspection is invalid');
    }
    const regressions = Object.entries(baseline.rowCounts).flatMap(
      ([table, count]) => {
        if (!(table in rowCounts)) return [`${table}: missing after migration`];
        if (rowCounts[table] < Number(count)) {
          return [`${table}: ${count} -> ${rowCounts[table]}`];
        }
        return [];
      },
    );
    if (regressions.length > 0) {
      fail(
        `migration row-count reconciliation failed: ${regressions.join(', ')}`,
      );
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      format: 'otto-enterprise-sqlcipher-inspection-v1',
      ...readiness,
      quickCheck: 'ok',
      foreignKeyCheck: 'ok',
      tables,
      rowCounts,
    })}\n`,
  );
} finally {
  database?.closeEnterpriseDatabase?.();
}
