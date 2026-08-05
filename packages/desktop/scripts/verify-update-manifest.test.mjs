import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_UPDATE_ASSET_BASE_URL } from './update-mirror-config.mjs';
import { verifyUpdateManifest } from './verify-update-manifest.mjs';

const tempDirs = [];
const scriptPath = fileURLToPath(
  new URL('./verify-update-manifest.mjs', import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function writeFixtureRelease() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'otto-verify-update-'));
  tempDirs.push(dir);
  const version = '9.8.7';
  const files = [
    `Otto-Setup-${version}-win-x64.exe`,
    `Otto-${version}-arm64.dmg`,
    `Otto-${version}-x64.dmg`,
  ];
  const assets = {};
  const keys = ['win-x64', 'mac-arm64', 'mac-x64'];
  for (const [index, name] of files.entries()) {
    const contents = Buffer.from(`asset-${index}-${name}`);
    await writeFile(path.join(dir, name), contents);
    assets[keys[index]] = {
      name,
      url: `${DEFAULT_UPDATE_ASSET_BASE_URL}/${name}`,
      size: contents.length,
      sha256: createHash('sha256').update(contents).digest('hex'),
    };
  }
  await writeFile(
    path.join(dir, 'latest.json'),
    `${JSON.stringify({ version, notes: '', publishedAt: '', assets }, null, 2)}\n`,
  );
  return { assets, dir, version };
}

async function rewriteManifest(dir, mutate) {
  const latest = path.join(dir, 'latest.json');
  const manifest = JSON.parse(await readFile(latest, 'utf8'));
  mutate(manifest);
  await writeFile(latest, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe('verify-update-manifest', () => {
  it('accepts a complete manifest whose assets match local files', async () => {
    const { dir, version } = await writeFixtureRelease();

    expect(verifyUpdateManifest({ releaseDir: dir, version })).toEqual({
      version,
      assets: ['win-x64', 'mac-arm64', 'mac-x64'],
    });
  });

  it('verifies an explicitly selected Windows-only transition asset', async () => {
    const { dir, version } = await writeFixtureRelease();
    await rewriteManifest(dir, (manifest) => {
      manifest.assets = { 'win-x64': manifest.assets['win-x64'] };
    });

    expect(verifyUpdateManifest({
      releaseDir: dir,
      version,
      requiredAssets: [{
        key: 'win-x64',
        fileName: (targetVersion) => `Otto-Setup-${targetVersion}-win-x64.exe`,
      }],
    })).toEqual({ version, assets: ['win-x64'] });
  });

  it('runs the verifier when invoked directly on Windows', async () => {
    const { dir, version } = await writeFixtureRelease();
    const output = execFileSync(process.execPath, [scriptPath, dir, version], {
      encoding: 'utf8',
    });
    expect(output).toContain(`[verify-update-manifest] ok version=${version}`);
  });

  it('rejects manifest key drift before release upload', async () => {
    const { dir, version } = await writeFixtureRelease();
    await rewriteManifest(dir, (manifest) => {
      manifest.assets.macArm64 = manifest.assets['mac-arm64'];
      delete manifest.assets['mac-arm64'];
    });

    expect(() => verifyUpdateManifest({ releaseDir: dir, version })).toThrow(
      'latest.json missing assets.mac-arm64',
    );
  });

  it('rejects missing release files referenced by latest.json', async () => {
    const { dir, version } = await writeFixtureRelease();
    await rm(path.join(dir, `Otto-${version}-x64.dmg`));

    expect(() => verifyUpdateManifest({ releaseDir: dir, version })).toThrow(
      `missing mac-x64 asset file: Otto-${version}-x64.dmg`,
    );
  });

  it('rejects stale size, sha256, and mirror URL metadata', async () => {
    const { dir, version } = await writeFixtureRelease();
    await rewriteManifest(dir, (manifest) => {
      manifest.assets['win-x64'].size += 1;
    });
    expect(() => verifyUpdateManifest({ releaseDir: dir, version })).toThrow(
      'win-x64 size mismatch',
    );

    const { dir: shaDir } = await writeFixtureRelease();
    await rewriteManifest(shaDir, (manifest) => {
      manifest.assets['win-x64'].sha256 = '0'.repeat(64);
    });
    expect(() =>
      verifyUpdateManifest({ releaseDir: shaDir, version }),
    ).toThrow('win-x64 sha256 mismatch');

    const { dir: urlDir } = await writeFixtureRelease();
    await rewriteManifest(urlDir, (manifest) => {
      manifest.assets['win-x64'].url = 'https://example.com/Otto.exe';
    });
    expect(() =>
      verifyUpdateManifest({ releaseDir: urlDir, version }),
    ).toThrow('win-x64 url mismatch');
  });
});
