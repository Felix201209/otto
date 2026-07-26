import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(scriptDir, 'make-latest-json.mjs');
const tempDirs = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixtureDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'otto-update-manifest-'));
  tempDirs.push(dir);
  const version = '9.8.7';
  const files = [
    `Otto-Setup-${version}-win-x64.exe`,
    `Otto-${version}-arm64.dmg`,
    `Otto-${version}-x64.dmg`,
  ];
  for (const [index, name] of files.entries()) {
    await writeFile(path.join(dir, name), `fixture-${index}-${name}`);
  }
  const notes = path.join(dir, 'notes.md');
  await writeFile(notes, '# Fixture release\n');
  return { dir, files, notes, version };
}

describe('make-latest-json', () => {
  it('emits verifiable no-proxy asset URLs by default', async () => {
    const { dir, files, notes, version } = await fixtureDir();
    execFileSync(process.execPath, [scriptPath, version, notes, dir], {
      env: { ...process.env, OTTO_UPDATE_ASSET_BASE_URL: '' },
      stdio: 'pipe',
    });

    const manifest = JSON.parse(
      await readFile(path.join(dir, 'latest.json'), 'utf8'),
    );
    const assets = Object.values(manifest.assets);
    expect(assets.map((asset) => asset.name).sort()).toEqual(files.sort());
    for (const asset of assets) {
      const bytes = await readFile(path.join(dir, asset.name));
      expect(asset.url).toBe(
        `https://59.110.154.44:7777/downloads/${asset.name}`,
      );
      expect(asset.size).toBe(bytes.length);
      expect(asset.sha256).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
    }
  });

  it('supports a private deployment mirror override', async () => {
    const { dir, notes, version } = await fixtureDir();
    execFileSync(process.execPath, [scriptPath, version, notes, dir], {
      env: {
        ...process.env,
        OTTO_UPDATE_ASSET_BASE_URL: 'https://updates.example.com/otto/',
      },
      stdio: 'pipe',
    });
    const manifest = JSON.parse(
      await readFile(path.join(dir, 'latest.json'), 'utf8'),
    );
    for (const asset of Object.values(manifest.assets)) {
      expect(asset.url).toBe(`https://updates.example.com/otto/${asset.name}`);
    }
  });
});
