/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Otto Desktop 交付包聚合 + 自动发布脚本（Issue #8）。
 *
 * 产出双平台安装包和更新清单，并自动发布到 GitHub Releases。
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
 *   Otto-<version>-arm64.dmg.blockmap — Mac ARM64 增量更新块图
 *   Otto-<version>-x64.dmg.blockmap   — Mac x86_64 增量更新块图
 *   latest.json                       — 更新清单（sha256 + URL）
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(DESKTOP_DIR, 'release');
const PKG = JSON.parse(readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf-8'));
const VERSION = PKG.version;

// ── CLI 参数解析 ──────────────────────────────────────────────────────────

const ARGS = process.argv.slice(2);
const SHOULD_BUILD = ARGS.includes('--build');
const SHOULD_PUBLISH = ARGS.includes('--publish');
const GITHUB_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

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

// ── Step 1: 构建 ─────────────────────────────────────────────────────────

async function build() {
  log('BUILD', '开始编译桌面端...');

  // 构建 renderer + main + preload
  execFileSync('npm', ['run', 'build'], { cwd: DESKTOP_DIR, stdio: 'inherit' });
  log('BUILD', 'TypeScript + Webpack 编译完成');

  // mac: arm64 + x64
  log('BUILD', '构建 Mac arm64...');
  execFileSync('npx', ['electron-builder', '--mac', '--arm64', 'dmg'], {
    cwd: DESKTOP_DIR,
    stdio: 'inherit',
  });

  log('BUILD', '构建 Mac x64...');
  execFileSync('npx', ['electron-builder', '--mac', '--x64', 'dmg'], {
    cwd: DESKTOP_DIR,
    stdio: 'inherit',
  });

  log('BUILD', '全部平台构建完成');
}

// ── Step 2: 检查产物 ──────────────────────────────────────────────────────

function checkArtifacts() {
  log('CHECK', '检查构建产物...');

  const expected = [
    `Otto-${VERSION}-arm64.dmg`,
    `Otto-${VERSION}-arm64.dmg.blockmap`,
    `Otto-${VERSION}-x64.dmg`,
    `Otto-${VERSION}-x64.dmg.blockmap`,
  ];

  for (const name of expected) {
    const p = path.join(RELEASE_DIR, name);
    if (!existsSync(p)) {
      console.error(`[FAIL] 缺少产物: ${name}`);
      console.error(`       期望路径: ${p}`);
      process.exit(1);
    }
    const size = statSync(p).size;
    if (size < 1024 * 1024) {
      // DMG 至少应 > 1MB
      console.error(`[FAIL] ${name} 体积异常小: ${size} bytes`);
      process.exit(1);
    }
    log('CHECK', `  ${name}  ${(size / 1048576).toFixed(1)} MB`);
  }

  log('CHECK', '全部产物验证通过');
}

// ── Step 3: 生成更新清单 ──────────────────────────────────────────────────

async function makeLatestJson() {
  log('LATEST', '生成更新清单 latest.json...');

  const notesFile = process.argv.find((a) => a.endsWith('.md') && a.includes('changelog') || a.includes('notes'));
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

  const manifest = {
    version: VERSION,
    notes,
    publishedAt: new Date().toISOString(),
    assets: {
      'mac-arm64': {
        name: `Otto-${VERSION}-arm64.dmg`,
        url: `https://github.com/Felix201209/otto-releases/releases/download/v${VERSION}/Otto-${VERSION}-arm64.dmg`,
        size: statSync(macArm64).size,
        sha256: await sha256(macArm64),
      },
      'mac-x64': {
        name: `Otto-${VERSION}-x64.dmg`,
        url: `https://github.com/Felix201209/otto-releases/releases/download/v${VERSION}/Otto-${VERSION}-x64.dmg`,
        size: statSync(macX64).size,
        sha256: await sha256(macX64),
      },
    },
  };

  const outPath = path.join(RELEASE_DIR, 'latest.json');
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log('LATEST', `更新清单已生成: ${outPath}`);
  for (const [platform, asset] of Object.entries(manifest.assets)) {
    log('LATEST', `  ${platform}: ${asset.sha256.substring(0, 16)}...  ${(asset.size / 1048576).toFixed(1)} MB`);
  }
}

// ── Step 4: 发布到 GitHub Releases ────────────────────────────────────────

async function publishToGithub() {
  log('PUBLISH', '发布到 GitHub Releases...');

  if (!GITHUB_TOKEN) {
    console.error('[FAIL] 缺少 GitHub Token');
    console.error('       请设置 GH_TOKEN 或 GITHUB_TOKEN 环境变量');
    process.exit(1);
  }

  const REPO = 'Felix201209/otto-releases';
  const TAG = `v${VERSION}`;

  // 1. 检查 release 是否已存在
  log('PUBLISH', `检查 tag ${TAG}...`);
  let releaseId = null;
  try {
    const checkRes = await fetch(
      `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } },
    );
    if (checkRes.ok) {
      const existing = await checkRes.json();
      releaseId = existing.id;
      log('PUBLISH', `Release 已存在 (id=${releaseId})，将覆盖资产`);
    }
  } catch { /* 不存在，继续创建 */ }

  // 2. 创建或更新 release
  if (!releaseId) {
    log('PUBLISH', '创建新 Release...');

    // 读取最近 git log 作为 release notes
    const logOutput = execSync(
      `git log --oneline --no-decorate $(git describe --tags --abbrev=0 2>/dev/null || echo HEAD~10)..HEAD`,
      { cwd: DESKTOP_DIR, encoding: 'utf-8' },
    );

    const createRes = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
      method: 'POST',
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag_name: TAG,
        name: `Otto Desktop v${VERSION}`,
        body: `## Otto Desktop v${VERSION}\n\n### 更新内容\n\n${logOutput}\n\n### 安装说明\n\n- Mac ARM64: \`Otto-${VERSION}-arm64.dmg\`\n- Mac x64: \`Otto-${VERSION}-x64.dmg\`\n\n打开 DMG 后将 Otto.app 拖入 Applications 文件夹。首次运行如提示「无法验证开发者」，右键 → 打开。`,
        draft: false,
        prerelease: false,
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      console.error(`[FAIL] 创建 Release 失败: ${createRes.status} ${err}`);
      process.exit(1);
    }

    const created = await createRes.json();
    releaseId = created.id;
    log('PUBLISH', `Release 已创建 (id=${releaseId})`);
  }

  // 3. 上传资产
  const assets = [
    `Otto-${VERSION}-arm64.dmg`,
    `Otto-${VERSION}-arm64.dmg.blockmap`,
    `Otto-${VERSION}-x64.dmg`,
    `Otto-${VERSION}-x64.dmg.blockmap`,
    'latest.json',
  ];

  for (const assetName of assets) {
    const assetPath = path.join(RELEASE_DIR, assetName);
    if (!existsSync(assetPath)) {
      log('PUBLISH', `跳过不存在的资产: ${assetName}`);
      continue;
    }

    log('PUBLISH', `上传 ${assetName}...`);

    // 检查是否已有同名资产（如果 release 是已存在的）
    let existingAssetId = null;
    if (releaseId) {
      try {
        const listRes = await fetch(
          `https://api.github.com/repos/${REPO}/releases/${releaseId}/assets`,
          { headers: { Authorization: `token ${GITHUB_TOKEN}` } },
        );
        if (listRes.ok) {
          const existingAssets = await listRes.json();
          const match = existingAssets.find((a) => a.name === assetName);
          if (match) existingAssetId = match.id;
        }
      } catch { /* ignore */ }
    }

    // 删除已有同名资产（GitHub 不允许同名）
    if (existingAssetId) {
      await fetch(
        `https://api.github.com/repos/${REPO}/releases/assets/${existingAssetId}`,
        { method: 'DELETE', headers: { Authorization: `token ${GITHUB_TOKEN}` } },
      );
      log('PUBLISH', `  已删除旧资产 (id=${existingAssetId})`);
    }

    // 上传新资产
    const content = readFileSync(assetPath);
    const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`;

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        'Content-Type': assetName.endsWith('.dmg')
          ? 'application/x-apple-diskimage'
          : assetName.endsWith('.json')
            ? 'application/json'
            : 'application/octet-stream',
        'Content-Length': String(content.length),
      },
      body: content,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      console.error(`[FAIL] 上传 ${assetName} 失败: ${uploadRes.status} ${err}`);
      process.exit(1);
    }

    log('PUBLISH', `  ${assetName} 上传完成`);
  }

  log('PUBLISH', '全部资产发布完毕');
  log('PUBLISH', `👉 https://github.com/${REPO}/releases/tag/${TAG}`);
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  log('OTTO', `Otto Desktop v${VERSION} 构建发布工具`);
  log('OTTO', `工作目录: ${DESKTOP_DIR}`);
  console.log('');

  if (SHOULD_BUILD) {
    await build();
  }

  // 检查产物（不构建时也要检查现成的）
  checkArtifacts();
  await makeLatestJson();

  if (SHOULD_PUBLISH) {
    await publishToGithub();
  }

  console.log('');
  log('DONE', '全部流程完成');
  console.log('');
  console.log(`产物目录: ${RELEASE_DIR}`);
  console.log(`  Otto-${VERSION}-arm64.dmg`);
  console.log(`  Otto-${VERSION}-x64.dmg`);
  console.log(`  latest.json`);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
