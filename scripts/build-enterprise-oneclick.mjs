#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { supportedEnterpriseSchemaVersions } from './enterprise-release-contract.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const sourceDir = path.join(repoRoot, 'deployment', 'enterprise-oneclick');
const outputDir = path.join(repoRoot, 'deliverables');
const rootPackage = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);
const version = rootPackage.version;
const enterpriseDbSource = readFileSync(
  path.join(repoRoot, 'packages', 'server', 'src', 'enterprise', 'db.ts'),
  'utf8',
);
const schemaVersionMatch = /ENTERPRISE_SCHEMA_VERSION\s*=\s*(\d+)/.exec(
  enterpriseDbSource,
);
if (!schemaVersionMatch) {
  throw new Error(
    'unable to resolve ENTERPRISE_SCHEMA_VERSION from server source',
  );
}
const schemaVersion = Number(schemaVersionMatch[1]);
const supportedSchemaFrom = supportedEnterpriseSchemaVersions(schemaVersion);
const releaseChannel = process.env.OTTO_RELEASE_CHANNEL?.trim() || 'stable';
if (!['stable', 'transition'].includes(releaseChannel)) {
  throw new Error('OTTO_RELEASE_CHANNEL must be either stable or transition');
}
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const allowUnsignedEnterprisePackage =
  process.env.OTTO_ALLOW_UNSIGNED_ENTERPRISE_PACKAGE === '1';
const enterpriseSigningPrivateKey = process.env
  .OTTO_ENTERPRISE_SIGNING_PRIVATE_KEY_FILE
  ? readFileSync(process.env.OTTO_ENTERPRISE_SIGNING_PRIVATE_KEY_FILE, 'utf8')
  : process.env.OTTO_ENTERPRISE_SIGNING_PRIVATE_KEY?.replace(/\\n/g, '\n');
if (!enterpriseSigningPrivateKey && !allowUnsignedEnterprisePackage) {
  throw new Error(
    'enterprise package signing key missing; set OTTO_ENTERPRISE_SIGNING_PRIVATE_KEY(_FILE), or explicitly allow an unsigned local build',
  );
}

function normalizeLicensePublicKey(value) {
  const trimmed = value.trim().replace(/\\n/g, '\n');
  const key = trimmed.includes('BEGIN PUBLIC KEY')
    ? createPublicKey(trimmed)
    : createPublicKey({
        key: Buffer.from(trimmed, 'base64'),
        format: 'der',
        type: 'spki',
      });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('license trust store only accepts Ed25519 public keys');
  }
  return key.export({ format: 'pem', type: 'spki' }).toString();
}

function parseLicensePublicKeys(raw) {
  const value = raw?.trim();
  if (!value) {
    throw new Error(
      'OTTO_LICENSE_PUBLIC_KEYS is required for enterprise packages',
    );
  }
  const values = value.startsWith('[') ? JSON.parse(value) : [value];
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('OTTO_LICENSE_PUBLIC_KEYS must contain at least one key');
  }
  return Array.from(
    new Set(
      values.map((item) => {
        if (typeof item !== 'string' || !item.trim()) {
          throw new Error('license public key entry is invalid');
        }
        return normalizeLicensePublicKey(item);
      }),
    ),
  );
}

const licensePublicKeys = parseLicensePublicKeys(
  process.env.OTTO_LICENSE_PUBLIC_KEYS,
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    ...options,
  });
  if (result.status !== 0) {
    const detail = options.capture
      ? `${result.stdout || ''}${result.stderr || ''}`
      : '';
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})\n${detail}`,
    );
  }
  return options.capture ? String(result.stdout).trim() : '';
}

function sha(bufferOrString, algorithm = 'sha256') {
  return createHash(algorithm).update(bufferOrString).digest('hex');
}

function shaFile(file, algorithm = 'sha256') {
  return sha(readFileSync(file), algorithm);
}

function tarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  return buffer
    .subarray(start, end === -1 || end > start + length ? start + length : end)
    .toString('utf8');
}

function tarEntries(buffer) {
  const entries = [];
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const sizeText = tarString(header, 124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`invalid tar entry size for ${prefix}/${name}`);
    }
    entries.push({
      offset,
      path: prefix ? `${prefix}/${name}` : name,
      mode: Number.parseInt(tarString(header, 100, 8).trim() || '0', 8),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function writeTarMode(buffer, headerOffset, mode) {
  const header = buffer.subarray(headerOffset, headerOffset + 512);
  header.fill(0, 100, 108);
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
}

function normalizeTarExecutableModes(tarPath, packageName, executables) {
  const tar = Buffer.from(readFileSync(tarPath));
  const expected = new Map(
    executables.map((relative) => [`${packageName}/${relative}`, 0o755]),
  );
  for (const entry of tarEntries(tar)) {
    const mode = expected.get(entry.path);
    if (mode === undefined) continue;
    writeTarMode(tar, entry.offset, mode);
    expected.delete(entry.path);
  }
  if (expected.size > 0) {
    throw new Error(
      `archive is missing executable entries: ${[...expected.keys()].join(', ')}`,
    );
  }
  writeFileSync(tarPath, tar);

  const incorrect = tarEntries(readFileSync(tarPath)).filter(
    (entry) =>
      executables.some(
        (relative) => entry.path === `${packageName}/${relative}`,
      ) && (entry.mode & 0o111) === 0,
  );
  if (incorrect.length > 0) {
    throw new Error(
      `archive executable modes were not preserved: ${incorrect
        .map((entry) => entry.path)
        .join(', ')}`,
    );
  }
}

function filesBelow(root, current = root) {
  const output = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) output.push(...filesBelow(root, absolute));
    else if (entry.isFile())
      output.push(path.relative(root, absolute).split(path.sep).join('/'));
    else throw new Error(`unsupported release entry: ${absolute}`);
  }
  return output.sort();
}

console.log('[bundle] 构建 otto-core 与 otto-server');
run(npmCommand, ['run', 'build', '--workspace', 'otto-core'], {
  shell: process.platform === 'win32',
});
run(npmCommand, ['run', 'build', '--workspace', 'otto-server'], {
  shell: process.platform === 'win32',
});

const sourceCommit = run('git', ['rev-parse', 'HEAD'], { capture: true });
const sourceScope = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'packages/server/package.json',
  'packages/server/tsconfig.json',
  'scripts/build_package.js',
  'scripts/copy_files.js',
  'packages/server/src',
  'packages/core/package.json',
  'packages/core/tsconfig.json',
  'packages/core/src/services/aliyunSmsSender.ts',
  'deployment/enterprise-oneclick',
  'scripts/build-enterprise-oneclick.mjs',
  'scripts/verify-enterprise-package-signature.mjs',
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
  'tsconfig.json',
  'packages/server/package.json',
  'packages/server/tsconfig.json',
  'scripts/build_package.js',
  'scripts/copy_files.js',
  ...filesBelow(path.join(repoRoot, 'packages', 'server', 'src')).map(
    (relative) => path.join('packages/server/src', relative),
  ),
  'packages/core/package.json',
  'packages/core/tsconfig.json',
  'packages/core/src/services/aliyunSmsSender.ts',
  'scripts/build-enterprise-oneclick.mjs',
  'scripts/verify-enterprise-package-signature.mjs',
  ...filesBelow(sourceDir).map((relative) =>
    path.join('deployment/enterprise-oneclick', relative),
  ),
].sort();
const sourceInputHashes = Object.fromEntries(
  sourceInputFiles.map((relative) => [
    relative,
    shaFile(path.join(repoRoot, relative)),
  ]),
);
const sourceInputIdentity = sourceInputFiles
  .map((relative) => `${relative}\0${sourceInputHashes[relative]}\n`)
  .join('');
const sourceInputSha256 = sha(sourceInputIdentity);

const temporaryRoot = mkdtempSync(
  path.join(os.tmpdir(), 'otto-enterprise-oneclick-'),
);
try {
  const packageNameBase = `otto-enterprise-oneclick-v${version}`;
  const packageRoot = path.join(temporaryRoot, packageNameBase);
  cpSync(sourceDir, packageRoot, {
    recursive: true,
    filter: (source) => path.basename(source) !== 'release',
  });
  const releaseRoot = path.join(packageRoot, 'release');
  mkdirSync(path.join(releaseRoot, 'src', 'enterprise', 'public'), {
    recursive: true,
  });
  mkdirSync(
    path.join(
      releaseRoot,
      'node_modules',
      'otto-core',
      'dist',
      'src',
      'services',
    ),
    {
      recursive: true,
    },
  );

  const serverDist = path.join(repoRoot, 'packages', 'server', 'dist');
  const serverFiles = [
    ...filesBelow(path.join(serverDist, 'src'))
      .filter((relative) => relative.endsWith('.js'))
      .map((relative) => path.posix.join('src', relative)),
  ];
  for (const relative of serverFiles) {
    const source = path.join(serverDist, relative);
    if (!existsSync(source))
      throw new Error(`missing built server file: ${source}`);
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
    `export * from './src/services/aliyunSmsSender.js';

export const FEATURE_FLAGS = {
  park_service: '公园服务',
  feishu_auto_reply: '飞书自动回复',
  enterprise_tree: '企业组织树',
  knowledge_loop: '知识沉淀闭环',
  memory_injection: '经验检索注入',
  checkpoints: '崩溃恢复',
  audit_log: '审计日志',
};

const FEATURE_FLAG_DEFAULTS = {
  park_service: false,
  feishu_auto_reply: true,
  enterprise_tree: true,
  knowledge_loop: true,
  memory_injection: true,
  checkpoints: true,
  audit_log: true,
};

export class ProjectSettingsManager {
  constructor() {
    this.settings = {};
  }

  getSettings() {
    return { ...this.settings };
  }

  save(settings) {
    this.settings = { ...settings };
  }
}

export class FeatureFlagManager {
  constructor(settingsManager) {
    this.settingsManager = settingsManager;
    this.listeners = new Set();
  }

  isEnabled(flag) {
    const configured = this.settingsManager.getSettings().featureFlags?.[flag];
    return typeof configured === 'boolean' ? configured : FEATURE_FLAG_DEFAULTS[flag];
  }

  setEnabled(flag, enabled) {
    const oldValue = this.isEnabled(flag);
    if (oldValue === enabled) return;
    const settings = this.settingsManager.getSettings();
    this.settingsManager.save({
      ...settings,
      featureFlags: {
        ...settings.featureFlags,
        [flag]: enabled,
      },
    });
    for (const listener of this.listeners) {
      try {
        listener(flag, enabled, oldValue);
      } catch {
        // Ignore listener failures in the minimal enterprise adapter.
      }
    }
  }

  getAll() {
    return Object.fromEntries(Object.keys(FEATURE_FLAGS).map((flag) => [flag, this.isEnabled(flag)]));
  }

  onChange(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
}
`,
  );
  writeFileSync(
    path.join(releaseRoot, 'node_modules', 'otto-core', 'package.json'),
    `${JSON.stringify(
      {
        name: 'otto-core',
        version: '1.1.0-enterprise-adapter',
        private: true,
        type: 'module',
        main: 'dist/index.js',
        exports: { '.': './dist/index.js' },
        dependencies: {},
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(releaseRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'otto-enterprise-runtime',
        version,
        private: true,
        type: 'module',
        engines: { node: '>=22.16.0 <23' },
      },
      null,
      2,
    )}\n`,
  );
  cpSync(
    path.join(sourceDir, 'runtime', 'run.mjs'),
    path.join(releaseRoot, 'run.mjs'),
  );
  chmodSync(path.join(releaseRoot, 'run.mjs'), 0o755);
  writeFileSync(
    path.join(releaseRoot, 'license-public-keys.json'),
    `${JSON.stringify(licensePublicKeys, null, 2)}\n`,
    { mode: 0o644 },
  );

  const smokeDataRoot = path.join(temporaryRoot, 'smoke-data');
  mkdirSync(smokeDataRoot, { recursive: true });
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(pathToFileURL(path.join(releaseRoot, 'src', 'enterprise', 'server.js')).href)});`,
    ],
    {
      env: {
        ...process.env,
        OTTO_ENTERPRISE_DIR: smokeDataRoot,
      },
    },
  );

  const releaseFiles = filesBelow(releaseRoot);
  const fileHashes = Object.fromEntries(
    releaseFiles.map((relative) => [
      relative,
      shaFile(path.join(releaseRoot, relative)),
    ]),
  );
  const contentIdentity = releaseFiles
    .map((relative) => `${relative}\0${fileHashes[relative]}\n`)
    .join('');
  const buildCommit = sha(contentIdentity, 'sha1');
  const sourceDiff = run('git', ['diff', '--binary', '--', ...sourceScope], {
    capture: true,
  });
  const manifest = {
    format: 'otto-enterprise-release-v1',
    version,
    releaseChannel,
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
      schemaFrom: supportedSchemaFrom,
      schemaTo: schemaVersion,
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
    `${JSON.stringify(
      {
        version,
        releaseChannel,
        buildCommit,
        sourceCommit,
        sourceTreeDirty,
        sourceDiffSha256: manifest.sourceDiffSha256,
        sourceInputSha256,
        sourceStatus: sourceStatus ? sourceStatus.split('\n') : [],
        nodeVersion: manifest.runtime.node,
        schemaVersion,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(finalPackageRoot, 'SOURCE-INPUTS.sha256'),
    `${sourceInputFiles
      .map((relative) => `${sourceInputHashes[relative]}  ${relative}`)
      .join('\n')}\n`,
  );

  const executableFiles = [
    'install.sh',
    'upgrade.sh',
    'export-migration.sh',
    'verify.sh',
    'backup-now.sh',
    'restore-backup.sh',
    'lib/common.sh',
    'tools/db-tool.mjs',
    'tools/verify-release.mjs',
    'tools/migrate-check.mjs',
    'tools/health-check.mjs',
    'release/run.mjs',
  ];
  for (const script of executableFiles) {
    chmodSync(path.join(finalPackageRoot, script), 0o755);
  }

  const packageFiles = filesBelow(finalPackageRoot).filter(
    (relative) => relative !== 'PACKAGE-MANIFEST.sha256',
  );
  writeFileSync(
    path.join(finalPackageRoot, 'PACKAGE-MANIFEST.sha256'),
    `${packageFiles
      .map(
        (relative) =>
          `${shaFile(path.join(finalPackageRoot, relative))}  ${relative}`,
      )
      .join('\n')}\n`,
  );

  mkdirSync(outputDir, { recursive: true });
  const archive = path.join(outputDir, `${finalPackageName}.tar.gz`);
  const checksum = `${archive}.sha256`;
  const signaturePath = `${archive}.sig`;
  if (
    existsSync(archive) ||
    existsSync(checksum) ||
    existsSync(signaturePath)
  ) {
    throw new Error(
      `deliverable already exists, refusing overwrite: ${archive}`,
    );
  }
  const temporaryTar = path.join(temporaryRoot, `${finalPackageName}.tar`);
  run(
    'tar',
    ['--no-xattrs', '-cf', temporaryTar, '-C', temporaryRoot, finalPackageName],
    {
      env: {
        ...process.env,
        COPYFILE_DISABLE: '1',
      },
    },
  );
  normalizeTarExecutableModes(temporaryTar, finalPackageName, executableFiles);
  writeFileSync(archive, gzipSync(readFileSync(temporaryTar), { level: 9 }));
  const archiveTar = gunzipSync(readFileSync(archive));
  for (const forbiddenMetadataMarker of [
    'LIBARCHIVE.xattr.',
    'SCHILY.xattr.',
    'com.apple.provenance',
  ]) {
    if (archiveTar.includes(Buffer.from(forbiddenMetadataMarker))) {
      throw new Error(
        `archive contains non-portable metadata marker: ${forbiddenMetadataMarker}`,
      );
    }
  }
  const archiveEntries = run('tar', ['-tzf', archive], { capture: true })
    .split('\n')
    .filter(Boolean);
  const nonPortableEntries = archiveEntries.filter(
    (entry) =>
      path.basename(entry).startsWith('._') ||
      path.basename(entry) === '.DS_Store',
  );
  if (nonPortableEntries.length > 0) {
    throw new Error(
      `archive contains non-portable entries: ${nonPortableEntries.join(', ')}`,
    );
  }
  const archiveHash = shaFile(archive);
  writeFileSync(checksum, `${archiveHash}  ${path.basename(archive)}\n`);
  if (!enterpriseSigningPrivateKey) {
    console.warn(
      '[bundle] unsigned enterprise package explicitly allowed for local use',
    );
  } else {
    const privateKey = createPrivateKey(enterpriseSigningPrivateKey);
    const publicKey = createPublicKey(privateKey);
    const publicKeyPem = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
    const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
    writeFileSync(
      signaturePath,
      `${JSON.stringify(
        {
          format: 'otto-enterprise-package-signature-v1',
          algorithm: 'Ed25519',
          file: path.basename(archive),
          sha256: archiveHash,
          keyId: sha(publicKeyDer).slice(0, 16),
          signature: sign(null, readFileSync(archive), privateKey).toString(
            'base64url',
          ),
        },
        null,
        2,
      )}\n`,
    );
    run(
      process.execPath,
      [
        path.join(
          repoRoot,
          'scripts',
          'verify-enterprise-package-signature.mjs',
        ),
        archive,
        signaturePath,
      ],
      {
        env: {
          ...process.env,
          OTTO_ENTERPRISE_SIGNING_PUBLIC_KEY: publicKeyPem,
        },
      },
    );
    console.log(`[bundle] Ed25519 signature: ${signaturePath}`);
  }
  console.log(`[bundle] 完成：${archive}`);
  console.log(`[bundle] SHA-256：${archiveHash}`);
  console.log(`[bundle] build id：${buildCommit}`);
  console.log(
    `[bundle] source commit：${sourceCommit}${sourceTreeDirty ? ' + tracked local changes' : ''}`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
