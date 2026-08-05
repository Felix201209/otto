/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUpdateAssetBaseUrl } from './update-mirror-config.mjs';

const AVAILABLE_ASSETS = [
  {
    key: 'win-x64',
    fileName(version) {
      return `Otto-Setup-${version}-win-x64.exe`;
    },
  },
  {
    key: 'mac-arm64',
    fileName(version) {
      return `Otto-${version}-arm64.dmg`;
    },
  },
  {
    key: 'mac-x64',
    fileName(version) {
      return `Otto-${version}-x64.dmg`;
    },
  },
];

function resolveRequiredAssets(candidate = process.env.OTTO_UPDATE_REQUIRED_ASSETS) {
  if (!candidate?.trim()) return AVAILABLE_ASSETS;
  const keys = [...new Set(candidate.split(',').map((key) => key.trim()).filter(Boolean))];
  if (keys.length === 0) throw new Error('OTTO_UPDATE_REQUIRED_ASSETS must not be empty');
  return keys.map((key) => {
    const asset = AVAILABLE_ASSETS.find((candidateAsset) => candidateAsset.key === key);
    if (!asset) throw new Error(`unknown required update asset: ${key}`);
    return asset;
  });
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`latest.json is not valid JSON: ${error.message}`);
  }
}

export function verifyUpdateManifest({
  releaseDir,
  version,
  assetBaseUrl = resolveUpdateAssetBaseUrl(),
  requiredAssets = resolveRequiredAssets(),
} = {}) {
  if (!releaseDir) throw new Error('releaseDir is required');
  if (!version) throw new Error('version is required');

  const latestPath = path.join(releaseDir, 'latest.json');
  if (!existsSync(latestPath)) throw new Error('missing latest.json');

  const manifest = readManifest(latestPath);
  if (manifest.version !== version) {
    throw new Error(
      `latest.json version mismatch: manifest=${manifest.version}, expected=${version}`,
    );
  }
  if (!manifest.assets || typeof manifest.assets !== 'object') {
    throw new Error('latest.json missing assets object');
  }

  for (const required of requiredAssets) {
    const expectedName = required.fileName(version);
    const asset = manifest.assets[required.key];
    if (!asset || typeof asset !== 'object') {
      throw new Error(`latest.json missing assets.${required.key}`);
    }
    if (asset.name !== expectedName) {
      throw new Error(
        `${required.key} name mismatch: manifest=${asset.name}, expected=${expectedName}`,
      );
    }
    const file = path.join(releaseDir, expectedName);
    if (!existsSync(file)) {
      throw new Error(`missing ${required.key} asset file: ${expectedName}`);
    }
    const size = statSync(file).size;
    if (asset.size !== size) {
      throw new Error(
        `${required.key} size mismatch: manifest=${asset.size}, expected=${size}`,
      );
    }
    const digest = sha256(file);
    if (asset.sha256 !== digest) {
      throw new Error(`${required.key} sha256 mismatch`);
    }
    const expectedUrl = `${assetBaseUrl}/${expectedName}`;
    if (asset.url !== expectedUrl) {
      throw new Error(
        `${required.key} url mismatch: manifest=${asset.url}, expected=${expectedUrl}`,
      );
    }
  }

  return {
    version: manifest.version,
    assets: requiredAssets.map((asset) => asset.key),
  };
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const [releaseDir = 'release', version] = process.argv.slice(2);
  try {
    const result = verifyUpdateManifest({ releaseDir, version });
    console.log(
      `[verify-update-manifest] ok version=${result.version} assets=${result.assets.join(',')}`,
    );
  } catch (error) {
    console.error(`[verify-update-manifest] failed: ${error.message}`);
    process.exit(1);
  }
}
