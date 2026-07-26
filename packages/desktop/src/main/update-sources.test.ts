/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  FALLBACK_RELEASE_API_URL,
  GITHUB_MANIFEST_URL,
  PRIMARY_MANIFEST_URL,
  RELEASE_PAGE_URL,
  resolveManifestUrls,
} from './update-sources.js';

describe('桌面应用更新源', () => {
  it('主源使用企业 HTTPS 镜像，避开 GitHub release 资产直链不稳定', () => {
    const url = new URL(PRIMARY_MANIFEST_URL);
    expect(url.protocol).toBe('https:');
    expect(url.origin).toBe('https://59.110.154.44:7777');
    expect(url.pathname).toBe('/otto-releases/latest.json');
  });

  it('GitHub 清单、兜底 API 与手动发布页仍指向同一个公开仓库', () => {
    expect(GITHUB_MANIFEST_URL).toBe(
      'https://github.com/Felix201209/otto-releases/releases/latest/download/latest.json',
    );
    expect(FALLBACK_RELEASE_API_URL).toBe(
      'https://api.github.com/repos/Felix201209/otto-releases/releases/latest',
    );
    expect(RELEASE_PAGE_URL).toBe(
      'https://github.com/Felix201209/otto-releases/releases/latest',
    );
  });

  it('允许把显式 HTTPS 企业镜像放在 GitHub 前面，并自动去重', () => {
    expect(resolveManifestUrls('https://updates.example.com/otto/latest.json')).toEqual([
      'https://updates.example.com/otto/latest.json',
      PRIMARY_MANIFEST_URL,
      GITHUB_MANIFEST_URL,
    ]);
    expect(resolveManifestUrls(PRIMARY_MANIFEST_URL)).toEqual([
      PRIMARY_MANIFEST_URL,
      GITHUB_MANIFEST_URL,
    ]);
  });

  it.each([
    'http://updates.example.com/latest.json',
    'file:///tmp/latest.json',
    'https://user:password@updates.example.com/latest.json',
    'not-a-url',
  ])('忽略不安全或非法的镜像地址：%s', (candidate) => {
    expect(resolveManifestUrls(candidate)).toEqual([PRIMARY_MANIFEST_URL, GITHUB_MANIFEST_URL]);
  });
});
