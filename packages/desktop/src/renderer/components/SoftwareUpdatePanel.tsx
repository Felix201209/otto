/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 「软件更新」面板（SettingsHubPage 的 update tab 内容）。
 * 状态与动作来自 useSoftwareUpdate（App 顶层持有），本组件纯展示 + 转发点击。
 *
 * UI 状态一一对应状态机 phase：
 *   idle/checking      当前版本 + 检查按钮
 *   upToDate           ✅ 已是最新（与「检查失败」严格是两种状态）
 *   checkFailed        诚实显示失败原因 + 重试
 *   available          新版本号 + 更新日志（Prose 渲染 markdown）+ 下载
 *   downloading        进度条（percent + MB/total）+ 取消
 *   downloaded         打开安装包 + mac/win 各自的安装指引
 *   downloadFailed     失败原因 + 重试下载
 */

import React from 'react';
import type { UseSoftwareUpdate } from '../state/useSoftwareUpdate.js';
import { Prose } from './Prose.js';

/** 字节 → MB 显示（一位小数，进度与体积统一口径）。 */
function toMb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

function formatCheckedAt(ts: number | null): string | null {
  if (ts == null) return null;
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 按安装包扩展名给对应平台的安装指引（renderer 不直接感知 process.platform）。 */
export function installHintForFile(filePath: string | null): string {
  if (filePath?.toLowerCase().endsWith('.exe')) {
    return '点击后将后台静默安装并自动重启 Otto（若未自动完成，请按安装向导手动装完）。';
  }
  if (filePath?.toLowerCase().endsWith('.dmg')) {
    return '点击后将自动完成安装并重启 Otto（若自动安装失败，会打开安装包供手动替换）。';
  }
  return '打开安装包完成安装后，请重新启动 Otto。';
}

export function SoftwareUpdatePanel({
  update,
}: {
  update: UseSoftwareUpdate;
}): React.JSX.Element {
  const { state, actions } = update;
  const checkedAt = formatCheckedAt(state.lastCheckedAt);

  return (
    <div className="otto-hub__section">
      {/* 当前版本 + 检查入口（常态区，任何 phase 都在）。 */}
      <div className="otto-hub__field">
        <div className="otto-hub__field-label">当前版本</div>
        <div className="otto-hub__field-hint">
          Otto 桌面版 v{state.currentVersion ?? '…'}
          {checkedAt ? ` · 上次检查 ${checkedAt}` : ''}
        </div>
        {state.phase !== 'downloading' && state.phase !== 'downloaded' ? (
          <div className="otto-hub__toolbar">
            <button
              type="button"
              className="otto-hub__btn"
              onClick={actions.checkNow}
              disabled={state.phase === 'checking'}
            >
              {state.phase === 'checking' ? '检查中…' : '检查更新'}
            </button>
          </div>
        ) : null}
      </div>

      {/* 已是最新：与「检查失败」是两种不同状态，绝不混用。 */}
      {state.phase === 'upToDate' ? (
        <div className="otto-hub__field">
          <div className="otto-hub__field-label">✅ 已是最新版本</div>
          <div className="otto-hub__field-hint">
            {state.latestVersion
              ? `最新发布版本 v${state.latestVersion}，无需更新。`
              : '当前已是最新，无需更新。'}
          </div>
        </div>
      ) : null}

      {/* 检查失败：诚实报原因（网络不通 / 清单异常），给重试。 */}
      {state.phase === 'checkFailed' ? (
        <div className="otto-hub__field" role="alert">
          <div className="otto-hub__field-label">检查更新失败</div>
          <div className="otto-hub__field-hint">{state.errorMessage}</div>
          <div className="otto-hub__toolbar">
            <button
              type="button"
              className="otto-hub__btn otto-hub__btn--primary"
              onClick={actions.checkNow}
            >
              重试
            </button>
          </div>
        </div>
      ) : null}

      {/* 有新版：版本号 + 更新日志 + 下载（或发布页兜底）。 */}
      {state.phase === 'available' ? (
        <div className="otto-hub__field">
          <div className="otto-hub__field-label">
            🆕 发现新版本 v{state.latestVersion}
          </div>
          {state.notes ? (
            <div className="otto-update__notes">
              <Prose text={state.notes} />
            </div>
          ) : null}
          {state.asset ? (
            <div className="otto-hub__toolbar">
              <button
                type="button"
                className="otto-hub__btn otto-hub__btn--primary"
                onClick={actions.download}
              >
                下载更新（{toMb(state.asset.size)} MB）
              </button>
            </div>
          ) : (
            <>
              <div className="otto-hub__field-hint">
                这次发布没有当前平台可校验的安装包，可到发布页手动下载。
              </div>
              <div className="otto-hub__toolbar">
                <button
                  type="button"
                  className="otto-hub__btn otto-hub__btn--primary"
                  onClick={() =>
                    actions.openReleasePage(state.releasePageUrl ?? undefined)
                  }
                >
                  打开发布页
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* 下载中：进度条 + MB 计数 + 取消。 */}
      {state.phase === 'downloading' ? (
        <div className="otto-hub__field">
          <div className="otto-hub__field-label">
            正在下载 v{state.latestVersion} …
          </div>
          <div className="otto-hub__ctx-bar">
            <div
              className="otto-hub__ctx-bar-fill"
              style={{ width: `${Math.round(state.progress?.percent ?? 0)}%` }}
            />
          </div>
          <div className="otto-hub__field-hint">
            {state.progress
              ? `${Math.round(state.progress.percent)}% · ${toMb(state.progress.transferred)} / ${toMb(state.progress.total)} MB`
              : '正在建立连接…'}
          </div>
          <div className="otto-hub__toolbar">
            <button
              type="button"
              className="otto-hub__btn"
              onClick={actions.cancelDownload}
            >
              取消下载
            </button>
          </div>
        </div>
      ) : null}

      {/* 下载完成（sha256 已校验通过）：打开安装包 + 平台指引。 */}
      {state.phase === 'downloaded' ? (
        <div className="otto-hub__field">
          <div className="otto-hub__field-label">
            ✅ v{state.latestVersion} 安装包已就绪（sha256 校验通过）
          </div>
          <div className="otto-hub__field-hint">{state.filePath}</div>
          <div className="otto-hub__field-hint">
            {installHintForFile(state.filePath)}
          </div>
          <div className="otto-hub__toolbar">
            <button
              type="button"
              className="otto-hub__btn otto-hub__btn--primary"
              onClick={actions.install}
            >立即安装并重启</button>
          </div>
          {state.installMessage ? (
            <div className="otto-hub__field-hint" role="status">
              {state.installMessage}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 下载失败（含 sha256 校验不通过，文件已被删除）：诚实报原因 + 重试。 */}
      {state.phase === 'downloadFailed' ? (
        <div className="otto-hub__field" role="alert">
          <div className="otto-hub__field-label">下载失败</div>
          <div className="otto-hub__field-hint">{state.errorMessage}</div>
          <div className="otto-hub__toolbar">
            <button
              type="button"
              className="otto-hub__btn otto-hub__btn--primary"
              onClick={actions.download}
            >
              重试下载
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
