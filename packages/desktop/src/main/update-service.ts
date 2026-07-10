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
 * 清单解析、下载前、以及**重定向后的最终 URL**三重把关——审查 H1）；下载完成必须
 * sha256 校验（无签名时的唯一完整性防线），不匹配删文件报错；写盘有体积硬上限
 * （审查 M1，均见 update-download.ts）；安装（shell.openPath）前对文件**再重验一次**
 * sha256（审查 H2 / TOCTOU：下载校验到点击安装之间文件可能被替换）。
 * 同一时间只允许一个下载任务（单例守护），支持取消；app 退出时 index.ts 的
 * before-quit 会调 cancelDownload() 中止未完成下载并触发 .part 清理（审查 M2）。
 *
 * 已知限制：中国大陆直连 GitHub release 下载可能较慢或超时——失败文案里如实
 * 提示，可重试或配代理，不做静默降级。
 */

import { app, shell } from 'electron';
import type { WebContents } from 'electron';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
import {
  isAllowedAssetUrl,
  parseGithubRelease,
  parseManifest,
  platformAssetKey,
  resolveCheckOutcome,
  type UpdateCheckResult,
} from './update-core.js';
import { computeFileSha256, verifyBeforeInstall } from './update-verify.js';
import { downloadToFile } from './update-download.js';

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
/** fetchJson 带退避重试：attempts 次内成功即返回；全失败返回最后一次结果。 */
async function fetchJsonWithRetry(
  url: string,
  timeoutMs: number,
  attempts: number,
): Promise<FetchJsonResult> {
  let last: FetchJsonResult = { ok: false, error: 'no attempt' };
  for (let i = 0; i < attempts; i++) {
    last = await fetchJson(url, timeoutMs);
    if (last.ok) return last;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  return last;
}

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

export class UpdateService {
  /** 最近一次「有新版」的检查结果（downloadUpdate 只信它，不接受 renderer 传 URL）。 */
  private lastAvailable: Extract<UpdateCheckResult, { status: 'update-available' }> | null =
    null;
  /** 进行中的下载（单例守护：同一时间只允许一个）。 */
  private downloading: { controller: AbortController; partPath: string } | null = null;
  /**
   * 已下载并通过 sha256 校验的安装包。**必须连期望 sha256 一起存**（审查 H2）：
   * installUpdate 打开前要用它对文件重验，防「校验后被替换」的 TOCTOU 窗口。
   */
  private readyFile: { filePath: string; version: string; sha256: string } | null = null;

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

    // 1) 主源：latest.json 直链。GitHub 偶发 5xx/超时（实测撞过 504），
    // 带退避重试三次再降级——降级路径拿不到 sha256 时只能给「打开发布页」，
    // 体验差一截，值得多试几次。
    const primary = await fetchJsonWithRetry(PRIMARY_MANIFEST_URL, CHECK_TIMEOUT_MS, 3);
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
      const manifestRes = await fetchJsonWithRetry(
        release.release.latestJsonUrl,
        CHECK_TIMEOUT_MS,
        2,
      );
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
          this.readyFile = {
            filePath: finalPath,
            version: available.version,
            sha256: asset.sha256,
          };
          return { ok: true, filePath: finalPath, reused: true };
        }
      } catch {
        // 读失败按「需要重新下载」处理。
      }
    }

    // 实际下载走 update-download.ts（无 Electron 依赖、可单测）：
    // 内含 H1 最终 URL 白名单、M1 体积硬上限、sha256 校验 + .part 清理。
    const partPath = finalPath + '.part';
    const controller = new AbortController();
    this.downloading = { controller, partPath };
    try {
      const outcome = await downloadToFile({
        url: asset.url,
        expectedSha256: asset.sha256,
        expectedSize: asset.size,
        partPath,
        finalPath,
        signal: controller.signal,
        onProgress: (transferred, total) => this.pushProgress(transferred, total),
      });
      if (!outcome.ok) {
        return outcome;
      }
      this.readyFile = {
        filePath: outcome.filePath,
        version: available.version,
        sha256: asset.sha256,
      };
      return { ok: true, filePath: outcome.filePath, reused: false };
    } finally {
      this.downloading = null;
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
   * 打开前必对文件**重验 sha256**（审查 H2 / TOCTOU）：下载校验通过到此刻之间
   * Downloads 里的文件可能被替换——不一致就拒绝打开、删文件、要求重新下载。
   */
  async installUpdate(): Promise<UpdateInstallResult> {
    const ready = this.readyFile;
    if (!ready) {
      return { ok: false, message: '还没有校验通过的安装包，请先下载更新' };
    }
    if (!fs.existsSync(ready.filePath)) {
      this.readyFile = null;
      return { ok: false, message: '安装包文件已不存在（可能被移动或删除），请重新下载' };
    }
    const verdict = await verifyBeforeInstall(ready.filePath, ready.sha256);
    if (!verdict.ok) {
      // 文件已不可信（且已被删除），清掉就绪态，逼用户走重新下载。
      this.readyFile = null;
      return { ok: false, message: verdict.message };
    }
    // ── 自动覆盖安装（v1.6.0）：优先全自动，任何一步失败降级为打开安装包手动装 ──

    // Windows：NSIS 静默安装（/S）。--force-run 让装完自动拉起新版；
    // 安装器自带「等待旧进程退出」逻辑（electron-builder 生成的 NSIS 脚本），
    // 因此拉起后立刻退出本进程即可。此路径需 Windows 实机回归（本机为 mac）。
    if (process.platform === 'win32' && ready.filePath.toLowerCase().endsWith('.exe')) {
      try {
        const child = spawn(ready.filePath, ['/S', '--force-run'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        setTimeout(() => app.quit(), 400);
        return { ok: true, message: '正在后台自动安装，安装完成后 Otto 将自动重新启动。' };
      } catch {
        /* 静默安装拉起失败 → 走下方手动兜底 */
      }
    }

    // macOS：挂载 dmg → ditto 覆盖当前 .app → 卸载 → 自动重启。
    // 运行中的 bundle 可被替换（进程握旧 inode），relaunch 后即新版。
    if (process.platform === 'darwin' && ready.filePath.toLowerCase().endsWith('.dmg')) {
      const auto = await this.autoInstallFromDmg(ready.filePath);
      if (auto.ok) {
        // relaunch 在返回后触发，给 renderer 一拍时间收到结果展示提示。
        setTimeout(() => {
          app.relaunch();
          app.exit(0);
        }, 600);
        return { ok: true, message: '更新已安装，Otto 正在自动重启…' };
      }
      // 自动失败不终止：如实告知并降级手动路径。
    }

    const openError = await shell.openPath(ready.filePath);
    if (openError) {
      return { ok: false, message: `打开安装包失败：${openError}` };
    }
    const message =
      process.platform === 'win32'
        ? '安装器已打开：请按向导完成安装，安装完成后手动重新启动 Otto。'
        : '自动安装未成功，已打开安装包：请把 Otto 拖入「应用程序」替换旧版本后重新启动。';
    return { ok: true, message };
  }

  /**
   * mac 全自动安装：hdiutil attach（只读、不弹 Finder）→ 定位卷内唯一 .app →
   * ditto 覆盖当前运行的 bundle → detach。失败返回 ok:false（调用方降级手动）。
   * 安全边界：仅当当前进程确实运行在 .app bundle 内才尝试覆盖（dev 模式直接放弃）。
   */
  private async autoInstallFromDmg(dmgPath: string): Promise<{ ok: boolean; reason?: string }> {
    // 当前 bundle 路径：<X>.app/Contents/MacOS/<bin> → 上三级。
    const bundlePath = path.resolve(app.getPath('exe'), '..', '..', '..');
    if (!bundlePath.endsWith('.app')) {
      return { ok: false, reason: '当前不在 .app bundle 内（开发模式），不做自动覆盖' };
    }
    let mountPoint: string | null = null;
    try {
      const { stdout } = await execFileP('hdiutil', [
        'attach',
        '-nobrowse',
        '-readonly',
        '-plist',
        dmgPath,
      ]);
      // plist 输出里找 mount-point（避免解析空格路径出错，用最朴素的标签扫描）。
      const m = stdout.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/);
      mountPoint = m ? m[1] : null;
      if (!mountPoint) return { ok: false, reason: '无法定位 dmg 挂载点' };

      const apps = fs.readdirSync(mountPoint).filter((f) => f.endsWith('.app'));
      if (apps.length !== 1) {
        return { ok: false, reason: `dmg 内应恰有一个 .app，实际 ${apps.length} 个` };
      }
      const srcApp = path.join(mountPoint, apps[0]);
      // ditto 保留签名/权限/扩展属性；目标是正在运行的 bundle，覆盖是安全的。
      await execFileP('ditto', [srcApp, bundlePath]);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : '自动安装失败' };
    } finally {
      if (mountPoint) {
        try {
          await execFileP('hdiutil', ['detach', mountPoint, '-quiet']);
        } catch {
          /* 卸载失败不影响结果（系统稍后自行回收）*/
        }
      }
    }
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
