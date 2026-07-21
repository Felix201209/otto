/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Otto Desktop 更新入口的单一事实源。公开 release 仓同时提供 latest.json 与安装包，
 * 避免把客户端绑到未部署路由的业务服务器。
 */

export const PRIMARY_MANIFEST_URL =
  'https://github.com/Felix201209/otto-releases/releases/latest/download/latest.json';

export const FALLBACK_RELEASE_API_URL =
  'https://api.github.com/repos/Felix201209/otto-releases/releases/latest';

export const RELEASE_PAGE_URL =
  'https://github.com/Felix201209/otto-releases/releases/latest';

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
  if (!urls.includes(PRIMARY_MANIFEST_URL)) urls.push(PRIMARY_MANIFEST_URL);
  return urls;
}
