/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { launchGoalMode } from './launchGoalMode.js';
import { ApprovalMode } from 'otto-core';
import type { GoalWizardResult } from '../components/GoalWizard.js';

/**
 * launchGoalMode — UI 无关的"启动目标驱动模式"共享内核。
 *
 * 抽取自 useGoalWizard.handleGoalWizardComplete，供 TUI 与飞书共用，避免逻辑漂移。
 * 职责（且仅此）：
 *   1) 若非 YOLO，开启 YOLO（setApprovalModeWithProjectSync）
 *   2) buildGoalPrompt(result) 组装目标 prompt
 *   3) client.setGoalContext(...) 注册压缩抗性上下文（T0 在此刻捕获）
 *   4) 返回 { prompt, yoloWasEnabled } 交给调用方各自的 submit 通道
 *
 * 不碰任何 UI（addItem/submitQuery 由调用方负责）。
 */

const makeResult = (over: Partial<GoalWizardResult> = {}): GoalWizardResult => ({
  task: '把测试覆盖率提到 90%',
  forbidden: '不要改 public API',
  criteria: '所有测试通过且覆盖率 >= 90%',
  hours: 2,
  intensity: 'standard',
  ...over,
});

describe('launchGoalMode', () => {
  let setGoalContext: ReturnType<typeof vi.fn>;
  let setApprovalModeWithProjectSync: ReturnType<typeof vi.fn>;
  let getApprovalMode: ReturnType<typeof vi.fn>;
  let client: { setGoalContext: typeof setGoalContext };
  let config: any;

  beforeEach(() => {
    setGoalContext = vi.fn();
    setApprovalModeWithProjectSync = vi.fn();
    getApprovalMode = vi.fn(() => ApprovalMode.DEFAULT);
    client = { setGoalContext };
    config = {
      getApprovalMode,
      setApprovalModeWithProjectSync,
      getGeminiClient: vi.fn(() => client),
    };
  });

  it('returns a non-empty assembled prompt containing the task', () => {
    const result = makeResult({ task: '独特任务标记XYZ' });
    const out = launchGoalMode(config, result);
    expect(out.prompt).toBeTruthy();
    expect(out.prompt).toContain('独特任务标记XYZ');
  });

  it('enables YOLO when not already in YOLO mode', () => {
    getApprovalMode.mockReturnValue(ApprovalMode.DEFAULT);
    const out = launchGoalMode(config, makeResult());
    expect(setApprovalModeWithProjectSync).toHaveBeenCalledWith(
      ApprovalMode.YOLO,
      true,
    );
    expect(out.yoloWasEnabled).toBe(true);
  });

  it('does NOT re-enable YOLO when already in YOLO mode', () => {
    getApprovalMode.mockReturnValue(ApprovalMode.YOLO);
    const out = launchGoalMode(config, makeResult());
    expect(setApprovalModeWithProjectSync).not.toHaveBeenCalled();
    expect(out.yoloWasEnabled).toBe(false);
  });

  it('registers goal context with the assembled prompt, hours and task', () => {
    const result = makeResult({ hours: 5, task: '任务A' });
    const out = launchGoalMode(config, result);
    expect(setGoalContext).toHaveBeenCalledTimes(1);
    const ctx = setGoalContext.mock.calls[0][0];
    expect(ctx.originalPrompt).toBe(out.prompt);
    expect(ctx.hours).toBe(5);
    expect(ctx.task).toBe('任务A');
    expect(typeof ctx.startedAt).toBe('number');
  });

  it('still returns prompt even if setGoalContext throws (resilience optional)', () => {
    setGoalContext.mockImplementation(() => {
      throw new Error('client not ready');
    });
    const out = launchGoalMode(config, makeResult());
    expect(out.prompt).toBeTruthy();
  });

  it('propagates YOLO enable failure as a thrown error', () => {
    setApprovalModeWithProjectSync.mockImplementation(() => {
      throw new Error('cannot set mode');
    });
    expect(() => launchGoalMode(config, makeResult())).toThrow('cannot set mode');
  });

  it('does not throw if getGeminiClient returns null', () => {
    config.getGeminiClient = vi.fn(() => null);
    const out = launchGoalMode(config, makeResult());
    expect(out.prompt).toBeTruthy();
    expect(setGoalContext).not.toHaveBeenCalled();
  });
});
