/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 软件更新的纯逻辑核心（无 Electron / Node 依赖，可被 vitest 直接单测）。
 *
 * 职责：semver 比较、latest.json 清单解析与校验、平台资产选择、
 * 下载 URL 白名单、检查结果裁决。所有网络 / 文件 / IPC 副作用都在
 * update-service.ts；这里只做可测的纯函数。
 *
 * 语义契约（completeness contract）：
 *   「检查失败」（check-failed）与「已是最新」（up-to-date）是两种不同的
 *   结果状态——网络不通 / 清单坏掉时绝不能伪装成「已是最新」。
 */

// ── 跨进程共享的形状（preload/index.ts 里有一份结构相同的副本；本包 main 的
//    tsconfig rootDir 限制导致两边不能互相 import，改动时两处需同步）──

/** 单个平台的安装包资产（来自 latest.json 的 assets[platformKey]）。 */
export interface UpdateAssetInfo {
  name: string;
  url: string;
  size: number;
  /** 64 位十六进制。无代码签名时这是唯一完整性防线，下载后必须校验。 */
  sha256: string;
}

/** 解析后的更新清单（latest.json 的结构化结果）。 */
export interface UpdateManifest {
  version: string;
  notes: string;
  publishedAt: string | null;
  /** 平台 key（如 win-x64 / mac-arm64）→ 资产。解析时已剔除非法条目。 */
  assets: Record<string, UpdateAssetInfo>;
}

/** 检查更新的三态结果：有新版 / 已是最新 / 检查失败——失败绝不冒充最新。 */
export type UpdateCheckResult =
  | {
      status: 'update-available';
      currentVersion: string;
      version: string;
      notes: string;
      publishedAt: string | null;
      /** 本平台资产；清单里没有本平台包（或走 API 兜底拿不到 sha256）时为 null。 */
      asset: UpdateAssetInfo | null;
      /** 资产缺失时让用户跳浏览器手动下载的发布页。 */
      releasePageUrl: string;
    }
  | { status: 'up-to-date'; currentVersion: string; latestVersion: string | null }
  | { status: 'check-failed'; currentVersion: string; message: string };

// ── semver ──────────────────────────────────────────────────────────────

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

/** 解析 `v?major.minor.patch(-pre)?(+build)?`；不合法返回 null。 */
export function parseSemver(raw: string): ParsedSemver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    raw.trim(),
  );
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

/**
 * 语义化版本比较：a<b → -1，a==b → 0，a>b → 1；任一侧不合法 → null
 * （调用方必须把 null 当「检查失败」处理，不许静默当成相等）。
 * 预发布规则按 semver 规范：1.4.1-beta < 1.4.1；数字标识符 < 字母标识符。
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1; // 正式版 > 预发布
  if (pb.prerelease.length === 0) return -1;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1; // 前缀更短的优先级更低
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// ── 平台资产选择 ─────────────────────────────────────────────────────────

/**
 * process.platform/arch → latest.json 的资产 key（win-x64 / mac-arm64 / …）。
 * 未覆盖的平台返回 null（有新版但没有本平台包 → UI 引导去发布页）。
 */
export function platformAssetKey(platform: string, arch: string): string | null {
  switch (platform) {
    case 'win32':
      return `win-${arch}`;
    case 'darwin':
      return `mac-${arch}`;
    case 'linux':
      return `linux-${arch}`;
    default:
      return null;
  }
}

// ── 下载 URL 白名单（纵深防御）─────────────────────────────────────────────

/**
 * 只允许 https 且 host 为 GitHub 本体 / GitHub 资产域。清单虽是自家发的，
 * 但若清单被替换 / 篡改塞进恶意 URL，这里直接拒绝——sha256 校验之外的第二道闸。
 * 企业镜像只能通过 extraAllowedOrigins 显式放行，且必须是 HTTPS
 * 精确同源（不做子域通配）。
 */
export function isAllowedAssetUrl(
  raw: string,
  extraAllowedOrigins: readonly string[] = [],
): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  for (const candidate of extraAllowedOrigins) {
    try {
      const allowed = new URL(candidate);
      if (
        allowed.protocol === 'https:'
        && !allowed.username
        && !allowed.password
        && u.origin === allowed.origin
      ) {
        return true;
      }
    } catch {
      // 非法的额外来源只忽略，不放宽默认 GitHub 白名单。
    }
  }
  const host = u.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com' || host === 'api.github.com') {
    return true;
  }
  // release 资产实际托管域（objects. / release-assets. 等子域都在这个后缀下）。
  return host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com');
}

// ── latest.json 解析 ────────────────────────────────────────────────────

/** 64 位十六进制 sha256。 */
const RE_SHA256 = /^[0-9a-fA-F]{64}$/;

type ManifestParseResult =
  | { ok: true; manifest: UpdateManifest }
  | { ok: false; error: string };

/** 逐字段校验一条资产；不合法（含 URL 不在白名单）返回 null → 上层剔除。 */
function parseAsset(
  value: unknown,
  extraAllowedOrigins: readonly string[],
): UpdateAssetInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const a = value as Record<string, unknown>;
  if (
    typeof a.name !== 'string' ||
    a.name.trim() === '' ||
    typeof a.url !== 'string' ||
    typeof a.size !== 'number' ||
    !Number.isFinite(a.size) ||
    a.size < 0 ||
    typeof a.sha256 !== 'string' ||
    !RE_SHA256.test(a.sha256)
  ) {
    return null;
  }
  if (!isAllowedAssetUrl(a.url, extraAllowedOrigins)) return null;
  return { name: a.name, url: a.url, size: a.size, sha256: a.sha256.toLowerCase() };
}

/**
 * 解析 latest.json（unknown → 结构化清单）。version 缺失/不合法 → 整体失败；
 * 单条资产不合法（缺 sha256、URL 不在白名单等）→ 只剔除该条，不拖垮其它平台。
 */
export function parseManifest(
  json: unknown,
  extraAllowedOrigins: readonly string[] = [],
): ManifestParseResult {
  if (typeof json !== 'object' || json === null) {
    return { ok: false, error: '更新清单不是合法的 JSON 对象' };
  }
  const j = json as Record<string, unknown>;
  if (typeof j.version !== 'string' || parseSemver(j.version) === null) {
    return { ok: false, error: '更新清单缺少合法的 version 字段' };
  }
  const assets: Record<string, UpdateAssetInfo> = {};
  if (typeof j.assets === 'object' && j.assets !== null) {
    for (const [key, value] of Object.entries(j.assets as Record<string, unknown>)) {
      const asset = parseAsset(value, extraAllowedOrigins);
      if (asset) assets[key] = asset;
    }
  }
  return {
    ok: true,
    manifest: {
      version: j.version,
      notes: typeof j.notes === 'string' ? j.notes : '',
      publishedAt: typeof j.publishedAt === 'string' ? j.publishedAt : null,
      assets,
    },
  };
}

// ── 检查结果裁决 ─────────────────────────────────────────────────────────

/**
 * 用解析好的清单 + 当前版本 + 平台 key 裁决检查结果。
 * 版本号比不出来（任一侧不合法）→ check-failed，绝不默认「已是最新」。
 */
export function resolveCheckOutcome(
  manifest: UpdateManifest,
  currentVersion: string,
  assetKey: string | null,
  releasePageUrl: string,
): UpdateCheckResult {
  const cmp = compareVersions(currentVersion, manifest.version);
  if (cmp === null) {
    return {
      status: 'check-failed',
      currentVersion,
      message: `版本号无法解析（当前 ${currentVersion}，清单 ${manifest.version}），无法判断是否有更新`,
    };
  }
  if (cmp >= 0) {
    return { status: 'up-to-date', currentVersion, latestVersion: manifest.version };
  }
  return {
    status: 'update-available',
    currentVersion,
    version: manifest.version,
    notes: manifest.notes,
    publishedAt: manifest.publishedAt,
    asset: assetKey ? manifest.assets[assetKey] ?? null : null,
    releasePageUrl,
  };
}

// ── GitHub Releases API 兜底解析 ────────────────────────────────────────

export interface GithubReleaseInfo {
  /** tag_name 去掉 v 前缀后的版本串（可能仍不合法，由调用方比较时兜底）。 */
  version: string;
  notes: string;
  publishedAt: string | null;
  /** release 资产里若带 latest.json，则给出其下载地址（拿到它才有 sha256）。 */
  latestJsonUrl: string | null;
}

/**
 * 解析 GET /repos/:owner/:repo/releases/latest 的响应（主 URL 404/超时的兜底）。
 * API 的 assets 不带 sha256，所以优先找 release 里附带的 latest.json 再取一次
 * 完整清单；找不到时只报版本/日志（下载走发布页手动，sha256 校验不可绕过）。
 */
export function parseGithubRelease(
  json: unknown,
): { ok: true; release: GithubReleaseInfo } | { ok: false; error: string } {
  if (typeof json !== 'object' || json === null) {
    return { ok: false, error: 'GitHub API 响应不是合法的 JSON 对象' };
  }
  const j = json as Record<string, unknown>;
  if (typeof j.tag_name !== 'string' || j.tag_name.trim() === '') {
    return { ok: false, error: 'GitHub API 响应缺少 tag_name' };
  }
  let latestJsonUrl: string | null = null;
  if (Array.isArray(j.assets)) {
    for (const item of j.assets) {
      if (typeof item !== 'object' || item === null) continue;
      const a = item as Record<string, unknown>;
      if (
        a.name === 'latest.json' &&
        typeof a.browser_download_url === 'string' &&
        isAllowedAssetUrl(a.browser_download_url)
      ) {
        latestJsonUrl = a.browser_download_url;
        break;
      }
    }
  }
  return {
    ok: true,
    release: {
      version: j.tag_name.trim().replace(/^v/, ''),
      notes: typeof j.body === 'string' ? j.body : '',
      publishedAt: typeof j.published_at === 'string' ? j.published_at : null,
      latestJsonUrl,
    },
  };
}
