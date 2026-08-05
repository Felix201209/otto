/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '../..');
const require = createRequire(import.meta.url);
const afterPack = require('./after-pack.cjs');

describe('desktop packaging contract', () => {
  it('declares every root-only release script dependency explicitly', async () => {
    const rootPackageJson = JSON.parse(
      await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    );
    expect(rootPackageJson.devDependencies.ora).toBe('^9.0.0');
  });

  it('uses a real multi-resolution ICO for Windows packaging', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(packageJson.build.win.icon).toBe('build/icon.ico');

    const icon = await readFile(path.join(packageRoot, 'build', 'icon.ico'));
    expect(icon.readUInt16LE(0)).toBe(0);
    expect(icon.readUInt16LE(2)).toBe(1);
    const count = icon.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(4);
    const sizes = new Set();
    for (let index = 0; index < count; index += 1) {
      const entryOffset = 6 + index * 16;
      const widthByte = icon[entryOffset];
      const heightByte = icon[entryOffset + 1];
      const imageSize = icon.readUInt32LE(entryOffset + 8);
      const imageOffset = icon.readUInt32LE(entryOffset + 12);
      sizes.add(widthByte === 0 ? 256 : widthByte);
      expect(heightByte === 0 ? 256 : heightByte).toBe(widthByte === 0 ? 256 : widthByte);
      // rcedit writes this size through a 16-bit Windows resource field. A
      // larger PNG is truncated in the final Otto.exe even though the source
      // ICO itself still opens correctly.
      expect(imageSize).toBeLessThanOrEqual(0xffff);
      expect(imageOffset + imageSize).toBeLessThanOrEqual(icon.length);
    }
    for (const size of [16, 32, 48, 256]) {
      expect(sizes.has(size)).toBe(true);
    }
  });

  it('uses a complete multi-resolution ICNS for macOS packaging', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(packageJson.build.mac.icon).toBe('build/icon.icns');

    const icon = await readFile(path.join(packageRoot, 'build', 'icon.icns'));
    expect(icon.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(icon.readUInt32BE(4)).toBe(icon.length);

    const chunkTypes = new Set();
    let offset = 8;
    while (offset + 8 <= icon.length) {
      const type = icon.subarray(offset, offset + 4).toString('ascii');
      const length = icon.readUInt32BE(offset + 4);
      expect(length).toBeGreaterThanOrEqual(8);
      expect(offset + length).toBeLessThanOrEqual(icon.length);
      chunkTypes.add(type);
      offset += length;
    }
    expect(offset).toBe(icon.length);
    for (const type of ['ic07', 'ic08', 'ic09', 'ic10']) {
      expect(chunkTypes.has(type)).toBe(true);
    }
  });

  it('keeps the public browser previews on their current model display names', async () => {
    const [mockPreview, browserBridge] = await Promise.all([
      readFile(path.join(packageRoot, 'preview', 'mock.tsx'), 'utf8'),
      readFile(
        path.join(packageRoot, 'src', 'renderer', 'browserPreviewBridge.ts'),
        'utf8',
      ),
    ]);
    expect(mockPreview).toContain("displayName: '高端推理模型'");
    expect(browserBridge).toContain("displayName: 'GPT-5.1'");
    expect(browserBridge).not.toContain("displayName: 'gpt-5.1（本地预览）'");
  });

  it('keeps default installers below the lightweight contract by excluding optional runtimes', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    const resources = [
      ...(packageJson.build.mac.extraResources ?? []),
      ...(packageJson.build.win.extraResources ?? []),
    ];
    const bundledInputs = resources.map((resource) => resource.from).join('\n');
    expect(bundledInputs).not.toContain('vendor/runtime');
    expect(bundledInputs).not.toContain('resources/video-editor');
  });

  it('does not exclude runtime build/src modules required by ESM dependencies', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(packageJson.build.files).not.toContain('!**/node_modules/**/src/**');
  });

  it('uses the current dependency collector and verifies the packaged Windows runtime', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(packageJson.build).not.toHaveProperty('includeSubNodeModules');
    expect(packageJson.build.publish).toEqual([
      {
        provider: 'generic',
        url: 'https://59.110.154.44:7777/downloads',
      },
    ]);
    expect(packageJson.scripts['dist:win']).toContain(
      'node scripts/verify-packaged-runtime.mjs release/win-unpacked/resources/app.asar --platform win32',
    );
    expect(packageJson.scripts['dist:win']).toContain('--publish never');
  });

  it('keeps update manifest download URLs bound to the no-proxy update mirror', async () => {
    const script = await readFile(
      path.join(packageRoot, 'scripts', 'make-delivery-zip.mjs'),
      'utf8',
    );
    const mirrorConfig = await readFile(
      path.join(packageRoot, 'scripts', 'update-mirror-config.mjs'),
      'utf8',
    );
    expect(script).toContain('resolveUpdateAssetBaseUrl()');
    expect(mirrorConfig).toContain('process.env.OTTO_UPDATE_ASSET_BASE_URL');
    expect(mirrorConfig).toContain('https://59.110.154.44:7777/downloads');
    expect(script).not.toContain('github.com/Felix201209/otto-releases/releases/download');
  });

  it('disables electron-builder implicit publishing for tagged release builds', async () => {
    const script = await readFile(
      path.join(packageRoot, 'scripts', 'make-delivery-zip.mjs'),
      'utf8',
    );
    expect(script).toMatch(/'--publish',\s*'never'/);
  });

  it('requires an explicit transition flag before disabling macOS signing', async () => {
    const script = await readFile(
      path.join(packageRoot, 'scripts', 'make-delivery-zip.mjs'),
      'utf8',
    );
    const workflow = await readFile(
      path.join(repoRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    expect(script).toContain("process.env.OTTO_ALLOW_UNSIGNED_MAC === '1'");
    expect(script).toContain("'--config.mac.identity=null'");
    expect(script).toContain("'--config.mac.hardenedRuntime=false'");
    expect(script).toContain("'--config.mac.notarize=false'");
    expect(script).toContain("'--config.dmg.sign=false'");
    expect(script).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'");
    expect(workflow).toContain('unsigned_mac_transition:');
    expect(workflow).toContain(
      "OTTO_ALLOW_UNSIGNED_MAC: ${{ inputs.unsigned_mac_transition && '1' || '0' }}",
    );
  });

  it('publishes releases only after the update mirror and enterprise deploy pass', async () => {
    const workflow = await readFile(
      path.join(repoRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    expect(workflow).toContain('deploy-update-mirror:');
    expect(workflow).toContain('name: Deploy Desktop Update Mirror');
    expect(workflow).toContain('draft: true');
    expect(workflow).toContain("needs.deploy-update-mirror.result == 'success'");
    expect(workflow).toContain("needs.deploy-enterprise.result == 'success'");
    expect(workflow).toContain(
      'node packages/desktop/scripts/verify-update-manifest.mjs "$DESKTOP_RELEASE" "$VERSION"',
    );
    expect(workflow).toContain(
      'node packages/desktop/scripts/verify-update-manifest.mjs "mirror-upload" "$VERSION"',
    );
    expect(
      workflow.match(/node packages\/desktop\/scripts\/verify-update-manifest\.mjs/g)
        ?.length,
    ).toBe(2);
    expect(workflow).not.toContain("['macArm64', 'macX64', 'winX64']");
    expect(workflow).not.toContain("const crypto = require('node:crypto');");
    expect(workflow).toContain('sha256sum -c SHA256SUMS');
    expect(workflow).toContain('latest.json.next');
    expect(workflow).toContain('Windows no-proxy download');
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$INTERNAL_COMMIT" "$SOURCE_COMMIT"',
    );
    expect(workflow).toContain('refs/heads/release/*');
    expect(workflow.indexOf('name: Upload workflow artifacts')).toBeLessThan(
      workflow.indexOf('name: Create draft GitHub release'),
    );
    expect(workflow).toContain("if: github.repository == 'Felix201209/otto'");
    expect(workflow).toContain('token: ${{ secrets.OTTO_RELEASES_TOKEN }}');
    expect(workflow).not.toContain(
      'secrets.OTTO_RELEASES_TOKEN || secrets.GITHUB_TOKEN',
    );
  });

  it('uses the shared update manifest verifier in the local release gate', async () => {
    const gate = await readFile(
      path.join(packageRoot, 'scripts', 'release-recovery-gate.mjs'),
      'utf8',
    );
    expect(gate).toContain(
      "import { verifyUpdateManifest } from './verify-update-manifest.mjs'",
    );
    expect(gate).toContain('verifyUpdateManifest({');
    expect(gate).toContain('releaseAssetCandidates.some(existsSync)');
    expect(gate).not.toContain("manifest.assets?.['win-x64']");
    expect(gate).not.toContain('latest.json win-x64 sha256 mismatch');
  });

  it('discovers every packaged LibreOffice bundle before signing Otto', async () => {
    const appPath = await mkdtemp(path.join(os.tmpdir(), 'otto-after-pack-'));
    try {
      const arm64Bundle = path.join(
        appPath,
        'Contents',
        'Resources',
        'runtime',
        'darwin-arm64',
        'libreoffice',
        'LibreOffice.app',
      );
      const x64Bundle = path.join(
        appPath,
        'Contents',
        'Resources',
        'runtime',
        'darwin-x64',
        'libreoffice',
        'LibreOffice.app',
      );
      await Promise.all([
        mkdir(arm64Bundle, { recursive: true }),
        mkdir(x64Bundle, { recursive: true }),
      ]);

      expect(afterPack.findNestedLibreOfficeBundles(appPath)).toEqual([
        arm64Bundle,
        x64Bundle,
      ]);
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });
});
