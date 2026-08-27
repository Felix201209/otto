#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

function fail(message) {
  process.stderr.write(`[Otto Release] ${message}\n`);
  process.exit(3);
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function filesBelow(root, current = root) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) fail(`release 中不允许符号链接：${absolute}`);
    if (entry.isDirectory()) output.push(...(await filesBelow(root, absolute)));
    else if (entry.isFile())
      output.push(path.relative(root, absolute).split(path.sep).join('/'));
    else fail(`release 中只允许普通文件和目录：${absolute}`);
  }
  return output.sort();
}

const options = new Set(process.argv.slice(3));
const allowLegacyLstc = options.delete('--allow-legacy-lstc');
const allowLegacySqlite = options.delete('--allow-legacy-sqlite');
const allowRegistrationLegalHotfix = options.delete(
  '--allow-registration-legal-hotfix',
);
if (options.size > 0) fail(`unsupported option: ${[...options].join(', ')}`);
const allowedReleaseChannels = allowLegacyLstc
  ? ['stable', 'transition', 'lstc']
  : ['stable', 'transition'];

const root = path.resolve(process.argv[2] || '');
if (!process.argv[2]) fail('用法：verify-release.mjs <release-dir>');

const registrationLegalHotfixFiles = ['HOTFIX-INFO', 'HOTFIX-PREVIOUS-RELEASE'];
const registrationLegalHotfixTarget = 'src/enterprise/authRoutes.js';
const registrationLegalImport =
  "import { CURRENT_LEGAL_DOCUMENTS, legalDocumentHash } from '../modules/data_governance/legalDocuments.js';\n";
const registrationLegalResponse =
  '            legalDocuments: CURRENT_LEGAL_DOCUMENTS.map((document) => ({ id: document.id, version: document.version, hash: legalDocumentHash(document) })),\n';

function occurrences(source, marker) {
  return source.split(marker).length - 1;
}

let manifest;
try {
  manifest = JSON.parse(
    await readFile(path.join(root, 'manifest.json'), 'utf8'),
  );
} catch (error) {
  fail(
    `无法读取 manifest.json：${error instanceof Error ? error.message : String(error)}`,
  );
}
if (
  manifest?.format !== 'otto-enterprise-release-v1' ||
  typeof manifest.version !== 'string' ||
  !allowedReleaseChannels.includes(manifest.releaseChannel) ||
  !/^[0-9a-f]{40}$/.test(manifest.buildCommit || '') ||
  typeof manifest.files !== 'object' ||
  Array.isArray(manifest.files) ||
  typeof manifest.database !== 'object' ||
  manifest.database === null ||
  Array.isArray(manifest.database) ||
  !Array.isArray(manifest.database.schemaFrom) ||
  !Number.isInteger(manifest.database.schemaTo) ||
  manifest.database.schemaTo < 2 ||
  JSON.stringify(manifest.database.schemaFrom) !==
    JSON.stringify(
      Array.from(
        { length: manifest.database.schemaTo - 1 },
        (_, index) => index + 2,
      ),
    ) ||
  manifest.database.futureSchemaPolicy !== 'reject' ||
  (!allowLegacySqlite &&
    (manifest.database.encryption !== 'sqlcipher-required' ||
      manifest.database.nativeRuntime !== 'node' ||
      manifest.database.nativeRuntimeVersion !== '22.23.1' ||
      JSON.stringify(manifest.database.nativeTargets) !==
        JSON.stringify(['linux-x64', 'linux-arm64'])))
) {
  fail('manifest.json 格式不正确');
}

let runtimePackage;
try {
  runtimePackage = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  );
} catch (error) {
  fail(
    `无法读取运行时 package.json：${error instanceof Error ? error.message : String(error)}`,
  );
}
if (runtimePackage?.version !== manifest.version) {
  fail(
    `版本漂移：manifest=${manifest.version} runtime=${runtimePackage?.version ?? 'missing'}`,
  );
}

const actualFiles = (await filesBelow(root)).filter(
  (file) => file !== 'manifest.json',
);
const expectedFiles = Object.keys(manifest.files).sort();
const comparableActualFiles = allowRegistrationLegalHotfix
  ? actualFiles.filter((file) => !registrationLegalHotfixFiles.includes(file))
  : actualFiles;
if (JSON.stringify(comparableActualFiles) !== JSON.stringify(expectedFiles)) {
  fail(
    `release 文件集合不一致\n期望：${expectedFiles.join(', ')}\n实际：${actualFiles.join(', ')}`,
  );
}
if (allowRegistrationLegalHotfix) {
  if (
    manifest.version !== '1.9.11' ||
    !registrationLegalHotfixFiles.every((file) => actualFiles.includes(file))
  ) {
    fail('registration legal hotfix 标记与 V1.9.11 不匹配');
  }
  const hotfixInfo = await readFile(path.join(root, 'HOTFIX-INFO'), 'utf8');
  const previousRelease = await readFile(
    path.join(root, 'HOTFIX-PREVIOUS-RELEASE'),
    'utf8',
  );
  if (
    !/^registration legal documents response; GitHub Actions run [1-9][0-9]*\n$/.test(
      hotfixInfo,
    ) ||
    !/^\/opt\/otto-enterprise\/releases\/[A-Za-z0-9][A-Za-z0-9._-]*\n$/.test(
      previousRelease,
    )
  ) {
    fail('registration legal hotfix 审计标记无效');
  }
}
for (const relative of expectedFiles) {
  const expected = manifest.files[relative];
  if (!/^[0-9a-f]{64}$/.test(expected)) fail(`manifest hash 非法：${relative}`);
  if (
    allowRegistrationLegalHotfix &&
    relative === registrationLegalHotfixTarget
  ) {
    const patched = await readFile(path.join(root, relative), 'utf8');
    if (
      occurrences(patched, registrationLegalImport) !== 1 ||
      occurrences(patched, registrationLegalResponse) !== 1
    ) {
      fail('registration legal hotfix 代码标记无效');
    }
    const normalized = patched
      .replace(registrationLegalImport, '')
      .replace(registrationLegalResponse, '');
    const actual = createHash('sha256').update(normalized).digest('hex');
    if (actual !== expected) {
      fail(`registration legal hotfix 基线 SHA-256 不匹配：${relative}`);
    }
    continue;
  }
  const actual = await sha256(path.join(root, relative));
  if (actual !== expected) fail(`SHA-256 不匹配：${relative}`);
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    version: manifest.version,
    releaseChannel: manifest.releaseChannel,
    buildCommit: manifest.buildCommit,
    sourceCommit: manifest.sourceCommit,
    database: manifest.database,
    fileCount: expectedFiles.length,
  })}\n`,
);
