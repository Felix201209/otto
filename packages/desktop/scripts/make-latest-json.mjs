/**
 * 生成应用内更新源清单 latest.json。
 *
 * 用法：node scripts/make-latest-json.mjs <version> <notes文件.md> [产物目录=release]
 *
 * 扫描产物目录下与该版本匹配的双平台安装包（win NSIS .exe / mac arm64 .dmg），
 * 计算 sha256 与体积，产出 release/latest.json。URL 默认指向 Otto 国内镜像，
 * 也可用 OTTO_UPDATE_ASSET_BASE_URL 指向私有化部署的 HTTPS 镜像；app 端 UpdateService 依赖此结构
 * （见 src/main/update-service.ts），字段增删要两边同步。
 *
 * sha256 必须真算不可省：安装包无代码签名，这是 app 内更新唯一的完整性防线。
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveUpdateAssetBaseUrl } from './update-mirror-config.mjs';

const UPDATE_ASSET_BASE_URL = resolveUpdateAssetBaseUrl();
const ASSET_DEFINITIONS = {
  'win-x64': (targetVersion) => `Otto-Setup-${targetVersion}-win-x64.exe`,
  'mac-arm64': (targetVersion) => `Otto-${targetVersion}-arm64.dmg`,
  'mac-x64': (targetVersion) => `Otto-${targetVersion}-x64.dmg`,
};

function selectedAssetKeys(candidate = process.env.OTTO_UPDATE_REQUIRED_ASSETS) {
  if (!candidate?.trim()) return Object.keys(ASSET_DEFINITIONS);
  const keys = [...new Set(candidate.split(',').map((key) => key.trim()).filter(Boolean))];
  if (keys.length === 0 || keys.some((key) => !(key in ASSET_DEFINITIONS))) {
    throw new Error(`Invalid OTTO_UPDATE_REQUIRED_ASSETS: ${candidate}`);
  }
  return keys;
}

const [version, notesFile, outDir = 'release'] = process.argv.slice(2);
if (!version || !notesFile) {
  console.error('用法：node scripts/make-latest-json.mjs <version> <notes.md> [产物目录]');
  process.exit(1);
}

async function sha256(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

async function assetEntry(fileName) {
  const p = path.join(outDir, fileName);
  const s = await stat(p); // 不存在直接抛错——缺产物就该失败，不出残缺清单
  return {
    name: fileName,
    url: `${UPDATE_ASSET_BASE_URL}/${fileName}`,
    size: s.size,
    sha256: await sha256(p),
  };
}

const { readFile } = await import('node:fs/promises');
const notes = await readFile(notesFile, 'utf8');
const assetKeys = selectedAssetKeys();
const assets = {};
for (const key of assetKeys) {
  assets[key] = await assetEntry(ASSET_DEFINITIONS[key](version));
}

const manifest = {
  version,
  notes,
  publishedAt: new Date().toISOString(),
  assets,
};

const out = path.join(outDir, 'latest.json');
await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`已生成 ${out}`);
for (const key of assetKeys) {
  console.log(`  ${key}: ${manifest.assets[key].size} bytes  sha256=${manifest.assets[key].sha256}`);
}
