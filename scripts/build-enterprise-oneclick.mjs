#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(repoRoot, 'deployment', 'enterprise-oneclick');
const outputDir = path.join(repoRoot, 'deliverables');
const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = rootPackage.version;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    ...options,
  });
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout || ''}${result.stderr || ''}` : '';
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${detail}`);
  }
  return options.capture ? String(result.stdout).trim() : '';
}

function sha(bufferOrString, algorithm = 'sha256') {
  return createHash(algorithm).update(bufferOrString).digest('hex');
}

function shaFile(file, algorithm = 'sha256') {
  return sha(readFileSync(file), algorithm);
}

function filesBelow(root, current = root) {
  const output = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) output.push(...filesBelow(root, absolute));
    else if (entry.isFile()) output.push(path.relative(root, absolute));
    else throw new Error(`unsupported release entry: ${absolute}`);
  }
  return output.sort();
}

console.log('[bundle] 构建 otto-core 与 otto-server');
run('npm', ['run', 'build', '--workspace', 'otto-core']);
run('npm', ['run', 'build', '--workspace', 'otto-server']);

const sourceCommit = run('git', ['rev-parse', 'HEAD'], { capture: true });
const sourceScope = [
  'package.json',
  'package-lock.json',
  'packages/server/package.json',
  'packages/server/tsconfig.json',
  'scripts/copy_files.js',
  'packages/server/src/enterprise',
  'packages/server/src/sqlite-compat.ts',
  'packages/core/package.json',
  'packages/core/tsconfig.json',
  'packages/core/src/services/aliyunSmsSender.ts',
  'deployment/enterprise-oneclick',
  'scripts/build-enterprise-oneclick.mjs',
];
const sourceStatus = run(
  'git',
  ['status', '--porcelain', '--untracked-files=all', '--', ...sourceScope],
  { capture: true },
);
const sourceTreeDirty = sourceStatus.length > 0;
const sourceInputFiles = [
  'package.json',
  'package-lock.json',
  'packages/server/package.json',
  'packages/server/tsconfig.json',
  'scripts/copy_files.js',
  'packages/server/src/sqlite-compat.ts',
  'packages/core/package.json',
  'packages/core/tsconfig.json',
  'packages/core/src/services/aliyunSmsSender.ts',
  'scripts/build-enterprise-oneclick.mjs',
  ...filesBelow(path.join(repoRoot, 'packages', 'server', 'src', 'enterprise'))
    .map((relative) => path.join('packages/server/src/enterprise', relative)),
  ...filesBelow(sourceDir)
    .map((relative) => path.join('deployment/enterprise-oneclick', relative)),
].sort();
const sourceInputHashes = Object.fromEntries(
  sourceInputFiles.map((relative) => [relative, shaFile(path.join(repoRoot, relative))]),
);
const sourceInputIdentity = sourceInputFiles
  .map((relative) => `${relative}\0${sourceInputHashes[relative]}\n`)
  .join('');
const sourceInputSha256 = sha(sourceInputIdentity);

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'otto-enterprise-oneclick-'));
try {
  const packageNameBase = `otto-enterprise-oneclick-v${version}`;
  const packageRoot = path.join(temporaryRoot, packageNameBase);
  cpSync(sourceDir, packageRoot, {
    recursive: true,
    filter: (source) => path.basename(source) !== 'release',
  });
  const releaseRoot = path.join(packageRoot, 'release');
  mkdirSync(path.join(releaseRoot, 'src', 'enterprise', 'public'), { recursive: true });
  mkdirSync(path.join(releaseRoot, 'node_modules', 'otto-core', 'dist', 'src', 'services'), {
    recursive: true,
  });

  const serverDist = path.join(repoRoot, 'packages', 'server', 'dist');
  const serverFiles = [
    'src/enterprise/bin.js',
    'src/enterprise/server.js',
    'src/enterprise/db.js',
    'src/enterprise/credits.js',
    'src/enterprise/repairNotifications.js',
    'src/enterprise/publicInvite.js',
    'src/enterprise/publicInvitePage.js',
    'src/enterprise/localAgentPage.js',
    'src/enterprise/public/otto-discovery.js',
    'src/sqlite-compat.js',
  ];
  for (const relative of serverFiles) {
    const source = path.join(serverDist, relative);
    if (!existsSync(source)) throw new Error(`missing built server file: ${source}`);
    const target = path.join(releaseRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target);
  }

  const smsSource = path.join(
    repoRoot,
    'packages',
    'core',
    'dist',
    'src',
    'services',
    'aliyunSmsSender.js',
  );
  const smsTarget = path.join(
    releaseRoot,
    'node_modules',
    'otto-core',
    'dist',
    'src',
    'services',
    'aliyunSmsSender.js',
  );
  cpSync(smsSource, smsTarget);
  writeFileSync(
    path.join(releaseRoot, 'node_modules', 'otto-core', 'dist', 'index.js'),
    "export * from './src/services/aliyunSmsSender.js';\n",
  );
  writeFileSync(
    path.join(releaseRoot, 'node_modules', 'otto-core', 'package.json'),
    `${JSON.stringify({
      name: 'otto-core',
      version: '1.1.0-enterprise-adapter',
      private: true,
      type: 'module',
      main: 'dist/index.js',
      exports: { '.': './dist/index.js' },
      dependencies: {},
    }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(releaseRoot, 'package.json'),
    `${JSON.stringify({
      name: 'otto-enterprise-runtime',
      version,
      private: true,
      type: 'module',
      engines: { node: '>=22.16.0 <23' },
    }, null, 2)}\n`,
  );
  cpSync(path.join(sourceDir, 'runtime', 'run.mjs'), path.join(releaseRoot, 'run.mjs'));
  chmodSync(path.join(releaseRoot, 'run.mjs'), 0o755);

  const releaseFiles = filesBelow(releaseRoot);
  const fileHashes = Object.fromEntries(
    releaseFiles.map((relative) => [relative, shaFile(path.join(releaseRoot, relative))]),
  );
  const contentIdentity = releaseFiles
    .map((relative) => `${relative}\0${fileHashes[relative]}\n`)
    .join('');
  const buildCommit = sha(contentIdentity, 'sha1');
  const sourceDiff = run(
    'git',
    ['diff', '--binary', '--', ...sourceScope],
    { capture: true },
  );
  const manifest = {
    format: 'otto-enterprise-release-v1',
    version,
    buildCommit,
    buildIdentityKind: 'release-content-sha1',
    sourceCommit,
    sourceTreeDirty,
    sourceDiffSha256: sha(sourceDiff),
    sourceInputSha256,
    builtAt: new Date().toISOString(),
    runtime: {
      node: '22.23.1',
      supportedArchitectures: ['linux-x64', 'linux-arm64'],
    },
    database: {
      schemaFrom: [2, 3],
      schemaTo: 3,
      futureSchemaPolicy: 'reject',
    },
    files: fileHashes,
  };
  writeFileSync(
    path.join(releaseRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  run(process.execPath, [
    path.join(packageRoot, 'tools', 'verify-release.mjs'),
    releaseRoot,
  ]);

  const finalPackageName = `${packageNameBase}-${buildCommit.slice(0, 12)}`;
  const finalPackageRoot = path.join(temporaryRoot, finalPackageName);
  cpSync(packageRoot, finalPackageRoot, { recursive: true });
  rmSync(packageRoot, { recursive: true, force: true });

  writeFileSync(
    path.join(finalPackageRoot, 'BUILD-INFO.json'),
    `${JSON.stringify({
      version,
      buildCommit,
      sourceCommit,
      sourceTreeDirty,
      sourceDiffSha256: manifest.sourceDiffSha256,
      sourceInputSha256,
      sourceStatus: sourceStatus ? sourceStatus.split('\n') : [],
      nodeVersion: manifest.runtime.node,
      schemaVersion: manifest.database.schemaTo,
    }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(finalPackageRoot, 'SOURCE-INPUTS.sha256'),
    `${sourceInputFiles.map((relative) =>
      `${sourceInputHashes[relative]}  ${relative}`).join('\n')}\n`,
  );

  for (const script of [
    'install.sh',
    'export-migration.sh',
    'verify.sh',
    'lib/common.sh',
    'tools/db-tool.mjs',
    'tools/verify-release.mjs',
    'tools/migrate-check.mjs',
    'tools/health-check.mjs',
  ]) {
    chmodSync(path.join(finalPackageRoot, script), 0o755);
  }

  const packageFiles = filesBelow(finalPackageRoot)
    .filter((relative) => relative !== 'PACKAGE-MANIFEST.sha256');
  writeFileSync(
    path.join(finalPackageRoot, 'PACKAGE-MANIFEST.sha256'),
    `${packageFiles.map((relative) =>
      `${shaFile(path.join(finalPackageRoot, relative))}  ${relative}`).join('\n')}\n`,
  );

  mkdirSync(outputDir, { recursive: true });
  const archive = path.join(outputDir, `${finalPackageName}.tar.gz`);
  const checksum = `${archive}.sha256`;
  if (existsSync(archive) || existsSync(checksum)) {
    throw new Error(`deliverable already exists, refusing overwrite: ${archive}`);
  }
  run('tar', ['--no-xattrs', '-czf', archive, '-C', temporaryRoot, finalPackageName], {
    env: {
      ...process.env,
      COPYFILE_DISABLE: '1',
    },
  });
  const archiveTar = gunzipSync(readFileSync(archive));
  for (const forbiddenMetadataMarker of [
    'LIBARCHIVE.xattr.',
    'SCHILY.xattr.',
    'com.apple.provenance',
  ]) {
    if (archiveTar.includes(Buffer.from(forbiddenMetadataMarker))) {
      throw new Error(`archive contains non-portable metadata marker: ${forbiddenMetadataMarker}`);
    }
  }
  const archiveEntries = run('tar', ['-tzf', archive], { capture: true })
    .split('\n')
    .filter(Boolean);
  const nonPortableEntries = archiveEntries.filter(
    (entry) => path.basename(entry).startsWith('._') || path.basename(entry) === '.DS_Store',
  );
  if (nonPortableEntries.length > 0) {
    throw new Error(`archive contains non-portable entries: ${nonPortableEntries.join(', ')}`);
  }
  const archiveHash = shaFile(archive);
  writeFileSync(checksum, `${archiveHash}  ${path.basename(archive)}\n`);
  console.log(`[bundle] 完成：${archive}`);
  console.log(`[bundle] SHA-256：${archiveHash}`);
  console.log(`[bundle] build id：${buildCommit}`);
  console.log(`[bundle] source commit：${sourceCommit}${sourceTreeDirty ? ' + tracked local changes' : ''}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
