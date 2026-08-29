/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Otto Desktop 更新入口的单一事实源。默认走企业镜像，避开部分网络环境下
 * GitHub release 资产直链 fetch failed；GitHub 仍作为兜底。
 */

export const PRIMARY_MANIFEST_URL =
  'https://59.110.154.44:7777/otto-releases/latest.json';

export const GITHUB_MANIFEST_URL =
  'https://github.com/NSIETeam/otto-new/releases/latest/download/latest.json';

/**
 * V1.9.13 及更早客户端硬编码的公开发布入口。迁移期必须继续发布同一份
 * latest.json 和安装包，直到所有受支持客户端都已升级到包含新入口的版本。
 */
export const LEGACY_GITHUB_MANIFEST_URL =
  'https://github.com/Felix201209/otto-releases/releases/latest/download/latest.json';

export const FALLBACK_RELEASE_API_URL =
  'https://api.github.com/repos/NSIETeam/otto-new/releases/latest';

export const RELEASE_PAGE_URL =
  'https://github.com/NSIETeam/otto-new/releases/latest';

/**
 * 企业可通过 OTTO_UPDATE_MANIFEST_URL 提供就近 HTTPS 镜像。地址无效、非 HTTPS、
 * 或含 URL 凭证时直接忽略；GitHub 官方清单始终保留为下一跳。
 */
export function resolveManifestUrls(candidate?: string | null): string[] {
  const urls: string[] = [];
  const value = candidate?.trim();
  if (value) {
    try {
      const parsed = new URL(value);
      if (
        parsed.protocol === 'https:' &&
        !parsed.username &&
        !parsed.password
      ) {
        urls.push(parsed.toString());
      }
    } catch {
      // 非法配置按未配置处理，绝不能阻断官方 GitHub 更新源。
    }
  }
  for (const fallback of [
    PRIMARY_MANIFEST_URL,
    GITHUB_MANIFEST_URL,
    LEGACY_GITHUB_MANIFEST_URL,
  ]) {
    if (!urls.includes(fallback)) urls.push(fallback);
  }
  return urls;
}
