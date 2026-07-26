/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveVideoEditorIndex } from './video-editor-resource.js';

describe('video editor packaged resource', () => {
  it('打包后只从 Electron resourcesPath 读取内置编辑器', () => {
    expect(resolveVideoEditorIndex({
      isPackaged: true,
      resourcesPath: '/Applications/Otto.app/Contents/Resources',
      moduleDir: '/Applications/Otto.app/Contents/Resources/app.asar/dist/main',
    })).toBe('/Applications/Otto.app/Contents/Resources/video-editor/index.html');
  });

  it('开发态仍从仓库 resources/video-editor 读取', () => {
    expect(resolveVideoEditorIndex({
      isPackaged: false,
      resourcesPath: '/unused',
      moduleDir: '/workspace/packages/desktop/dist/main',
    })).toBe('/workspace/resources/video-editor/index.html');
  });

  it('macOS 与 Windows 安装包默认不内置视频编辑器资源', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
    ) as {
      build: {
        mac: { extraResources: Array<{ from: string; to: string }> };
        win: { extraResources: Array<{ from: string; to: string }> };
      };
    };

    for (const target of [pkg.build.mac, pkg.build.win]) {
      expect(target.extraResources).not.toContainEqual(
        expect.objectContaining({ from: '../../resources/video-editor' }),
      );
      expect(target.extraResources).not.toContainEqual(
        expect.objectContaining({ to: 'video-editor' }),
      );
    }
  });
});
