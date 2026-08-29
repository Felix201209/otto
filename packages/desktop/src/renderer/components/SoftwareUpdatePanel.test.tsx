/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 「软件更新」面板集成测试：真实 useSoftwareUpdate hook + 面板组件，
 * window.otto 桥全程 mock（fetch/IPC 不真发）。
 *
 * 覆盖 UI 状态机主链路：
 *   有新版（含更新日志渲染）→ 下载（进度）→ 完成（打开安装包 + 指引）；
 *   以及「检查失败 ≠ 已是最新」的两种可区分 UI 状态（诚实契约）。
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen, act } from '@testing-library/react';
import { SoftwareUpdatePanel, installHintForFile } from './SoftwareUpdatePanel.js';
import { useSoftwareUpdate } from '../state/useSoftwareUpdate.js';
import type {
  UpdateCheckResult,
  UpdateDownloadResult,
  UpdateProgressInfo,
} from '../../preload/index.js';

const AVAILABLE: UpdateCheckResult = {
  status: 'update-available',
  currentVersion: '1.4.0',
  version: '1.4.1',
  notes: '## 更新日志\n- 支持软件内更新',
  publishedAt: '2026-07-08T18:00:00Z',
  asset: {
    name: 'Otto-1.4.1-arm64.dmg',
    url: 'https://github.com/Felix201209/otto-releases/releases/download/v1.4.1/Otto-1.4.1-arm64.dmg',
    size: 136314880,
    sha256: 'a'.repeat(64),
  },
  releasePageUrl: 'https://github.com/Felix201209/otto-releases/releases/latest',
};

/** 手动裁决的 Promise（把下载停在「进行中」，测完进度再放行）。 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 捕获进度订阅回调，供测试手动推进度帧。 */
let progressHandler: ((p: UpdateProgressInfo) => void) | null = null;

function installOttoMock(over: Partial<Record<string, unknown>> = {}): void {
  progressHandler = null;
  const mock = {
    appVersion: vi.fn(async () => '1.4.0'),
    updateCheck: vi.fn(async () => AVAILABLE),
    updateDownload: vi.fn(
      async (): Promise<UpdateDownloadResult> => ({
        ok: true,
        filePath: '/Users/felix/Downloads/Otto-1.4.1-arm64.dmg',
        reused: false,
      }),
    ),
    updateCancel: vi.fn(async () => undefined),
    updateInstall: vi.fn(async () => ({
      ok: true,
      message: '安装包已打开：完成后请重新启动 Otto。',
    })),
    onUpdateProgress: vi.fn((h: (p: UpdateProgressInfo) => void) => {
      progressHandler = h;
      return () => {
        progressHandler = null;
      };
    }),
    openExternal: vi.fn(async () => undefined),
    ...over,
  };
  window.otto = mock as unknown as Window['otto'];
}

/** 真实 hook + 面板的最小挂载壳。 */
function Harness(): React.JSX.Element {
  const update = useSoftwareUpdate();
  return <SoftwareUpdatePanel update={update} />;
}

beforeEach(() => {
  installOttoMock();
});

describe('SoftwareUpdatePanel：有新版 → 下载 → 完成', () => {
  it('完整链路：检查出新版（日志渲染）→ 下载出进度 → 校验通过后可打开安装包', async () => {
    const download = deferred<UpdateDownloadResult>();
    installOttoMock({ updateDownload: vi.fn(() => download.promise) });
    render(<Harness />);

    // 常态：当前版本 + 检查按钮。
    expect(await screen.findByText(/v1\.4\.0/)).toBeTruthy();
    fireEvent.click(screen.getByText('检查更新'));

    // 有新版：版本号 + markdown 更新日志（Prose 渲染成列表，非源码文本）。
    expect(await screen.findByText(/发现新版本 v1\.4\.1/)).toBeTruthy();
    expect(screen.getByText('支持软件内更新')).toBeTruthy();

    // 下载中：进度条 + MB 计数 + 取消按钮。
    fireEvent.click(screen.getByText(/下载更新/));
    expect(await screen.findByText(/正在下载 v1\.4\.1/)).toBeTruthy();
    act(() => {
      progressHandler?.({ percent: 42, transferred: 57262080, total: 136314880 });
    });
    expect(screen.getByText(/42% · 54\.6 \/ 130\.0 MB/)).toBeTruthy();
    expect(screen.getByText('取消下载')).toBeTruthy();

    // 完成：sha256 校验通过 → 立即安装 + mac 指引。
    await act(async () => {
      download.resolve({
        ok: true,
        filePath: '/Users/felix/Downloads/Otto-1.4.1-arm64.dmg',
        reused: false,
      });
    });
    expect(await screen.findByText(/安装包已就绪（sha256 校验通过）/)).toBeTruthy();
    expect(screen.getByText(/自动完成安装并重启/)).toBeTruthy();

    fireEvent.click(screen.getByText('立即安装并重启'));
    expect(await screen.findByText(/完成后请重新启动 Otto/)).toBeTruthy();
  });

  it('sha256 校验失败：先给应用内重试，再提供发布页作最后兜底', async () => {
    installOttoMock({
      updateDownload: vi.fn(async (): Promise<UpdateDownloadResult> => ({
        ok: false,
        error: '安装包 sha256 校验不通过（期望 aaaa…，实际 bbbb…），已删除下载文件，请重新下载',
      })),
    });
    render(<Harness />);
    fireEvent.click(await screen.findByText('检查更新'));
    fireEvent.click(await screen.findByText(/下载更新/));
    expect(await screen.findByText('下载失败')).toBeTruthy();
    expect(screen.getByText(/sha256 校验不通过/)).toBeTruthy();
    expect(screen.getByText('重试下载')).toBeTruthy();
    fireEvent.click(screen.getByText('手动下载'));
    expect(
      (window.otto.openExternal as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toContain('otto-releases/releases/latest');
  });
});

describe('SoftwareUpdatePanel：检查失败 ≠ 已是最新（诚实契约）', () => {
  it('检查失败：诚实显示原因 + 重试，绝不显示「已是最新」', async () => {
    installOttoMock({
      updateCheck: vi.fn(async (): Promise<UpdateCheckResult> => ({
        status: 'check-failed',
        currentVersion: '1.4.0',
        message: '网络请求失败，无法连接 GitHub（中国大陆直连可能较慢或不通，可稍后重试或配置代理）',
      })),
    });
    render(<Harness />);
    fireEvent.click(await screen.findByText('检查更新'));
    expect(await screen.findByText('检查更新失败')).toBeTruthy();
    expect(screen.getByText(/无法连接 GitHub/)).toBeTruthy();
    expect(screen.getByText('重试')).toBeTruthy();
    expect(screen.queryByText(/已是最新/)).toBeNull();
    fireEvent.click(screen.getByText('前往发布页'));
    expect(
      (window.otto.openExternal as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toContain('NSIETeam/otto-new/releases/latest');
  });

  it('已是最新：明确显示最新版本号，绝不出现失败文案', async () => {
    installOttoMock({
      updateCheck: vi.fn(async (): Promise<UpdateCheckResult> => ({
        status: 'up-to-date',
        currentVersion: '1.4.0',
        latestVersion: '1.4.0',
      })),
    });
    render(<Harness />);
    fireEvent.click(await screen.findByText('检查更新'));
    expect(await screen.findByText('已是最新版本')).toBeTruthy();
    expect(screen.getByText(/最新发布版本 v1\.4\.0/)).toBeTruthy();
    expect(screen.queryByText(/检查更新失败/)).toBeNull();
  });

  it('清单没有本平台资产：仍报新版但引导发布页手动下载', async () => {
    installOttoMock({
      updateCheck: vi.fn(async (): Promise<UpdateCheckResult> => ({
        ...AVAILABLE,
        asset: null,
      })),
    });
    render(<Harness />);
    fireEvent.click(await screen.findByText('检查更新'));
    expect(await screen.findByText(/发现新版本 v1\.4\.1/)).toBeTruthy();
    expect(screen.queryByText(/下载更新/)).toBeNull();
    fireEvent.click(screen.getByText('打开发布页'));
    expect(
      (window.otto.openExternal as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toContain('otto-releases/releases/latest');
  });
});

describe('installHintForFile：按安装包类型给平台指引', () => {
  it('.exe → NSIS 向导指引；.dmg → 拖入应用程序指引；未知 → 通用指引', () => {
    expect(installHintForFile('C:\\Users\\f\\Downloads\\Otto-Setup.exe')).toContain('静默安装');
    expect(installHintForFile('/Users/f/Downloads/Otto.dmg')).toContain('自动完成安装');
    expect(installHintForFile(null)).toContain('重新启动 Otto');
  });
});
