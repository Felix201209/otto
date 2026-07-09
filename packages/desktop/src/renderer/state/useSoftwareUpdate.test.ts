/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 软件更新状态机（updateReducer 纯函数）单测。
 *
 * 核心契约：
 *   - 「有新版 → 下载 → 完成」的正向流转；
 *   - 「检查失败」与「已是最新」是两个不同 phase（严禁把失败伪装成最新）；
 *   - sha256 校验失败走 downloadFailed（错误原样透传）；
 *   - 静默检查只在发现新版时点亮小圆点，失败不落状态。
 */

import { describe, it, expect } from 'vitest';
import {
  updateReducer,
  initialUpdateState,
  type SoftwareUpdateState,
  type UpdateAction,
} from './useSoftwareUpdate.js';
import type { UpdateCheckResult } from '../../preload/index.js';

const AVAILABLE: UpdateCheckResult = {
  status: 'update-available',
  currentVersion: '1.4.0',
  version: '1.4.1',
  notes: '## 更新\n- 更快',
  publishedAt: '2026-07-08T18:00:00Z',
  asset: {
    name: 'Otto-1.4.1-arm64.dmg',
    url: 'https://github.com/Felix201209/otto-releases/releases/download/v1.4.1/Otto-1.4.1-arm64.dmg',
    size: 136314880,
    sha256: 'a'.repeat(64),
  },
  releasePageUrl: 'https://github.com/Felix201209/otto-releases/releases/latest',
};

function run(actions: UpdateAction[], from = initialUpdateState): SoftwareUpdateState {
  return actions.reduce(updateReducer, from);
}

describe('updateReducer：检查', () => {
  it('check_start → checking，清掉旧错误', () => {
    const s = run([
      { kind: 'check_result', result: { status: 'check-failed', currentVersion: '1.4.0', message: 'x' }, at: 1, silent: false },
      { kind: 'check_start' },
    ]);
    expect(s.phase).toBe('checking');
    expect(s.errorMessage).toBeNull();
  });

  it('已是最新 → upToDate（记录最新版本号，小圆点熄灭）', () => {
    const s = run([
      { kind: 'check_start' },
      {
        kind: 'check_result',
        result: { status: 'up-to-date', currentVersion: '1.4.1', latestVersion: '1.4.1' },
        at: 100,
        silent: false,
      },
    ]);
    expect(s.phase).toBe('upToDate');
    expect(s.latestVersion).toBe('1.4.1');
    expect(s.lastCheckedAt).toBe(100);
    expect(s.badgeVisible).toBe(false);
  });

  it('检查失败 → checkFailed，与 upToDate 是不同 phase（诚实契约）', () => {
    const s = run([
      { kind: 'check_start' },
      {
        kind: 'check_result',
        result: { status: 'check-failed', currentVersion: '1.4.0', message: '网络请求失败，无法连接 GitHub' },
        at: 100,
        silent: false,
      },
    ]);
    expect(s.phase).toBe('checkFailed');
    expect(s.phase).not.toBe('upToDate');
    expect(s.errorMessage).toContain('网络请求失败');
  });

  it('静默检查：发现新版点亮小圆点；手动检查不点', () => {
    const silent = run([{ kind: 'check_result', result: AVAILABLE, at: 1, silent: true }]);
    expect(silent.phase).toBe('available');
    expect(silent.badgeVisible).toBe(true);

    const manual = run([{ kind: 'check_result', result: AVAILABLE, at: 1, silent: false }]);
    expect(manual.badgeVisible).toBe(false);

    // 静默失败：状态原样不动（reducer 层兜底；hook 层根本不派发）。
    const silentFail = run([
      {
        kind: 'check_result',
        result: { status: 'check-failed', currentVersion: '1.4.0', message: 'x' },
        at: 1,
        silent: true,
      },
    ]);
    expect(silentFail).toEqual(initialUpdateState);
  });

  it('badge_seen 熄灭小圆点', () => {
    const s = run([
      { kind: 'check_result', result: AVAILABLE, at: 1, silent: true },
      { kind: 'badge_seen' },
    ]);
    expect(s.badgeVisible).toBe(false);
  });
});

describe('updateReducer：有新版 → 下载 → 完成 的状态流转', () => {
  it('完整正向链路：available → downloading（进度推进）→ downloaded', () => {
    let s = run([{ kind: 'check_result', result: AVAILABLE, at: 1, silent: false }]);
    expect(s.phase).toBe('available');
    expect(s.asset?.name).toBe('Otto-1.4.1-arm64.dmg');
    expect(s.notes).toContain('更快');

    s = updateReducer(s, { kind: 'download_start' });
    expect(s.phase).toBe('downloading');

    s = updateReducer(s, {
      kind: 'download_progress',
      progress: { percent: 42, transferred: 57000000, total: 136314880 },
    });
    expect(s.progress?.percent).toBe(42);

    s = updateReducer(s, {
      kind: 'download_result',
      result: { ok: true, filePath: '/Users/x/Downloads/Otto-1.4.1-arm64.dmg', reused: false },
    });
    expect(s.phase).toBe('downloaded');
    expect(s.filePath).toBe('/Users/x/Downloads/Otto-1.4.1-arm64.dmg');
    expect(s.progress).toBeNull();
  });

  it('取消下载 → 回到 available（不算失败，可重下）', () => {
    const s = run([
      { kind: 'check_result', result: AVAILABLE, at: 1, silent: false },
      { kind: 'download_start' },
      { kind: 'download_result', result: { ok: false, cancelled: true, error: '下载已取消' } },
    ]);
    expect(s.phase).toBe('available');
    expect(s.errorMessage).toBeNull();
  });

  it('下载失败（含 sha256 校验不通过）→ downloadFailed，错误原样透传', () => {
    const s = run([
      { kind: 'check_result', result: AVAILABLE, at: 1, silent: false },
      { kind: 'download_start' },
      {
        kind: 'download_result',
        result: { ok: false, error: '安装包 sha256 校验不通过（…），已删除下载文件，请重新下载' },
      },
    ]);
    expect(s.phase).toBe('downloadFailed');
    expect(s.errorMessage).toContain('sha256 校验不通过');
  });

  it('非下载态的迟到进度帧被丢弃；下载中检查请求被忽略', () => {
    const done = run([
      { kind: 'check_result', result: AVAILABLE, at: 1, silent: false },
      { kind: 'download_start' },
      { kind: 'download_result', result: { ok: true, filePath: '/p', reused: true } },
      { kind: 'download_progress', progress: { percent: 99, transferred: 1, total: 2 } },
    ]);
    expect(done.phase).toBe('downloaded');
    expect(done.progress).toBeNull();

    const downloading = run([
      { kind: 'check_result', result: AVAILABLE, at: 1, silent: false },
      { kind: 'download_start' },
      { kind: 'check_start' },
    ]);
    expect(downloading.phase).toBe('downloading');
  });

  it('install_result 落安装指引文案', () => {
    const s = run([
      { kind: 'check_result', result: AVAILABLE, at: 1, silent: false },
      { kind: 'download_start' },
      { kind: 'download_result', result: { ok: true, filePath: '/p.dmg', reused: false } },
      {
        kind: 'install_result',
        result: { ok: true, message: '安装包已打开：请把 Otto 拖入「应用程序」…' },
      },
    ]);
    expect(s.installMessage).toContain('安装包已打开');
  });
});
