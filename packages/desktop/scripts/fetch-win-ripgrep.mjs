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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');

const VENDOR_DIR = path.join(desktopRoot, 'vendor', 'win', 'ripgrep');
const RG_EXE = path.join(VENDOR_DIR, 'rg.exe');
const VERSION_STAMP = path.join(VENDOR_DIR, '.version');
const TARGET = 'x86_64-pc-windows-msvc';

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
  const zipName = `ripgrep-${version}-${TARGET}.zip`;
  const url = `https://github.com/microsoft/ripgrep-prebuilt/releases/download/${version}/${zipName}`;

  if (
    !force &&
    fs.existsSync(RG_EXE) &&
    fs.existsSync(VERSION_STAMP) &&
    fs.readFileSync(VERSION_STAMP, 'utf8').trim() === version
  ) {
    console.log(`[fetch-win-ripgrep] 已有 ${version} 的 rg.exe，跳过（--force 重下）`);
    return;
  }

  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const zipPath = path.join(VENDOR_DIR, zipName);

  console.log(`[fetch-win-ripgrep] 下载 ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  }
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

  // 解压出 rg.exe（zip 内就一个文件）。用系统 unzip，mac/linux 都有。
  execFileSync('unzip', ['-o', zipPath, 'rg.exe', '-d', VENDOR_DIR], {
    stdio: 'inherit',
  });
  fs.rmSync(zipPath);

  if (!fs.existsSync(RG_EXE)) {
    throw new Error('解压后未找到 rg.exe——zip 结构可能变了，人工检查');
  }
  fs.writeFileSync(VERSION_STAMP, `${version}\n`);
  const sizeMb = (fs.statSync(RG_EXE).size / 1024 / 1024).toFixed(1);
  console.log(`[fetch-win-ripgrep] 完成：${RG_EXE}（${sizeMb} MB，${version}）`);
}

main().catch((err) => {
  console.error('[fetch-win-ripgrep] 失败：', err.message ?? err);
  process.exit(1);
});
