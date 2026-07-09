/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 软件更新的 renderer 状态机（App 顶层持有一份，SettingsHubPage 的「软件更新」
 * tab 与 Sidebar 设置入口小圆点共享）。
 *
 * 状态语义（诚实契约）：
 *   - upToDate（已是最新）与 checkFailed（检查失败）是两个不同 phase，
 *     网络不通 / 清单异常一律进 checkFailed，绝不伪装成最新。
 *   - 启动后的静默检查（silentCheck）只在「确认有新版 / 确认最新」时落状态；
 *     检查失败保持沉默（不弹任何东西，也不把面板置为失败态打扰用户），
 *     发现新版仅点亮设置入口的小圆点。
 *
 * reducer 抽成纯函数导出，单测直接测「有新版→下载→完成」等状态流转。
 */

import { useEffect, useMemo, useReducer } from 'react';
import type {
  UpdateAssetInfo,
  UpdateCheckResult,
  UpdateDownloadResult,
  UpdateInstallResult,
  UpdateProgressInfo,
} from '../../preload/index.js';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'upToDate'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'checkFailed'
  | 'downloadFailed';

export interface SoftwareUpdateState {
  /** 当前 app 版本（mount 后从 main 拉取；拉到前为 null，UI 显示占位）。 */
  currentVersion: string | null;
  phase: UpdatePhase;
  latestVersion: string | null;
  /** 新版更新日志（markdown，Prose 渲染）。 */
  notes: string;
  asset: UpdateAssetInfo | null;
  releasePageUrl: string | null;
  progress: UpdateProgressInfo | null;
  /** 校验通过的安装包落盘路径（downloaded 态展示）。 */
  filePath: string | null;
  /** checkFailed / downloadFailed 的诚实原因。 */
  errorMessage: string | null;
  lastCheckedAt: number | null;
  /** 静默检查发现新版 → 设置入口小圆点；用户进过「软件更新」tab 后熄灭。 */
  badgeVisible: boolean;
  /** installUpdate 返回的下一步指引（如「装完请重启 Otto」）。 */
  installMessage: string | null;
}

export const initialUpdateState: SoftwareUpdateState = {
  currentVersion: null,
  phase: 'idle',
  latestVersion: null,
  notes: '',
  asset: null,
  releasePageUrl: null,
  progress: null,
  filePath: null,
  errorMessage: null,
  lastCheckedAt: null,
  badgeVisible: false,
  installMessage: null,
};

export type UpdateAction =
  | { kind: 'version'; version: string }
  | { kind: 'check_start' }
  | { kind: 'check_result'; result: UpdateCheckResult; at: number; silent: boolean }
  | { kind: 'download_start' }
  | { kind: 'download_progress'; progress: UpdateProgressInfo }
  | { kind: 'download_result'; result: UpdateDownloadResult }
  | { kind: 'install_result'; result: UpdateInstallResult }
  | { kind: 'badge_seen' };

export function updateReducer(
  state: SoftwareUpdateState,
  action: UpdateAction,
): SoftwareUpdateState {
  switch (action.kind) {
    case 'version':
      return { ...state, currentVersion: action.version };
    case 'check_start':
      // 下载中不允许被检查打断（面板里检查按钮此时也不可见）。
      if (state.phase === 'downloading') return state;
      return { ...state, phase: 'checking', errorMessage: null, installMessage: null };
    case 'check_result': {
      const r = action.result;
      const base = {
        ...state,
        currentVersion: r.currentVersion,
        lastCheckedAt: action.at,
      };
      switch (r.status) {
        case 'update-available':
          return {
            ...base,
            phase: 'available',
            latestVersion: r.version,
            notes: r.notes,
            asset: r.asset,
            releasePageUrl: r.releasePageUrl,
            progress: null,
            filePath: null,
            errorMessage: null,
            // 小圆点只由静默检查点亮：手动检查时用户本来就看着结果。
            badgeVisible: action.silent ? true : state.badgeVisible,
          };
        case 'up-to-date':
          return {
            ...base,
            phase: 'upToDate',
            latestVersion: r.latestVersion,
            errorMessage: null,
            badgeVisible: false,
          };
        case 'check-failed':
          // 静默检查失败不落状态（不打扰）——hook 层已拦下，这里兜底再拦一次。
          if (action.silent) return state;
          return { ...base, phase: 'checkFailed', errorMessage: r.message };
        default:
          return state;
      }
    }
    case 'download_start':
      if (state.phase === 'downloading') return state;
      return {
        ...state,
        phase: 'downloading',
        progress: null,
        errorMessage: null,
        installMessage: null,
      };
    case 'download_progress':
      // 非下载态的迟到进度帧直接丢弃（取消后可能还有一两帧在路上）。
      if (state.phase !== 'downloading') return state;
      return { ...state, progress: action.progress };
    case 'download_result': {
      const r = action.result;
      if (r.ok) {
        return { ...state, phase: 'downloaded', filePath: r.filePath, progress: null };
      }
      if (r.cancelled) {
        // 用户主动取消：回到「有新版」态，可随时重下，不算失败。
        return { ...state, phase: 'available', progress: null, errorMessage: null };
      }
      return { ...state, phase: 'downloadFailed', progress: null, errorMessage: r.error };
    }
    case 'install_result':
      return { ...state, installMessage: action.result.message };
    case 'badge_seen':
      return state.badgeVisible ? { ...state, badgeVisible: false } : state;
    default:
      return state;
  }
}

export interface SoftwareUpdateActions {
  /** 手动检查：完整展示结果（含失败原因）。 */
  checkNow(): void;
  /** 启动后的静默检查：只在有确定结果时落状态，失败保持沉默。 */
  silentCheck(): void;
  download(): void;
  cancelDownload(): void;
  install(): void;
  /** 资产缺失时跳发布页手动下载（url 缺省用官方发布页）。 */
  openReleasePage(url?: string): void;
  /** 用户看过「软件更新」tab → 熄灭入口小圆点。 */
  markBadgeSeen(): void;
}

export interface UseSoftwareUpdate {
  state: SoftwareUpdateState;
  actions: SoftwareUpdateActions;
}

export function useSoftwareUpdate(): UseSoftwareUpdate {
  const [state, dispatch] = useReducer(updateReducer, initialUpdateState);

  // mount：拉当前版本号 + 订阅下载进度（卸载即退订）。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const version = await window.otto?.appVersion?.();
        if (!cancelled && version) dispatch({ kind: 'version', version });
      } catch {
        // 拿不到版本号不致命，UI 显示占位。
      }
    })();
    const off = window.otto?.onUpdateProgress?.((progress) =>
      dispatch({ kind: 'download_progress', progress }),
    );
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  // actions 用 useMemo 保持引用稳定（App 的 15s 静默检查 effect 依赖它）。
  const actions = useMemo<SoftwareUpdateActions>(() => {
    const runCheck = async (silent: boolean): Promise<void> => {
      if (!silent) dispatch({ kind: 'check_start' });
      let result: UpdateCheckResult;
      try {
        result = await window.otto.updateCheck();
      } catch (e) {
        // IPC 本身挂了也算「检查失败」，同样不许冒充最新。
        result = {
          status: 'check-failed',
          currentVersion: '',
          message: e instanceof Error ? e.message : '检查更新调用失败',
        };
      }
      // 静默检查失败保持沉默（不落状态、不打扰）；其余照实落状态。
      if (silent && result.status === 'check-failed') return;
      dispatch({ kind: 'check_result', result, at: Date.now(), silent });
    };
    return {
      checkNow: () => void runCheck(false),
      silentCheck: () => void runCheck(true),
      download: () => {
        dispatch({ kind: 'download_start' });
        void (async () => {
          let result: UpdateDownloadResult;
          try {
            result = await window.otto.updateDownload();
          } catch (e) {
            result = {
              ok: false,
              error: e instanceof Error ? e.message : '下载调用失败',
            };
          }
          dispatch({ kind: 'download_result', result });
        })();
      },
      cancelDownload: () => void window.otto.updateCancel(),
      install: () => {
        void (async () => {
          try {
            const result = await window.otto.updateInstall();
            dispatch({ kind: 'install_result', result });
          } catch (e) {
            dispatch({
              kind: 'install_result',
              result: {
                ok: false,
                message: e instanceof Error ? e.message : '打开安装包失败',
              },
            });
          }
        })();
      },
      openReleasePage: (url?: string) => {
        // releasePageUrl 由 main 下发（面板传入），这里兜底官方发布页地址。
        void window.otto.openExternal(
          url ?? 'https://github.com/Felix201209/otto-releases/releases/latest',
        );
      },
      markBadgeSeen: () => dispatch({ kind: 'badge_seen' }),
    };
  }, []);

  return { state, actions };
}
