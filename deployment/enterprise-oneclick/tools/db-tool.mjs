#!/usr/bin/env node

import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
} from 'node:fs';
import path from 'node:path';

const MAX_DATABASE_BYTES = 20 * 1024 * 1024 * 1024;
const EXPECTED_SCHEMA_VERSION = 2;

function fail(message, code = 5) {
  process.stderr.write(`[Otto DB] ${message}\n`);
  process.exit(code);
}

function regularDatabasePath(input, { mustExist = true } = {}) {
  const resolved = path.resolve(input || '');
  if (!input) fail('数据库路径不能为空', 2);
  if (mustExist && !existsSync(resolved)) fail(`数据库不存在：${resolved}`);
  if (existsSync(resolved)) {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail(`数据库必须是普通文件且不能是符号链接：${resolved}`);
    }
    if (stat.size <= 0 || stat.size > MAX_DATABASE_BYTES) {
      fail(`数据库大小不在允许范围内：${stat.size} bytes`);
    }
  }
  return resolved;
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function inspectDatabase(input) {
  const databasePath = regularDatabasePath(input);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const quickRows = db.prepare('PRAGMA quick_check').all();
    const quickCheck = quickRows.map((row) => String(row.quick_check ?? ''));
    if (quickCheck.length !== 1 || quickCheck[0] !== 'ok') {
      fail(`PRAGMA quick_check 失败：${quickCheck.join('; ') || 'empty result'}`);
    }
    const foreignKeyRows = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyRows.length > 0) {
      fail(`PRAGMA foreign_key_check 发现 ${foreignKeyRows.length} 个问题`);
    }
    const userVersion = Number(
      db.prepare('PRAGMA user_version').get()?.user_version ?? 0,
    );
    if (!Number.isInteger(userVersion) || userVersion < 0) {
      fail(`user_version 非法：${userVersion}`);
    }
    if (userVersion > EXPECTED_SCHEMA_VERSION) {
      fail(
        `数据库 schema ${userVersion} 高于部署包支持的 ${EXPECTED_SCHEMA_VERSION}，拒绝降级`,
      );
    }
    const tables = db.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => String(row.name));
    const rowCounts = {};
    for (const table of tables) {
      rowCounts[table] = Number(
        db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get()?.count ?? 0,
      );
    }
    const stat = lstatSync(databasePath);
    return {
      format: 'otto-enterprise-sqlite-inspection-v1',
      path: databasePath,
      bytes: stat.size,
      sha256: await sha256(databasePath),
      userVersion,
      quickCheck: 'ok',
      foreignKeyCheck: 'ok',
      tables,
      rowCounts,
    };
  } finally {
    db.close();
  }
}

async function backupDatabase(sourceInput, targetInput) {
  const source = regularDatabasePath(sourceInput);
  const target = regularDatabasePath(targetInput, { mustExist: false });
  if (existsSync(target)) fail(`备份目标已存在，拒绝覆盖：${target}`, 2);
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(sourceDb, target, { rate: 256 });
  } finally {
    sourceDb.close();
  }
  const fd = openSync(target, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return inspectDatabase(target);
}

async function compareDatabases(beforeInput, afterInput) {
  const before = await inspectDatabase(beforeInput);
  const after = await inspectDatabase(afterInput);
  const regressions = [];
  for (const [table, count] of Object.entries(before.rowCounts)) {
    if (!(table in after.rowCounts)) {
      regressions.push(`${table}: missing after migration`);
      continue;
    }
    if (after.rowCounts[table] < count) {
      regressions.push(`${table}: ${count} -> ${after.rowCounts[table]}`);
    }
  }
  if (regressions.length > 0) {
    fail(`迁移前后数据对账失败：${regressions.join(', ')}`);
  }
  return {
    format: 'otto-enterprise-sqlite-comparison-v1',
    before,
    after,
    preservedTables: Object.keys(before.rowCounts).length,
  };
}

const [command, ...args] = process.argv.slice(2);
let result;
if (command === 'inspect' && args.length === 1) {
  result = await inspectDatabase(args[0]);
} else if (command === 'backup' && args.length === 2) {
  result = await backupDatabase(args[0], args[1]);
} else if (command === 'compare' && args.length === 2) {
  result = await compareDatabases(args[0], args[1]);
} else {
  fail(
    '用法：db-tool.mjs inspect <db> | backup <source> <target> | compare <before> <after>',
    2,
  );
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
