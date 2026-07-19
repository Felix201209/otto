/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 下载 Windows x64 版 ripgrep（rg.exe）到 vendor/win/ripgrep/，供 Windows 打包用。
 *
 * 背景：@vscode/ripgrep 的 postinstall 只下载**当前平台**的 rg 二进制，在 mac 上
 * 交叉构建 Windows 包时 node_modules 里没有 rg.exe。本脚本从同一来源
 * （microsoft/ripgrep-prebuilt releases）下载与 @vscode/ripgrep 同版本的
 * Windows 二进制，electron-builder 的 win.extraResources 再把它放进
 * `resources/ripgrep/rg.exe`——这正是 core/grep.ts 在打包形态下的查找路径。
 *
 * 设计原则：
 *   - 版本不硬编码两处：从 node_modules/@vscode/ripgrep/lib/postinstall.js
 *     读取 VERSION 常量，保证与 mac 包用的 rg 同版本。
 *   - 幂等：已存在同版本 rg.exe 时直接跳过（--force 强制重下）。
 *   - fail-loud：下载/解压失败直接退出报错，不留半截产物。
 *
 * 用法：
 *   node scripts/fetch-win-ripgrep.mjs           # 已存在则跳过
 *   node scripts/fetch-win-ripgrep.mjs --force   # 强制重新下载
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINDOWS_RIPGREP_INTEGRITY } from './ripgrep-integrity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');

const VENDOR_DIR = path.join(desktopRoot, 'vendor', 'win', 'ripgrep');
const RG_EXE = path.join(VENDOR_DIR, 'rg.exe');
const VERSION_STAMP = path.join(VENDOR_DIR, '.version');

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function assertDigest(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} SHA256 不匹配；期望 ${expected}，实际 ${actual}。`
      + ' 已停止，禁止把未核验二进制打入安装包',
    );
  }
}

/** 从 @vscode/ripgrep 的 postinstall 源码里读 VERSION 常量，保证同源同版本。 */
function readRipgrepVersion() {
  const postinstall = path.join(
    repoRoot,
    'node_modules',
    '@vscode',
    'ripgrep',
    'lib',
    'postinstall.js',
  );
  const src = fs.readFileSync(postinstall, 'utf8');
  const m = src.match(/^const VERSION = '([^']+)';/m);
  if (!m) {
    throw new Error(
      `无法从 ${postinstall} 解析 VERSION 常量——@vscode/ripgrep 版本更新后脚本需跟进`,
    );
  }
  return m[1];
}

async function main() {
  const force = process.argv.includes('--force');
  const version = readRipgrepVersion();
  const integrity = WINDOWS_RIPGREP_INTEGRITY[version];
  if (!integrity) {
    throw new Error(
      `尚未登记 ${version} 的可信摘要；请先核验 microsoft/ripgrep-prebuilt 上游资产`,
    );
  }
  const zipName = `ripgrep-${version}-${integrity.target}.zip`;
  const url = `https://github.com/microsoft/ripgrep-prebuilt/releases/download/${version}/${zipName}`;

  if (
    !force &&
    fs.existsSync(RG_EXE) &&
    fs.existsSync(VERSION_STAMP) &&
    fs.readFileSync(VERSION_STAMP, 'utf8').trim() === version
  ) {
    const executableDigest = sha256(fs.readFileSync(RG_EXE));
    assertDigest(
      executableDigest,
      integrity.executableSha256,
      `已有 ${version} rg.exe`,
    );
    console.log(
      `[fetch-win-ripgrep] 已核验 ${version} 的 rg.exe `
      + `(${executableDigest.slice(0, 16)}...)，跳过（--force 重下）`,
    );
    return;
  }

  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(VENDOR_DIR, '.staging-'));
  const zipPath = path.join(stagingDir, zipName);
  const stagedExecutable = path.join(stagingDir, 'rg.exe');

  try {
    console.log(`[fetch-win-ripgrep] 下载 ${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`下载失败 HTTP ${res.status}：${url}`);
    }
    const zipBytes = Buffer.from(await res.arrayBuffer());
    assertDigest(sha256(zipBytes), integrity.zipSha256, `${version} 上游 ZIP`);
    fs.writeFileSync(zipPath, zipBytes);

    // 解压到隔离目录，摘要通过后才替换正式构建输入。
    if (process.platform === 'win32') {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          '& { param($zipPath, $stagingDir) Expand-Archive -LiteralPath $zipPath -DestinationPath $stagingDir -Force }',
          zipPath,
          stagingDir,
        ],
        { stdio: 'inherit' },
      );
    } else {
      execFileSync('unzip', ['-o', zipPath, 'rg.exe', '-d', stagingDir], {
        stdio: 'inherit',
      });
    }
    if (!fs.existsSync(stagedExecutable)) {
      throw new Error('解压后未找到 rg.exe——zip 结构可能变了，人工检查');
    }
    const executableDigest = sha256(fs.readFileSync(stagedExecutable));
    assertDigest(
      executableDigest,
      integrity.executableSha256,
      `${version} 解压后的 rg.exe`,
    );

    fs.copyFileSync(stagedExecutable, RG_EXE);
    fs.writeFileSync(VERSION_STAMP, `${version}\n`);
    const sizeMb = (fs.statSync(RG_EXE).size / 1024 / 1024).toFixed(1);
    console.log(
      `[fetch-win-ripgrep] 完成：${RG_EXE}（${sizeMb} MB，${version}，`
      + `SHA256 ${executableDigest.slice(0, 16)}...）`,
    );
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[fetch-win-ripgrep] 失败：', err.message ?? err);
  process.exit(1);
});
