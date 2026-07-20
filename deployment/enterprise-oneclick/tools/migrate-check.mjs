#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(message) {
  process.stderr.write(`[Otto Migration] ${message}\n`);
  process.exit(5);
}

const releaseDir = path.resolve(process.argv[2] || '');
const dataDir = path.resolve(process.argv[3] || '');
if (!process.argv[2] || !process.argv[3]) {
  fail('用法：migrate-check.mjs <release-dir> <isolated-data-dir>');
}
process.env.OTTO_ENTERPRISE_DIR = dataDir;

const dbModuleUrl = pathToFileURL(
  path.join(releaseDir, 'src/enterprise/db.js'),
).href;
let database;
try {
  database = await import(dbModuleUrl);
  const readiness = database.getDatabaseReadiness();
  if (readiness.ready !== true || readiness.schemaVersion !== 3) {
    fail(`迁移后 readiness 不正确：${JSON.stringify(readiness)}`);
  }
  process.stdout.write(`${JSON.stringify(readiness)}\n`);
} finally {
  database?.closeEnterpriseDatabase?.();
}
