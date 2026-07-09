/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 软件更新纯逻辑核心（src/main/update-core.ts）的单测。
 *
 * 为什么放在 renderer 目录：vitest.config 的 include 只收 src/renderer/**，
 * 而 tsconfig.main 的 rootDir=src/main 也不允许 main 里出现引 vitest 的测试文件
 * （会被编译进 dist 且 ESM/CJS 冲突）。update-core 是零依赖纯函数，跨目录引入
 * 只影响测试解析，不影响三段构建。
 *
 * 重点契约：
 *   - 「检查失败」（check-failed）与「已是最新」（up-to-date）是两种不同 status；
 *   - 版本号比不出来时必须报失败，绝不默认「已是最新」；
 *   - 清单资产缺 sha256 / URL 不在 GitHub 白名单 → 该资产被剔除。
 */

import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  parseSemver,
  platformAssetKey,
  isAllowedAssetUrl,
  parseManifest,
  resolveCheckOutcome,
  parseGithubRelease,
  type UpdateManifest,
} from '../main/update-core.js';

const RELEASE_PAGE = 'https://github.com/Felix201209/otto-releases/releases/latest';

// ── semver ──────────────────────────────────────────────────────────────

describe('compareVersions：语义化版本比较', () => {
  it('大小关系：patch / minor / major 逐级比较', () => {
    expect(compareVersions('1.4.0', '1.4.1')).toBe(-1);
    expect(compareVersions('1.4.1', '1.4.0')).toBe(1);
    expect(compareVersions('1.4.1', '1.4.1')).toBe(0);
    expect(compareVersions('1.9.9', '2.0.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
  });

  it('容忍 v 前缀（tag 风格 v1.4.1）', () => {
    expect(compareVersions('v1.4.0', '1.4.1')).toBe(-1);
    expect(compareVersions('1.4.1', 'v1.4.1')).toBe(0);
  });

  it('预发布 < 正式版；预发布之间按标识符比较', () => {
    expect(compareVersions('1.4.1-beta.1', '1.4.1')).toBe(-1);
    expect(compareVersions('1.4.1', '1.4.1-rc.1')).toBe(1);
    expect(compareVersions('1.4.1-beta.1', '1.4.1-beta.2')).toBe(-1);
    expect(compareVersions('1.4.1-alpha', '1.4.1-beta')).toBe(-1);
  });

  it('任一侧不合法 → null（调用方必须当检查失败处理，不许当相等）', () => {
    expect(compareVersions('abc', '1.4.1')).toBeNull();
    expect(compareVersions('1.4.1', '')).toBeNull();
    expect(compareVersions('1.4', '1.4.1')).toBeNull();
  });

  it('parseSemver：合法/不合法样例', () => {
    expect(parseSemver('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
    expect(parseSemver('v10.0.1-beta.2')).toMatchObject({ major: 10, patch: 1 });
    expect(parseSemver('1.2')).toBeNull();
    expect(parseSemver('not-a-version')).toBeNull();
  });
});

// ── 平台资产 key ─────────────────────────────────────────────────────────

describe('platformAssetKey：平台/架构 → 清单资产 key', () => {
  it('win32/x64 → win-x64；darwin/arm64 → mac-arm64；darwin/x64 → mac-x64', () => {
    expect(platformAssetKey('win32', 'x64')).toBe('win-x64');
    expect(platformAssetKey('darwin', 'arm64')).toBe('mac-arm64');
    expect(platformAssetKey('darwin', 'x64')).toBe('mac-x64');
    expect(platformAssetKey('linux', 'x64')).toBe('linux-x64');
  });

  it('未覆盖平台 → null（UI 引导去发布页）', () => {
    expect(platformAssetKey('sunos', 'x64')).toBeNull();
  });
});

// ── 下载 URL 白名单 ──────────────────────────────────────────────────────

describe('isAllowedAssetUrl：https + GitHub 域白名单（纵深防御）', () => {
  it('放行 GitHub 本体与资产域', () => {
    expect(
      isAllowedAssetUrl(
        'https://github.com/Felix201209/otto-releases/releases/download/v1.4.1/Otto-1.4.1-arm64.dmg',
      ),
    ).toBe(true);
    expect(isAllowedAssetUrl('https://objects.githubusercontent.com/abc')).toBe(true);
    expect(isAllowedAssetUrl('https://release-assets.githubusercontent.com/x')).toBe(true);
    expect(isAllowedAssetUrl('https://api.github.com/repos/x/y')).toBe(true);
  });

  it('拒绝 http / 非 GitHub 域 / 伪装域 / 垃圾输入', () => {
    expect(isAllowedAssetUrl('http://github.com/a.exe')).toBe(false);
    expect(isAllowedAssetUrl('https://evil.com/otto.exe')).toBe(false);
    expect(isAllowedAssetUrl('https://github.com.evil.com/otto.exe')).toBe(false);
    expect(isAllowedAssetUrl('https://fakegithubusercontent.com/x')).toBe(false);
    expect(isAllowedAssetUrl('ftp://github.com/a')).toBe(false);
    expect(isAllowedAssetUrl('not a url')).toBe(false);
  });
});

// ── latest.json 解析 ────────────────────────────────────────────────────

const SHA = 'a'.repeat(64);

function sampleManifestJson(): unknown {
  // 任务书里的清单结构原样样例。
  return {
    version: '1.4.1',
    notes: '## 更新日志\n- 新增软件更新',
    publishedAt: '2026-07-08T18:00:00Z',
    assets: {
      'win-x64': {
        name: 'Otto-Setup-1.4.1-win-x64.exe',
        url: 'https://github.com/Felix201209/otto-releases/releases/download/v1.4.1/Otto-Setup-1.4.1-win-x64.exe',
        size: 104857600,
        sha256: SHA,
      },
      'mac-arm64': {
        name: 'Otto-1.4.1-arm64.dmg',
        url: 'https://github.com/Felix201209/otto-releases/releases/download/v1.4.1/Otto-1.4.1-arm64.dmg',
        size: 136314880,
        sha256: SHA.toUpperCase(),
      },
    },
  };
}

describe('parseManifest：latest.json 解析与校验', () => {
  it('合法清单：两个平台资产都收下，sha256 归一为小写', () => {
    const r = parseManifest(sampleManifestJson());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.version).toBe('1.4.1');
    expect(r.manifest.notes).toContain('更新日志');
    expect(Object.keys(r.manifest.assets).sort()).toEqual(['mac-arm64', 'win-x64']);
    expect(r.manifest.assets['mac-arm64'].sha256).toBe(SHA);
  });

  it('version 缺失或不合法 → 整体解析失败', () => {
    expect(parseManifest({ notes: 'x' }).ok).toBe(false);
    expect(parseManifest({ version: 'latest' }).ok).toBe(false);
    expect(parseManifest(null).ok).toBe(false);
    expect(parseManifest('str').ok).toBe(false);
  });

  it('单条资产不合法（缺/坏 sha256、恶意 URL）→ 只剔除该条', () => {
    const json = sampleManifestJson() as {
      assets: Record<string, Record<string, unknown>>;
    };
    json.assets['win-x64'].sha256 = 'deadbeef'; // 不是 64 位十六进制
    json.assets['mac-arm64'].url = 'https://evil.com/Otto.dmg'; // 白名单外
    json.assets['linux-x64'] = {
      name: 'Otto-1.4.1.AppImage',
      url: 'https://github.com/Felix201209/otto-releases/releases/download/v1.4.1/Otto.AppImage',
      size: 1,
      sha256: SHA,
    };
    const r = parseManifest(json);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.assets['win-x64']).toBeUndefined();
    expect(r.manifest.assets['mac-arm64']).toBeUndefined();
    expect(r.manifest.assets['linux-x64']).toBeDefined();
  });
});

// ── 检查结果裁决：失败 vs 最新的语义区分 ─────────────────────────────────

function manifest(): UpdateManifest {
  const r = parseManifest(sampleManifestJson());
  if (!r.ok) throw new Error('样例清单必须合法');
  return r.manifest;
}

describe('resolveCheckOutcome：三态裁决', () => {
  it('当前版本更旧 → update-available，并选中本平台资产', () => {
    const r = resolveCheckOutcome(manifest(), '1.4.0', 'mac-arm64', RELEASE_PAGE);
    expect(r.status).toBe('update-available');
    if (r.status !== 'update-available') return;
    expect(r.version).toBe('1.4.1');
    expect(r.asset?.name).toBe('Otto-1.4.1-arm64.dmg');
    expect(r.releasePageUrl).toBe(RELEASE_PAGE);
  });

  it('清单没有本平台资产 → 仍报有新版但 asset=null（引导发布页）', () => {
    const r = resolveCheckOutcome(manifest(), '1.4.0', 'linux-arm64', RELEASE_PAGE);
    expect(r.status).toBe('update-available');
    if (r.status !== 'update-available') return;
    expect(r.asset).toBeNull();
  });

  it('当前版本相同或更新 → up-to-date（带最新版本号）', () => {
    const same = resolveCheckOutcome(manifest(), '1.4.1', 'mac-arm64', RELEASE_PAGE);
    expect(same.status).toBe('up-to-date');
    const newer = resolveCheckOutcome(manifest(), '2.0.0', 'mac-arm64', RELEASE_PAGE);
    expect(newer.status).toBe('up-to-date');
    if (newer.status !== 'up-to-date') return;
    expect(newer.latestVersion).toBe('1.4.1');
  });

  it('版本号比不出来 → check-failed，绝不冒充 up-to-date（诚实契约）', () => {
    const r = resolveCheckOutcome(manifest(), 'dev-build', 'mac-arm64', RELEASE_PAGE);
    expect(r.status).toBe('check-failed');
    expect(r.status).not.toBe('up-to-date');
    if (r.status !== 'check-failed') return;
    expect(r.message).toContain('无法');
  });
});

// ── GitHub API 兜底解析 ─────────────────────────────────────────────────

describe('parseGithubRelease：API 兜底响应解析', () => {
  it('解析 tag_name/body，并找出 release 里附带的 latest.json 资产', () => {
    const r = parseGithubRelease({
      tag_name: 'v1.4.1',
      body: '日志正文',
      published_at: '2026-07-08T18:00:00Z',
      assets: [
        { name: 'Otto-1.4.1-arm64.dmg', browser_download_url: 'https://github.com/x' },
        {
          name: 'latest.json',
          browser_download_url:
            'https://github.com/Felix201209/otto-releases/releases/download/v1.4.1/latest.json',
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.release.version).toBe('1.4.1');
    expect(r.release.notes).toBe('日志正文');
    expect(r.release.latestJsonUrl).toContain('latest.json');
  });

  it('缺 tag_name → 结构化失败；latest.json 缺席 → latestJsonUrl=null', () => {
    expect(parseGithubRelease({ body: 'x' }).ok).toBe(false);
    const r = parseGithubRelease({ tag_name: 'v1.4.1', assets: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.release.latestJsonUrl).toBeNull();
  });
});
