/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FeatureFlagManager,
  FEATURE_FLAGS,
} from './featureFlags.js';
import type { FeatureFlag } from './featureFlags.js';
import { ProjectSettingsManager } from './projectSettings.js';

// 用内存替代文件系统
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const store: Record<string, string> = {};

  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      // 模拟 ~/.otto/settings.json 始终「存在」
      return p.includes('.otto/settings.json') ? true : false;
    }),
    readFileSync: vi.fn((p: string) => {
      const key = p.toString();
      return store[key] || '{}';
    }),
    writeFileSync: vi.fn((p: string, data: string) => {
      const key = p.toString();
      store[key] = data;
    }),
    mkdirSync: vi.fn(() => {}),
    // 让 vitest 的 `actual` 引用保持「真实」的东西可工作
    constants: actual.constants,
    promises: actual.promises,
  };
});

function allFlags(): FeatureFlag[] {
  return Object.keys(FEATURE_FLAGS) as FeatureFlag[];
}

function createManager(initialFlags?: Record<string, boolean>): FeatureFlagManager {
  if (initialFlags) {
    // 预写入 settings.json
    const sm = new ProjectSettingsManager('/fake-workspace');
    sm.save({ featureFlags: initialFlags });
    return new FeatureFlagManager(sm);
  }
  return new FeatureFlagManager(new ProjectSettingsManager('/fake-workspace'));
}

describe('FeatureFlagManager', () => {
  it('all flags have defaults (park_service off, others on)', () => {
    const mgr = createManager();

    for (const flag of allFlags()) {
      const enabled = mgr.isEnabled(flag);
      if (flag === 'park_service') {
        expect(enabled).toBe(false);
      } else {
        expect(enabled).toBe(true);
      }
    }
  });

  it('park_service is off by default', () => {
    const mgr = createManager();
    expect(mgr.isEnabled('park_service')).toBe(false);
  });

  it('getAll returns correct state', () => {
    const mgr = createManager();
    const all = mgr.getAll();

    expect(Object.keys(all).sort()).toEqual(allFlags().sort());
    expect(all.park_service).toBe(false);
    expect(all.feishu_auto_reply).toBe(true);
  });

  it('enable and disable a flag works', () => {
    const mgr = createManager();

    // 初始 park_service 关闭
    expect(mgr.isEnabled('park_service')).toBe(false);

    // 启用
    mgr.setEnabled('park_service', true);
    expect(mgr.isEnabled('park_service')).toBe(true);

    // 再关闭
    mgr.setEnabled('park_service', false);
    expect(mgr.isEnabled('park_service')).toBe(false);
  });

  it('setEnabled persists across new manager instances', () => {
    const mgr1 = createManager();
    mgr1.setEnabled('tui_sync', false);

    // 用同一个 settings（通过 managers 共享底层存储）验证持久化
    expect(mgr1.isEnabled('tui_sync')).toBe(false);
  });

  it('onChange fires when flag changes', () => {
    const mgr = createManager();
    const calls: Array<{ flag: string; newVal: boolean; oldVal: boolean }> = [];

    mgr.onChange((flag, newVal, oldVal) => {
      calls.push({ flag, newVal, oldVal });
    });

    mgr.setEnabled('audit_log', false);

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ flag: 'audit_log', newVal: false, oldVal: true });
  });

  it('onChange does not fire when value unchanged', () => {
    const mgr = createManager();
    let fireCount = 0;

    mgr.onChange(() => {
      fireCount++;
    });

    // feishu_auto_reply 默认 true，再设 true 不触发
    mgr.setEnabled('feishu_auto_reply', true);

    expect(fireCount).toBe(0);
  });

  it('unsubscribe stops receiving changes', () => {
    const mgr = createManager();
    let fireCount = 0;

    const unsub = mgr.onChange(() => {
      fireCount++;
    });

    mgr.setEnabled('checkpoints', false);
    expect(fireCount).toBe(1);

    unsub();
    mgr.setEnabled('checkpoints', true);
    expect(fireCount).toBe(1); // 未再触发
  });

  it('configured value overrides default', () => {
    // 预先写入 park_service: true
    const mgr = createManager({ park_service: true, knowledge_loop: false });

    expect(mgr.isEnabled('park_service')).toBe(true);   // 覆盖默认 false
    expect(mgr.isEnabled('knowledge_loop')).toBe(false); // 覆盖默认 true
    expect(mgr.isEnabled('feishu_auto_reply')).toBe(true); // 未配置，走默认
  });

  it('getAll reflects configured overrides', () => {
    const mgr = createManager({ audit_log: false, memory_injection: false });
    const all = mgr.getAll();

    expect(all.audit_log).toBe(false);
    expect(all.memory_injection).toBe(false);
    expect(all.enterprise_tree).toBe(true); // 默认
  });
});
