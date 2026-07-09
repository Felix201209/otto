/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 软件更新服务（main 进程副作用层）。纯逻辑在 update-core.ts，sha256 在
 * update-verify.ts；本文件负责网络、文件、进度推送与安装器拉起。
 *
 * 更新源（公开仓 Felix201209/otto-releases，只放安装包 + 清单）：
 *   主：GET releases/latest/download/latest.json（匿名、跟随重定向、免 API 限流）；
 *   兜底：GET api.github.com/.../releases/latest（主 URL 404/超时时），并优先从
 *   release 资产里再取 latest.json 拿完整清单——API 的 assets 不带 sha256，
 *   而 sha256 校验不可绕过，拿不到清单就只报版本、引导去发布页手动下载。
 *
 * 诚实契约：网络失败 / 清单坏掉 → status 'check-failed'（结构化错误，不抛裸异常），
 * 绝不伪装成「已是最新」。
 *
 * 安全：下载 URL 只允许 https + GitHub 资产域白名单（update-core.isAllowedAssetUrl，
 * 清单解析与下载前双重把关）；下载完成必须 sha256 校验（无签名时的唯一完整性防线），
 * 不匹配删文件报错。同一时间只允许一个下载任务（单例守护），支持取消。
 *
 * 已知限制：中国大陆直连 GitHub release 下载可能较慢或超时——失败文案里如实
 * 提示，可重试或配代理，不做静默降级。
 */

import { app, shell } from 'electron';
import type { WebContents } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isAllowedAssetUrl,
  parseGithubRelease,
  parseManifest,
  platformAssetKey,
  resolveCheckOutcome,
  type UpdateAssetInfo,
  type UpdateCheckResult,
} from './update-core.js';
import { computeFileSha256, verifyOrDeleteFile } from './update-verify.js';

/** 主更新源：latest release 的 latest.json 直链（匿名 + 302 跟随，免 API 限流）。 */
const PRIMARY_MANIFEST_URL =
  'https://github.com/Felix201209/otto-releases/releases/latest/download/latest.json';
/** 兜底：GitHub Releases API（匿名，60 次/小时限流，仅主 URL 失败时才碰）。 */
const FALLBACK_API_URL =
  'https://api.github.com/repos/Felix201209/otto-releases/releases/latest';
/** 资产缺失时引导用户手动下载的发布页。 */
const RELEASE_PAGE_URL = 'https://github.com/Felix201209/otto-releases/releases/latest';

/** 检查更新的单次请求超时（任务书定 15s）。 */
const CHECK_TIMEOUT_MS = 15_000;
/** 下载进度推送节流（~250ms 一次，别刷爆 IPC）。 */
const PROGRESS_THROTTLE_MS = 250;

/** 下载进度（webContents.send 推给 renderer）。 */
export interface UpdateProgressInfo {
  percent: number;
  transferred: number;
  total: number;
}

/** 下载结果（结构化，不抛裸异常）。 */
export type UpdateDownloadResult =
  | { ok: true; filePath: string; reused: boolean }
  | { ok: false; cancelled?: boolean; error: string };

/** 安装结果。 */
export interface UpdateInstallResult {
  ok: boolean;
  message: string;
}

type FetchJsonResult =
  | { ok: true; json: unknown }
  | { ok: false; error: string; httpStatus?: number };

/** 带超时的匿名 JSON GET（跟随重定向）。所有失败都折叠成结构化错误。 */
async function fetchJson(url: string, timeoutMs: number): Promise<FetchJsonResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // GitHub API 要求 UA；带上 Accept 让两个源都返回 JSON。
        'user-agent': 'otto-desktop-updater',
        accept: 'application/json, application/vnd.github+json',
      },
    });
    if (!res.ok) {
      return { ok: false, error: `更新源返回 HTTP ${res.status}`, httpStatus: res.status };
    }
    try {
      return { ok: true, json: (await res.json()) as unknown };
    } catch {
      return { ok: false, error: '更新清单不是有效的 JSON' };
    }
  } catch (e) {
    if (timedOut) {
      return { ok: false, error: `检查更新超时（${Math.round(timeoutMs / 1000)}s 内无响应）` };
    }
    return {
      ok: false,
      error:
        '网络请求失败，无法连接 GitHub（中国大陆直连可能较慢或不通，' +
        `可稍后重试或配置代理）：${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 写一个 chunk 并等它落盘（借 write 回调自然串行，避免写缓冲无界膨胀）。 */
function writeChunk(stream: fs.WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

/** 关闭写流（end 完成后 resolve）。 */
function endStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(() => resolve()));
}

export class UpdateService {
  /** 最近一次「有新版」的检查结果（downloadUpdate 只信它，不接受 renderer 传 URL）。 */
  private lastAvailable: Extract<UpdateCheckResult, { status: 'update-available' }> | null =
    null;
  /** 进行中的下载（单例守护：同一时间只允许一个）。 */
  private downloading: { controller: AbortController; partPath: string } | null = null;
  /** 已下载并通过 sha256 校验的安装包（installUpdate 只打开它）。 */
  private readyFile: { filePath: string; version: string } | null = null;

  constructor(
    /** 目标窗口 webContents（进度推送用；窗口可能重建，故传 getter）。 */
    private readonly getWebContents: () => WebContents | undefined,
    /** 进度事件的 IPC channel 名（由 index.ts 的 IPC 常量表传入，保持单一事实源）。 */
    private readonly progressChannel: string,
  ) {}

  /**
   * 检查更新：主 URL → 兜底 API（可再跳 release 内的 latest.json 取完整清单）。
   * 永远返回结构化结果；失败 = 'check-failed'，与「已是最新」严格区分。
   */
  async checkForUpdate(): Promise<UpdateCheckResult> {
    const currentVersion = app.getVersion();
    const assetKey = platformAssetKey(process.platform, process.arch);

    // 1) 主源：latest.json 直链。
    const primary = await fetchJson(PRIMARY_MANIFEST_URL, CHECK_TIMEOUT_MS);
    if (primary.ok) {
      const parsed = parseManifest(primary.json);
      if (parsed.ok) {
        return this.remember(
          resolveCheckOutcome(parsed.manifest, currentVersion, assetKey, RELEASE_PAGE_URL),
        );
      }
      // 主源拿到了内容但清单坏了：如实报失败（不再让 API 兜底掩盖发版脚本的问题）。
      return { status: 'check-failed', currentVersion, message: parsed.error };
    }

    // 2) 兜底：Releases API（主源 404/超时/网络失败时）。
    const fallback = await fetchJson(FALLBACK_API_URL, CHECK_TIMEOUT_MS);
    if (!fallback.ok) {
      return {
        status: 'check-failed',
        currentVersion,
        message: `主源失败（${primary.error}）；兜底 API 也失败（${fallback.error}）`,
      };
    }
    const release = parseGithubRelease(fallback.json);
    if (!release.ok) {
      return { status: 'check-failed', currentVersion, message: release.error };
    }

    // 2a) release 资产里带 latest.json → 再取一次完整清单（才有 sha256 可校验）。
    if (release.release.latestJsonUrl) {
      const manifestRes = await fetchJson(release.release.latestJsonUrl, CHECK_TIMEOUT_MS);
      if (manifestRes.ok) {
        const parsed = parseManifest(manifestRes.json);
        if (parsed.ok) {
          return this.remember(
            resolveCheckOutcome(parsed.manifest, currentVersion, assetKey, RELEASE_PAGE_URL),
          );
        }
      }
    }

    // 2b) 拿不到清单 → 只报版本/日志，不给资产（sha256 校验不可绕过），引导发布页。
    //     组装一个无资产清单走统一裁决（parseManifest 顺带把 tag 版本号合法性验掉）。
    const parsedFromApi = parseManifest({
      version: release.release.version,
      notes: release.release.notes,
      publishedAt: release.release.publishedAt,
      assets: {},
    });
    if (!parsedFromApi.ok) {
      return {
        status: 'check-failed',
        currentVersion,
        message: `兜底 API 的 tag（${release.release.version}）不是合法版本号`,
      };
    }
    return this.remember(
      resolveCheckOutcome(parsedFromApi.manifest, currentVersion, assetKey, RELEASE_PAGE_URL),
    );
  }

  /** 缓存「有新版」结果供 downloadUpdate 使用；其它状态则清掉旧缓存。 */
  private remember(result: UpdateCheckResult): UpdateCheckResult {
    this.lastAvailable = result.status === 'update-available' ? result : null;
    return result;
  }

  /**
   * 下载最近一次检查到的新版资产到系统「下载」目录。
   *   - 单例守护：已有任务时直接拒绝；
   *   - 同名文件已存在且 sha256 匹配 → 直接复用，跳过下载；
   *   - 先写 .part，下完 sha256 校验（不匹配删文件报错）再改名为正式文件名；
   *   - 进度经 webContents.send 节流推送（~250ms）。
   */
  async downloadUpdate(): Promise<UpdateDownloadResult> {
    if (this.downloading) {
      return { ok: false, error: '已有一个下载任务在进行中' };
    }
    const available = this.lastAvailable;
    const asset = available?.asset;
    if (!available || !asset) {
      return { ok: false, error: '当前没有可下载的更新，请先检查更新' };
    }
    // 纵深防御：清单解析时已过白名单，下载前再验一次（防中间态被改）。
    if (!isAllowedAssetUrl(asset.url)) {
      return { ok: false, error: '安装包下载地址不在允许的 GitHub 域名内，已拒绝下载' };
    }

    // basename 防清单里的 name 携带路径穿越（如 ../../xx）。
    const fileName = path.basename(asset.name);
    const finalPath = path.join(app.getPath('downloads'), fileName);

    // 同名文件已存在：sha256 匹配就复用；不匹配则视为旧/坏文件，重新下载覆盖。
    if (fs.existsSync(finalPath)) {
      try {
        const existing = await computeFileSha256(finalPath);
        if (existing === asset.sha256) {
          this.readyFile = { filePath: finalPath, version: available.version };
          return { ok: true, filePath: finalPath, reused: true };
        }
      } catch {
        // 读失败按「需要重新下载」处理。
      }
    }

    const partPath = finalPath + '.part';
    const controller = new AbortController();
    this.downloading = { controller, partPath };
    try {
      return await this.streamDownload(asset, available.version, partPath, finalPath, controller);
    } finally {
      this.downloading = null;
    }
  }

  /** 实际的流式下载 + 校验 + 落位。 */
  private async streamDownload(
    asset: UpdateAssetInfo,
    version: string,
    partPath: string,
    finalPath: string,
    controller: AbortController,
  ): Promise<UpdateDownloadResult> {
    let out: fs.WriteStream | null = null;
    try {
      const res = await fetch(asset.url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'otto-desktop-updater' },
      });
      if (!res.ok || !res.body) {
        return { ok: false, error: `下载失败：更新源返回 HTTP ${res.status}` };
      }
      const contentLength = Number(res.headers.get('content-length') ?? '');
      const total =
        Number.isFinite(contentLength) && contentLength > 0 ? contentLength : asset.size;

      out = fs.createWriteStream(partPath);
      const reader = res.body.getReader();
      let transferred = 0;
      let lastPushAt = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        transferred += value.byteLength;
        await writeChunk(out, value);
        const now = Date.now();
        if (now - lastPushAt >= PROGRESS_THROTTLE_MS) {
          lastPushAt = now;
          this.pushProgress(transferred, total);
        }
      }
      await endStream(out);
      out = null;
      // 收尾必推一帧 100%，确保 UI 不停在 9x%。
      this.pushProgress(transferred, Math.max(total, transferred));

      // sha256 校验：唯一完整性防线，不匹配 → verifyOrDeleteFile 删 .part 并报错。
      const verified = await verifyOrDeleteFile(partPath, asset.sha256);
      if (!verified.ok) {
        return { ok: false, error: verified.error };
      }
      // 校验通过才落正式名（覆盖同名旧文件——能走到这里说明旧文件 sha256 不匹配）。
      await fs.promises.rm(finalPath, { force: true });
      await fs.promises.rename(partPath, finalPath);
      this.readyFile = { filePath: finalPath, version };
      return { ok: true, filePath: finalPath, reused: false };
    } catch (e) {
      const cancelled = e instanceof Error && e.name === 'AbortError';
      if (out) {
        await endStream(out).catch(() => undefined);
      }
      await fs.promises.rm(partPath, { force: true }).catch(() => undefined);
      if (cancelled) {
        return { ok: false, cancelled: true, error: '下载已取消' };
      }
      return {
        ok: false,
        error:
          '下载中断（中国大陆直连 GitHub 可能较慢或不通，可重试或配置代理）：' +
          (e instanceof Error ? e.message : String(e)),
      };
    }
  }

  /** 取消进行中的下载（无任务时是安全空操作）。 */
  cancelDownload(): void {
    this.downloading?.controller.abort();
  }

  /**
   * 打开已下载并通过校验的安装包：
   *   win → 拉起 NSIS 安装器（用户按向导装完手动重开）；
   *   mac → 打开 dmg（挂载后用户拖入「应用程序」）。
   */
  async installUpdate(): Promise<UpdateInstallResult> {
    const ready = this.readyFile;
    if (!ready) {
      return { ok: false, message: '还没有校验通过的安装包，请先下载更新' };
    }
    if (!fs.existsSync(ready.filePath)) {
      return { ok: false, message: '安装包文件已不存在（可能被移动或删除），请重新下载' };
    }
    const openError = await shell.openPath(ready.filePath);
    if (openError) {
      return { ok: false, message: `打开安装包失败：${openError}` };
    }
    const message =
      process.platform === 'win32'
        ? '安装器已打开：请按向导完成安装，安装完成后手动重新启动 Otto。'
        : '安装包已打开：请把 Otto 拖入「应用程序」替换旧版本，完成后重新启动 Otto。';
    return { ok: true, message };
  }

  /** 进度推送（窗口可能已销毁，静默跳过）。 */
  private pushProgress(transferred: number, total: number): void {
    const wc = this.getWebContents();
    if (!wc || wc.isDestroyed()) return;
    const progress: UpdateProgressInfo = {
      percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 0,
      transferred,
      total,
    };
    wc.send(this.progressChannel, progress);
  }
}
