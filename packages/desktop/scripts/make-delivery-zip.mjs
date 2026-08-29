/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Otto Desktop 交付包聚合 + 自动发布脚本（Issue #8）。
 *
 * 产出 macOS 双架构与 Windows x64 安装包和更新清单，并可发布到 GitHub Releases。
 *
 * 用法：
 *   node scripts/make-delivery-zip.mjs                  # 仅聚合
 *   node scripts/make-delivery-zip.mjs --build          # 先构建再聚合
 *   node scripts/make-delivery-zip.mjs --publish        # 聚合 + 发布到 GitHub
 *   node scripts/make-delivery-zip.mjs --build --publish # 全流程
 *
 * 产物（release/ 目录）：
 *   Otto-<version>-arm64.dmg          — Mac ARM64 安装包
 *   Otto-<version>-x64.dmg            — Mac x86_64 安装包
 *   Otto-Setup-<version>-win-x64.exe  — Windows x64 安装包
 *   Otto-<version>-arm64.dmg.blockmap — Mac ARM64 增量更新块图
 *   Otto-<version>-x64.dmg.blockmap   — Mac x86_64 增量更新块图
 *   Otto-Setup-<version>-win-x64.exe.blockmap — Windows x64 增量更新块图
 *   latest.json                       — 更新清单（sha256 + URL）
 */

import {
  existsSync,
  writeFileSync,
  readFileSync,
  statSync,
  lstatSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINDOWS_RIPGREP_INTEGRITY } from './ripgrep-integrity.mjs';
import { resolveUpdateAssetBaseUrl } from './update-mirror-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(DESKTOP_DIR, '../..');
const RELEASE_DIR = path.join(DESKTOP_DIR, 'release');
const BUILD_PROVENANCE_PATH = path.join(
  RELEASE_DIR,
  '.otto-build-provenance.json',
);
const WINDOWS_RIPGREP_DIR = path.join(DESKTOP_DIR, 'vendor', 'win', 'ripgrep');
const WINDOWS_RIPGREP_PATH = path.join(WINDOWS_RIPGREP_DIR, 'rg.exe');
const WINDOWS_RIPGREP_VERSION_PATH = path.join(WINDOWS_RIPGREP_DIR, '.version');
const PKG = JSON.parse(
  readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf-8'),
);
const ROOT_PKG = JSON.parse(
  readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'),
);
const VERSION = PKG.version;
const SOURCE_REPO = 'NSIETeam/otto-new';
const SOURCE_UPSTREAM = 'origin/internal';
const RELEASES_REPO = process.env.OTTO_RELEASES_REPO || 'NSIETeam/otto-new';
const UPDATE_ASSET_BASE_URL = resolveUpdateAssetBaseUrl();
const RELEASE_TAG = `v${VERSION}`;
const BUILD_ASSET_NAMES = [
  `Otto-${VERSION}-arm64.dmg`,
  `Otto-${VERSION}-arm64.dmg.blockmap`,
  `Otto-${VERSION}-x64.dmg`,
  `Otto-${VERSION}-x64.dmg.blockmap`,
  `Otto-Setup-${VERSION}-win-x64.exe`,
  `Otto-Setup-${VERSION}-win-x64.exe.blockmap`,
];
const RELEASE_ASSET_NAMES = [...BUILD_ASSET_NAMES, 'latest.json'];

// ── CLI 参数解析 ──────────────────────────────────────────────────────────

const ARGS = process.argv.slice(2);
const SHOULD_BUILD = ARGS.includes('--build');
const SHOULD_PUBLISH = ARGS.includes('--publish');
const ALLOW_UNSIGNED_MAC = process.env.OTTO_ALLOW_UNSIGNED_MAC === '1';
const GITHUB_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const EXEC_FILE_OPTIONS = process.platform === 'win32' ? { shell: true } : {};
const UNSIGNED_MAC_BUILD_ARGS = ALLOW_UNSIGNED_MAC
  ? [
      '--config.mac.identity=null',
      '--config.mac.hardenedRuntime=false',
      '--config.mac.notarize=false',
      '--config.dmg.sign=false',
    ]
  : [];
const MAC_BUILD_ENV = ALLOW_UNSIGNED_MAC
  ? { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  : process.env;

// ── 辅助函数 ──────────────────────────────────────────────────────────────

async function sha256(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on('data', (c) => hash.update(c))
      .on('end', resolve)
      .on('error', reject);
  });
  return hash.digest('hex');
}

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT_DIR,
    encoding: 'utf-8',
  }).trim();
}

function inspectSourceState({
  requireClean = false,
  requirePushed = false,
} = {}) {
  if (ROOT_PKG.version !== VERSION) {
    throw new Error(
      `版本不一致：根 package.json=${ROOT_PKG.version}，desktop=${VERSION}`,
    );
  }
  const sourceCommit = git(['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error('无法取得完整的源码 HEAD SHA');
  }
  if (requireClean) {
    const trackedChanges = git([
      'status',
      '--porcelain',
      '--untracked-files=no',
    ]);
    if (trackedChanges) {
      throw new Error('发布构建要求已提交的干净工作树；仍有 tracked 修改');
    }
    const untrackedBuildInputs = git([
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      'package.json',
      'package-lock.json',
      'scripts',
      'packages/desktop',
      'packages/server',
      'packages/core',
      'start-enterprise.cjs',
    ]);
    if (untrackedBuildInputs) {
      throw new Error(
        `发布构建输入中存在未跟踪文件，禁止生成不可追溯产物：\n${untrackedBuildInputs}`,
      );
    }
  }
  let upstream = '';
  let upstreamCommit = '';
  if (requirePushed) {
    try {
      execFileSync('git', ['fetch', '--quiet'], {
        cwd: ROOT_DIR,
        stdio: 'pipe',
      });
      upstream = git([
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{upstream}',
      ]);
      upstreamCommit = git(['rev-parse', '@{upstream}']);
    } catch {
      throw new Error('当前分支没有 upstream，必须先推送源码再发布');
    }
    if (upstream !== SOURCE_UPSTREAM) {
      throw new Error(
        `正式发布只接受 ${SOURCE_UPSTREAM}，当前 upstream=${upstream}`,
      );
    }
    if (upstreamCommit !== sourceCommit) {
      throw new Error(
        `本地 HEAD 尚未完整推送：HEAD=${sourceCommit}，${upstream}=${upstreamCommit}`,
      );
    }
  }
  return { sourceCommit, upstream, upstreamCommit };
}

function assertSourceStateUnchanged(
  expectedCommit,
  { requirePushed = false, phase = '发布流程' } = {},
) {
  const current = inspectSourceState({ requireClean: true, requirePushed });
  if (current.sourceCommit !== expectedCommit) {
    throw new Error(
      `${phase}期间源码 HEAD 已变化：开工=${expectedCommit}，当前=${current.sourceCommit}`,
    );
  }
  return current;
}

// ── Step 1: 构建 ─────────────────────────────────────────────────────────

/**
 * electron-builder 的解包目录体积通常在 400–500 MB。安装包生成后继续保留它们
 * 会显著抬高后续平台的磁盘峰值；只允许清理 release 下三个固定的可再生目录。
 */
function cleanupUnpackedOutput(name) {
  const allowed = new Set(['mac-arm64', 'mac', 'win-unpacked']);
  if (!allowed.has(name)) {
    throw new Error(`拒绝清理未登记的构建目录: ${name}`);
  }
  const target = path.join(RELEASE_DIR, name);
  if (!existsSync(target)) return;
  const releaseMetadata = lstatSync(RELEASE_DIR);
  if (releaseMetadata.isSymbolicLink() || !releaseMetadata.isDirectory()) {
    throw new Error(
      `release 必须是工作树内的真实目录，拒绝清理: ${RELEASE_DIR}`,
    );
  }
  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`构建中间产物必须是普通目录，拒绝清理: ${target}`);
  }
  const releaseRoot = realpathSync(RELEASE_DIR);
  const resolved = realpathSync(target);
  if (path.dirname(resolved) !== releaseRoot) {
    throw new Error(`构建中间产物越出 release 目录，拒绝清理: ${target}`);
  }
  rmSync(target, { recursive: true, force: false });
  log('BUILD', `已清理可再生中间目录: ${name}`);
}

function runBuildStep(
  command,
  args,
  unpackedOutput,
  env = process.env,
  verifyUnpacked,
) {
  try {
    execFileSync(command, args, {
      cwd: DESKTOP_DIR,
      stdio: 'inherit',
      env,
      ...EXEC_FILE_OPTIONS,
    });
    verifyUnpacked?.();
  } finally {
    cleanupUnpackedOutput(unpackedOutput);
  }
}

function verifySignedMacApplication(unpackedOutput) {
  const appPath = path.join(RELEASE_DIR, unpackedOutput, 'Otto.app');
  if (!existsSync(appPath)) {
    throw new Error(`缺少待验证的 macOS 应用包: ${appPath}`);
  }
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    stdio: 'inherit',
  });
  execFileSync('xcrun', ['stapler', 'validate', appPath], {
    stdio: 'inherit',
  });
  execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath], {
    stdio: 'inherit',
  });
  log('BUILD', `Developer ID 与公证票据验证通过: ${unpackedOutput}/Otto.app`);
}

async function writeBuildProvenance(sourceCommit) {
  const windowsRipgrep = await inspectWindowsRipgrep();
  const assets = await Promise.all(
    checkArtifacts(BUILD_ASSET_NAMES).map(async (asset) => ({
      name: asset.name,
      size: asset.size,
      sha256: await sha256(asset.path),
    })),
  );
  const provenance = {
    schemaVersion: 1,
    version: VERSION,
    sourceCommit,
    builtAt: git(['show', '-s', '--format=%cI', sourceCommit]),
    inputs: {
      windowsRipgrep,
    },
    assets: Object.fromEntries(
      assets.map((asset) => [
        asset.name,
        { size: asset.size, sha256: asset.sha256 },
      ]),
    ),
  };
  writeFileSync(
    BUILD_PROVENANCE_PATH,
    `${JSON.stringify(provenance, null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  log('BUILD', `构建溯源已写入: ${BUILD_PROVENANCE_PATH}`);
}

async function inspectWindowsRipgrep() {
  if (
    !existsSync(WINDOWS_RIPGREP_PATH) ||
    !existsSync(WINDOWS_RIPGREP_VERSION_PATH)
  ) {
    throw new Error('缺少已核验的 Windows rg.exe 或版本戳，禁止生成构建溯源');
  }
  const metadata = lstatSync(WINDOWS_RIPGREP_PATH);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(
      'Windows rg.exe 必须是普通文件，拒绝符号链接或其他文件类型',
    );
  }
  const version = readFileSync(WINDOWS_RIPGREP_VERSION_PATH, 'utf8').trim();
  const integrity = WINDOWS_RIPGREP_INTEGRITY[version];
  if (!integrity) {
    throw new Error(`Windows rg.exe 版本 ${version} 没有可信摘要`);
  }
  const executableSha256 = await sha256(WINDOWS_RIPGREP_PATH);
  if (executableSha256 !== integrity.executableSha256) {
    throw new Error(
      `Windows rg.exe SHA256 不匹配；期望 ${integrity.executableSha256}，` +
        `实际 ${executableSha256}`,
    );
  }
  return {
    version,
    target: integrity.target,
    sourceZipSha256: integrity.zipSha256,
    executableSha256,
  };
}

async function build(sourceCommit) {
  log('BUILD', '开始编译服务端与桌面端...');

  // desktop 通过 file:../server 读取 otto-server/dist。必须先从当前 HEAD
  // 重建 server（tsc -b 会同步 project reference），禁止把旧 dist 打进新版本。
  execFileSync(NPM_BIN, ['run', 'build', '--workspace=packages/server'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    ...EXEC_FILE_OPTIONS,
  });
  log('BUILD', 'otto-server 当前源码构建完成');

  // 构建 renderer + main + preload
  execFileSync(NPM_BIN, ['run', 'build'], {
    cwd: DESKTOP_DIR,
    stdio: 'inherit',
    ...EXEC_FILE_OPTIONS,
  });
  log('BUILD', 'TypeScript + Webpack 编译完成');

  // mac: arm64 + x64
  log('BUILD', '构建 Mac arm64...');
  runBuildStep(
    NPX_BIN,
    [
      'electron-builder',
      '--mac',
      'dmg',
      '--arm64',
      ...UNSIGNED_MAC_BUILD_ARGS,
      '--publish',
      'never',
    ],
    'mac-arm64',
    MAC_BUILD_ENV,
    ALLOW_UNSIGNED_MAC
      ? undefined
      : () => verifySignedMacApplication('mac-arm64'),
  );
  smokeNativeMacArtifact('arm64');

  log('BUILD', '构建 Mac x64...');
  runBuildStep(
    NPX_BIN,
    [
      'electron-builder',
      '--mac',
      'dmg',
      '--x64',
      ...UNSIGNED_MAC_BUILD_ARGS,
      '--publish',
      'never',
    ],
    'mac',
    MAC_BUILD_ENV,
    ALLOW_UNSIGNED_MAC
      ? undefined
      : () => verifySignedMacApplication('mac'),
  );
  smokeNativeMacArtifact('x64');

  log('BUILD', '构建 Windows x64...');
  const windowsSigningEnv = {
    ...process.env,
    CSC_LINK: process.env.WIN_CSC_LINK,
    CSC_KEY_PASSWORD: process.env.WIN_CSC_KEY_PASSWORD,
  };
  runBuildStep(NPM_BIN, ['run', 'dist:win'], 'win-unpacked', windowsSigningEnv);

  // 构建可能持续数十分钟；不能把期间被修改或切换过的工作树标成开工时的 SHA。
  assertSourceStateUnchanged(sourceCommit, { phase: '安装包构建' });
  await writeBuildProvenance(sourceCommit);
  log('BUILD', '全部平台构建完成');
}

function smokeNativeMacArtifact(artifactArch) {
  if (process.arch !== artifactArch) {
    log(
      'BUILD',
      `跳过 Mac ${artifactArch} 跨架构动态验收；已保留打包、原生依赖与签名静态校验`,
    );
    return;
  }
  execFileSync(
    process.execPath,
    [
      path.join(__dirname, 'smoke-packaged-electron.mjs'),
      path.join(RELEASE_DIR, `Otto-${VERSION}-${artifactArch}.dmg`),
    ],
    {
      cwd: DESKTOP_DIR,
      stdio: 'inherit',
    },
  );
  log(
    'BUILD',
    `Mac ${artifactArch} 最终 DMG 的 preload、IPC 与 WS 动态验收通过`,
  );
}

// ── Step 2: 检查产物 ──────────────────────────────────────────────────────

function checkArtifacts(expected = RELEASE_ASSET_NAMES) {
  log('CHECK', '检查构建产物...');

  if (!Array.isArray(expected) || expected.length === 0) {
    throw new Error('发布资产集合为空，已停止');
  }
  if (!existsSync(RELEASE_DIR)) {
    throw new Error(`缺少 release 目录: ${RELEASE_DIR}`);
  }
  const releaseMetadata = lstatSync(RELEASE_DIR);
  if (releaseMetadata.isSymbolicLink() || !releaseMetadata.isDirectory()) {
    throw new Error(
      'release 必须是工作树内的真实目录，拒绝符号链接或其他文件类型',
    );
  }
  const resolvedReleaseDir = realpathSync(RELEASE_DIR);

  const artifacts = [];
  for (const name of expected) {
    const p = path.join(RELEASE_DIR, name);
    if (!existsSync(p)) {
      throw new Error(`缺少产物: ${name}（期望路径: ${p}）`);
    }
    const metadata = lstatSync(p);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(
        `发布资产必须是普通文件，拒绝符号链接或其他文件类型: ${name}`,
      );
    }
    const resolvedPath = realpathSync(p);
    if (path.dirname(resolvedPath) !== resolvedReleaseDir) {
      throw new Error(`发布资产越出 release 目录: ${name}`);
    }
    const size = statSync(p).size;
    if (size > 2 * 1024 * 1024 * 1024) {
      throw new Error(`${name} 体积超过 2 GiB 安全上限: ${size} bytes`);
    }
    const minimumSize =
      name === 'latest.json'
        ? 2
        : name.endsWith('.blockmap')
          ? 1024
          : 1024 * 1024;
    if (size < minimumSize) {
      throw new Error(`${name} 体积异常小: ${size} bytes`);
    }
    artifacts.push({ name, path: p, size });
    log('CHECK', `  ${name}  ${(size / 1048576).toFixed(1)} MB`);
  }

  log('CHECK', '全部产物验证通过');
  return artifacts;
}

// ── Step 3: 生成更新清单 ──────────────────────────────────────────────────

async function makeLatestJson(sourceCommit) {
  log('LATEST', '生成更新清单 latest.json...');

  const notesFile = process.argv.find(
    (a) =>
      (a.endsWith('.md') && a.includes('changelog')) || a.includes('notes'),
  );
  let notes = '';

  if (notesFile && existsSync(notesFile)) {
    notes = readFileSync(notesFile, 'utf-8');
  } else {
    // 自动生成简单的 release notes
    const logOutput = execSync(
      `git log --oneline --no-decorate v${VERSION}..HEAD 2>/dev/null || git log --oneline -20`,
      { cwd: DESKTOP_DIR, encoding: 'utf-8' },
    );
    notes = `## Otto v${VERSION}\n\n${logOutput}`;
  }

  const macArm64 = path.join(RELEASE_DIR, `Otto-${VERSION}-arm64.dmg`);
  const macX64 = path.join(RELEASE_DIR, `Otto-${VERSION}-x64.dmg`);
  const winX64 = path.join(RELEASE_DIR, `Otto-Setup-${VERSION}-win-x64.exe`);
  const releaseBaseUrl = UPDATE_ASSET_BASE_URL;
  // 使用发布候选提交时间，确保同一 commit 的失败重试能生成字节完全一致的清单。
  const publishedAt = git(['show', '-s', '--format=%cI', sourceCommit]);

  const manifest = {
    version: VERSION,
    sourceCommit,
    notes,
    publishedAt,
    assets: {
      'mac-arm64': {
        name: `Otto-${VERSION}-arm64.dmg`,
        url: `${releaseBaseUrl}/Otto-${VERSION}-arm64.dmg`,
        size: statSync(macArm64).size,
        sha256: await sha256(macArm64),
      },
      'mac-x64': {
        name: `Otto-${VERSION}-x64.dmg`,
        url: `${releaseBaseUrl}/Otto-${VERSION}-x64.dmg`,
        size: statSync(macX64).size,
        sha256: await sha256(macX64),
      },
      'win-x64': {
        name: `Otto-Setup-${VERSION}-win-x64.exe`,
        url: `${releaseBaseUrl}/Otto-Setup-${VERSION}-win-x64.exe`,
        size: statSync(winX64).size,
        sha256: await sha256(winX64),
      },
    },
  };

  const outPath = path.join(RELEASE_DIR, 'latest.json');
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log('LATEST', `更新清单已生成: ${outPath}`);
  for (const [platform, asset] of Object.entries(manifest.assets)) {
    log(
      'LATEST',
      `  ${platform}: ${asset.sha256.substring(0, 16)}...  ${(asset.size / 1048576).toFixed(1)} MB`,
    );
  }
}

// ── Step 4: 发布到 GitHub Releases ────────────────────────────────────────

async function inspectLocalAssets() {
  const artifacts = checkArtifacts(RELEASE_ASSET_NAMES);
  return Promise.all(
    artifacts.map(async (artifact) => ({
      ...artifact,
      sha256: await sha256(artifact.path),
    })),
  );
}

function localAssetByName(localAssets, name) {
  const asset = localAssets.find((entry) => entry.name === name);
  if (!asset) {
    throw new Error(`本地资产集合缺少 ${name}`);
  }
  return asset;
}

async function readAndVerifyBuildProvenance(localAssets, sourceCommit) {
  if (!existsSync(BUILD_PROVENANCE_PATH)) {
    throw new Error(
      `缺少构建溯源文件 ${BUILD_PROVENANCE_PATH}；必须从当前已推送提交重新执行 --build`,
    );
  }
  let provenance;
  try {
    provenance = JSON.parse(readFileSync(BUILD_PROVENANCE_PATH, 'utf-8'));
  } catch (error) {
    throw new Error(`构建溯源文件无法解析: ${error.message}`);
  }
  if (
    provenance.schemaVersion !== 1 ||
    provenance.version !== VERSION ||
    provenance.sourceCommit !== sourceCommit
  ) {
    throw new Error(
      `构建溯源与发布候选不一致：期望 v${VERSION} @ ${sourceCommit}`,
    );
  }
  const names =
    provenance.assets && typeof provenance.assets === 'object'
      ? Object.keys(provenance.assets).sort()
      : [];
  const expectedNames = [...BUILD_ASSET_NAMES].sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error('构建溯源中的资产集合不完整');
  }
  for (const name of BUILD_ASSET_NAMES) {
    const local = localAssetByName(localAssets, name);
    const recorded = provenance.assets[name];
    if (
      !recorded ||
      recorded.size !== local.size ||
      recorded.sha256 !== local.sha256
    ) {
      throw new Error(
        `构建产物 ${name} 与 HEAD=${sourceCommit} 的溯源记录不一致`,
      );
    }
  }
  const currentRipgrep = await inspectWindowsRipgrep();
  if (
    JSON.stringify(provenance.inputs?.windowsRipgrep) !==
    JSON.stringify(currentRipgrep)
  ) {
    throw new Error('构建溯源中的 Windows rg.exe 与当前可信构建输入不一致');
  }
  return provenance;
}

function validateManifest(manifest, localAssets, source, sourceCommit) {
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.version !== VERSION
  ) {
    throw new Error(`${source} latest.json 版本不匹配，期望 ${VERSION}`);
  }
  if (manifest.sourceCommit !== sourceCommit) {
    throw new Error(`${source} latest.json 的源码提交与发布候选不一致`);
  }

  const expectedPlatforms = {
    'mac-arm64': `Otto-${VERSION}-arm64.dmg`,
    'mac-x64': `Otto-${VERSION}-x64.dmg`,
    'win-x64': `Otto-Setup-${VERSION}-win-x64.exe`,
  };
  const manifestAssets = manifest.assets;
  const actualPlatforms =
    manifestAssets && typeof manifestAssets === 'object'
      ? Object.keys(manifestAssets).sort()
      : [];
  const requiredPlatforms = Object.keys(expectedPlatforms).sort();
  if (
    actualPlatforms.length !== requiredPlatforms.length ||
    actualPlatforms.some((key, index) => key !== requiredPlatforms[index])
  ) {
    throw new Error(
      `${source} latest.json 平台资产集合不完整，期望 ${requiredPlatforms.join(', ')}`,
    );
  }

  for (const [platform, name] of Object.entries(expectedPlatforms)) {
    const expected = localAssetByName(localAssets, name);
    const actual = manifestAssets[platform];
    const expectedUrl = `${UPDATE_ASSET_BASE_URL}/${name}`;
    if (
      !actual ||
      actual.name !== name ||
      actual.url !== expectedUrl ||
      actual.size !== expected.size ||
      actual.sha256 !== expected.sha256
    ) {
      throw new Error(
        `${source} latest.json 的 ${platform} 资产信息与本地构建不一致`,
      );
    }
  }
}

function readAndValidateLocalManifest(localAssets, sourceCommit) {
  const manifestAsset = localAssetByName(localAssets, 'latest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestAsset.path, 'utf-8'));
  } catch (error) {
    throw new Error(`本地 latest.json 无法解析: ${error.message}`);
  }
  validateManifest(manifest, localAssets, '本地', sourceCommit);
  return manifest;
}

function githubHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

async function githubJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: githubHeaders(options.headers),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API 失败: ${response.status} ${detail}`);
  }
  return response.status === 204 ? null : response.json();
}

async function githubJsonOrNull(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: githubHeaders(options.headers),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API 失败: ${response.status} ${detail}`);
  }
  return response.status === 204 ? null : response.json();
}

async function findReleaseByTag() {
  const releases = await githubJson(
    `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=100`,
  );
  const matches = releases.filter(
    (release) => release.tag_name === RELEASE_TAG,
  );
  if (matches.length > 1) {
    throw new Error(`发现多个 ${RELEASE_TAG} Release，已停止`);
  }
  return matches[0] ?? null;
}

async function verifySourceCommitPublished(sourceCommit) {
  const commit = await githubJson(
    `https://api.github.com/repos/${SOURCE_REPO}/commits/${sourceCommit}`,
  );
  if (commit.sha !== sourceCommit) {
    throw new Error(`GitHub 源码仓库未确认提交 ${sourceCommit}`);
  }
  log('PUBLISH', `源码提交已在 GitHub 确认: ${sourceCommit}`);
}

async function getReleaseTargetCommit() {
  const repository = await githubJson(
    `https://api.github.com/repos/${RELEASES_REPO}`,
  );
  const branch = repository.default_branch;
  if (typeof branch !== 'string' || !branch) {
    throw new Error('无法确定发布仓库默认分支');
  }
  const ref = await githubJson(
    `https://api.github.com/repos/${RELEASES_REPO}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  const commit = ref?.object?.sha;
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('无法确定发布仓库的目标提交');
  }
  return commit;
}

async function resolveReleaseTagCommit() {
  const ref = await githubJsonOrNull(
    `https://api.github.com/repos/${RELEASES_REPO}/git/ref/tags/${encodeURIComponent(RELEASE_TAG)}`,
  );
  if (!ref) return null;
  let object = ref.object;
  // 兼容已有的 annotated tag；最多解一层 Git tag object 到 commit。
  if (object?.type === 'tag' && typeof object.sha === 'string') {
    const tag = await githubJson(
      `https://api.github.com/repos/${RELEASES_REPO}/git/tags/${object.sha}`,
    );
    object = tag?.object;
  }
  if (object?.type !== 'commit' || !/^[0-9a-f]{40}$/.test(object.sha || '')) {
    throw new Error(`已有标签 ${RELEASE_TAG} 不是可核验的 commit 引用`);
  }
  return object.sha;
}

async function assertReleaseTagSafe(releaseTargetCommit, phase) {
  const existingTagCommit = await resolveReleaseTagCommit();
  if (existingTagCommit && existingTagCommit !== releaseTargetCommit) {
    throw new Error(
      `${phase}前发现 ${RELEASE_TAG} 已指向 ${existingTagCommit}，` +
        `而发布目标是 ${releaseTargetCommit}；禁止让 GitHub 忽略 target_commitish`,
    );
  }
  if (existingTagCommit) {
    log('VERIFY', `已有标签 ${RELEASE_TAG} 已确认指向 ${existingTagCommit}`);
  }
}

async function ensureDraftRelease(sourceCommit, releaseTargetCommit) {
  const existing = await findReleaseByTag();
  if (existing) {
    if (!existing.draft) {
      throw new Error(`${RELEASE_TAG} 已正式发布，禁止覆盖或修改现有资产`);
    }
    if (existing.target_commitish !== releaseTargetCommit) {
      throw new Error(
        `草稿 ${RELEASE_TAG} 指向 ${existing.target_commitish}，与当前发布仓库目标 ${releaseTargetCommit} 不一致`,
      );
    }
    if (!String(existing.body || '').includes(sourceCommit)) {
      throw new Error(`草稿 ${RELEASE_TAG} 未绑定源码提交 ${sourceCommit}`);
    }
    log('PUBLISH', `复用草稿 Release (id=${existing.id})`);
    return existing;
  }

  log('PUBLISH', '创建草稿 Release...');
  const logOutput = execSync(
    `git log --oneline --no-decorate $(git describe --tags --abbrev=0 2>/dev/null || echo HEAD~10)..HEAD`,
    { cwd: DESKTOP_DIR, encoding: 'utf-8' },
  );
  const created = await githubJson(
    `https://api.github.com/repos/${RELEASES_REPO}/releases`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: RELEASE_TAG,
        target_commitish: releaseTargetCommit,
        name: `Otto Desktop v${VERSION}`,
        body: `## Otto Desktop v${VERSION}\n\n源码提交：[${sourceCommit}](https://github.com/${SOURCE_REPO}/commit/${sourceCommit})\n\n### 更新内容\n\n${logOutput}\n\n### 安装说明\n\n- Mac ARM64: \`Otto-${VERSION}-arm64.dmg\`\n- Mac x64: \`Otto-${VERSION}-x64.dmg\`\n- Windows x64: \`Otto-Setup-${VERSION}-win-x64.exe\`\n\nMac 打开 DMG 后将 Otto.app 拖入 Applications 文件夹；首次运行如提示「无法验证开发者」，右键 → 打开。Windows 运行安装器并按向导完成安装。`,
        draft: true,
        prerelease: false,
      }),
    },
  );
  if (
    !created.draft ||
    created.tag_name !== RELEASE_TAG ||
    created.target_commitish !== releaseTargetCommit ||
    !String(created.body || '').includes(sourceCommit)
  ) {
    throw new Error('GitHub 未返回预期的草稿 Release');
  }
  log('PUBLISH', `草稿 Release 已创建 (id=${created.id})`);
  return created;
}

async function listRemoteAssets(releaseId) {
  return githubJson(
    `https://api.github.com/repos/${RELEASES_REPO}/releases/${releaseId}/assets?per_page=100`,
  );
}

function assertRemoteAssetMatches(remote, local) {
  const digest =
    typeof remote.digest === 'string' && remote.digest.startsWith('sha256:')
      ? remote.digest.slice('sha256:'.length).toLowerCase()
      : null;
  if (
    remote.state !== 'uploaded' ||
    remote.size !== local.size ||
    digest !== local.sha256.toLowerCase()
  ) {
    throw new Error(
      `远端同名资产 ${local.name} 与本地不一致，禁止覆盖（size/digest/state 校验失败）`,
    );
  }
}

function rejectUnexpectedAssets(remoteAssets) {
  const expectedNames = new Set(RELEASE_ASSET_NAMES);
  const unexpected = remoteAssets.filter(
    (asset) => !expectedNames.has(asset.name),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `草稿包含非预期资产，禁止继续: ${unexpected.map((asset) => asset.name).join(', ')}`,
    );
  }
}

async function uploadMissingAssets(release, localAssets) {
  let remoteAssets = await listRemoteAssets(release.id);
  rejectUnexpectedAssets(remoteAssets);

  for (const local of localAssets) {
    const existing = remoteAssets.find((asset) => asset.name === local.name);
    if (existing) {
      assertRemoteAssetMatches(existing, local);
      log('PUBLISH', `复用已验证资产: ${local.name}`);
      continue;
    }

    log('PUBLISH', `上传 ${local.name}...`);
    const content = readFileSync(local.path);
    const uploadUrl =
      `https://uploads.github.com/repos/${RELEASES_REPO}/releases/${release.id}/assets` +
      `?name=${encodeURIComponent(local.name)}`;

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: githubHeaders({
        'Content-Type': local.name.endsWith('.dmg')
          ? 'application/x-apple-diskimage'
          : local.name.endsWith('.json')
            ? 'application/json'
            : 'application/octet-stream',
        'Content-Length': String(content.length),
      }),
      body: content,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      throw new Error(`上传 ${local.name} 失败: ${uploadRes.status} ${err}`);
    }
    log('PUBLISH', `  ${local.name} 上传完成`);
    remoteAssets = await listRemoteAssets(release.id);
  }
}

async function downloadRemoteAsset(asset) {
  const response = await fetch(
    `https://api.github.com/repos/${RELEASES_REPO}/releases/assets/${asset.id}`,
    {
      headers: githubHeaders({ Accept: 'application/octet-stream' }),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `下载远端 ${asset.name} 复验失败: ${response.status} ${detail}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function verifyRemoteDraft(release, localAssets, sourceCommit) {
  const remoteAssets = await listRemoteAssets(release.id);
  rejectUnexpectedAssets(remoteAssets);
  if (remoteAssets.length !== RELEASE_ASSET_NAMES.length) {
    throw new Error(
      `远端草稿资产数量不完整，期望 ${RELEASE_ASSET_NAMES.length}，实际 ${remoteAssets.length}`,
    );
  }

  for (const local of localAssets) {
    const remote = remoteAssets.find((asset) => asset.name === local.name);
    if (!remote) {
      throw new Error(`远端草稿缺少资产: ${local.name}`);
    }
    assertRemoteAssetMatches(remote, local);
  }

  const remoteLatest = remoteAssets.find(
    (asset) => asset.name === 'latest.json',
  );
  const remoteLatestBytes = await downloadRemoteAsset(remoteLatest);
  let remoteManifest;
  try {
    remoteManifest = JSON.parse(remoteLatestBytes.toString('utf-8'));
  } catch (error) {
    throw new Error(`远端 latest.json 无法解析: ${error.message}`);
  }
  validateManifest(remoteManifest, localAssets, '远端', sourceCommit);
  log('VERIFY', `远端草稿 7 个资产与 latest.json v${VERSION} 全部核验通过`);
}

async function publishDraft(release) {
  const published = await githubJson(
    `https://api.github.com/repos/${RELEASES_REPO}/releases/${release.id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: false }),
    },
  );
  if (published.draft || published.tag_name !== RELEASE_TAG) {
    throw new Error('草稿发布后状态异常');
  }
  return published;
}

async function verifyPublishedTag(releaseTargetCommit) {
  const tagCommit = await resolveReleaseTagCommit();
  if (tagCommit !== releaseTargetCommit) {
    throw new Error(
      `发布标签 ${RELEASE_TAG} 未指向锁定的发布仓库提交 ${releaseTargetCommit}`,
    );
  }
  log('VERIFY', `发布标签 ${RELEASE_TAG} 已锁定到 ${releaseTargetCommit}`);
}

async function publishToGithub(localAssets, sourceCommit) {
  log('PUBLISH', '安全发布到 GitHub Releases...');

  if (!GITHUB_TOKEN) {
    throw new Error(
      '缺少 GitHub Token，请设置 GH_TOKEN 或 GITHUB_TOKEN 环境变量',
    );
  }

  await verifySourceCommitPublished(sourceCommit);
  const releaseTargetCommit = await getReleaseTargetCommit();
  assertSourceStateUnchanged(sourceCommit, {
    requirePushed: true,
    phase: '创建 Release 草稿',
  });
  await assertReleaseTagSafe(releaseTargetCommit, '创建 Release 草稿');
  const release = await ensureDraftRelease(sourceCommit, releaseTargetCommit);
  await uploadMissingAssets(release, localAssets);
  await verifyRemoteDraft(release, localAssets, sourceCommit);
  // 上传可能耗时很久。正式公开是不可逆外部动作，必须在 PATCH 前再次锁住
  // 源码、upstream 与既有 tag，不能先公开错误标签再在事后校验时报错。
  assertSourceStateUnchanged(sourceCommit, {
    requirePushed: true,
    phase: '正式公开 Release',
  });
  await assertReleaseTagSafe(releaseTargetCommit, '正式公开 Release');
  const published = await publishDraft(release);
  if (
    published.target_commitish !== releaseTargetCommit ||
    !String(published.body || '').includes(sourceCommit)
  ) {
    throw new Error('正式 Release 的源码或目标提交绑定发生变化');
  }
  await verifyPublishedTag(releaseTargetCommit);

  log('PUBLISH', '全部资产核验完成，草稿已正式发布');
  log('PUBLISH', `👉 ${published.html_url}`);
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  log('OTTO', `Otto Desktop v${VERSION} 构建发布工具`);
  log('OTTO', `工作目录: ${DESKTOP_DIR}`);
  console.log('');

  const sourceState = inspectSourceState({
    requireClean: SHOULD_BUILD || SHOULD_PUBLISH,
    requirePushed: SHOULD_PUBLISH,
  });
  log('CHECK', `源码提交: ${sourceState.sourceCommit}`);

  if (SHOULD_BUILD) {
    await build(sourceState.sourceCommit);
  }

  // 先检查 6 个构建产物，缺任何一项都不能生成或发布清单。
  checkArtifacts(BUILD_ASSET_NAMES);
  await makeLatestJson(sourceState.sourceCommit);
  const localAssets = await inspectLocalAssets();
  readAndValidateLocalManifest(localAssets, sourceState.sourceCommit);
  log('CHECK', `本地固定 7 个资产与 latest.json v${VERSION} 全部核验通过`);

  if (SHOULD_PUBLISH) {
    assertSourceStateUnchanged(sourceState.sourceCommit, {
      requirePushed: true,
      phase: '发布前核验',
    });
    await readAndVerifyBuildProvenance(localAssets, sourceState.sourceCommit);
    log(
      'CHECK',
      `6 个安装资产均来自已推送源码提交 ${sourceState.sourceCommit}`,
    );
    await publishToGithub(localAssets, sourceState.sourceCommit);
  }

  console.log('');
  log('DONE', '全部流程完成');
  console.log('');
  console.log(`产物目录: ${RELEASE_DIR}`);
  for (const assetName of RELEASE_ASSET_NAMES) {
    console.log(`  ${assetName}`);
  }
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
