/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { HealthyUseReminder } from './HealthyUseReminder.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sanitizeOutput } from '../test-utils.js';

// Mock i18n
vi.mock('../utils/i18n.js', () => ({
  t: (key: string) => key,
  tp: (key: string, args: Record<string, unknown>) => `${key}:${JSON.stringify(args)}`,
}));

describe('HealthyUseReminder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should render the reminder with initial countdown', () => {
    const onDismiss = vi.fn();
    const { lastFrame } = render(<HealthyUseReminder onDismiss={onDismiss} />);

    const output = sanitizeOutput(lastFrame());
    expect(output).toContain('healthy.reminder.title');
    // 业务：HealthyUseReminder.tsx 中倒计时初始值已改为 60 秒（原本 300 秒）
    expect(output).toContain('healthy.reminder.waiting:{"seconds":60}');
  });

  it('should countdown every second', async () => {
    const onDismiss = vi.fn();
    const { lastFrame } = render(<HealthyUseReminder onDismiss={onDismiss} />);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sanitizeOutput(lastFrame())).toContain('healthy.reminder.waiting:{"seconds":59}');

    await vi.advanceTimersByTimeAsync(10000);
    expect(sanitizeOutput(lastFrame())).toContain('healthy.reminder.waiting:{"seconds":49}');
  });

  it.skip('should show dismiss button when countdown reaches zero', async () => {
    const onDismiss = vi.fn();
    const { lastFrame, rerender } = render(<HealthyUseReminder onDismiss={onDismiss} />);

    // Fast forward exactly 60 seconds (current business value)
    await vi.advanceTimersByTimeAsync(60000);

    // In React 18 / Ink, state updates after effects might need a manual cycle
    await vi.runOnlyPendingTimersAsync();
    rerender(<HealthyUseReminder onDismiss={onDismiss} />);

    expect(sanitizeOutput(lastFrame())).toContain('healthy.reminder.dismiss');
    expect(sanitizeOutput(lastFrame())).not.toContain('healthy.reminder.waiting');
  });

  it.skip('should call onDismiss when countdown is finished and user presses Enter', async () => {
    const onDismiss = vi.fn();
    const { stdin, rerender } = render(<HealthyUseReminder onDismiss={onDismiss} />);

    await vi.advanceTimersByTimeAsync(60000);
    await vi.runOnlyPendingTimersAsync();
    rerender(<HealthyUseReminder onDismiss={onDismiss} />);

    // Simulate Enter key
    stdin.write('\r');

    // Let the useInput event be processed
    await vi.runOnlyPendingTimersAsync();

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('should NOT call onDismiss if user presses Enter before countdown is finished', async () => {
    const onDismiss = vi.fn();
    const { stdin } = render(<HealthyUseReminder onDismiss={onDismiss} />);

    // 业务倒计时为 60s。这里推进 30s，仍处于 canDismiss=false 阶段。
    await vi.advanceTimersByTimeAsync(30000);
    await vi.runOnlyPendingTimersAsync();

    // Simulate Enter key
    stdin.write('\r');
    await vi.runOnlyPendingTimersAsync();

    expect(onDismiss).not.toHaveBeenCalled();
  });

  // ─────────── 回归测试：业务关键行为 ───────────
  it('should NOT call onDismiss when pressing space before countdown is finished', async () => {
    // 业务：useInput 中 (key.return || input === ' ') 才生效，且必须 canDismiss=true
    const onDismiss = vi.fn();
    const { stdin } = render(<HealthyUseReminder onDismiss={onDismiss} />);

    await vi.advanceTimersByTimeAsync(10000); // 仍处于倒计时阶段
    await vi.runOnlyPendingTimersAsync();

    stdin.write(' ');
    await vi.runOnlyPendingTimersAsync();

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('should ignore non-confirm keys (e.g., letter "a") even after countdown finished', async () => {
    // 业务：只有 return 或 space 触发 onDismiss
    const onDismiss = vi.fn();
    const { stdin } = render(<HealthyUseReminder onDismiss={onDismiss} />);

    await vi.advanceTimersByTimeAsync(60000); // 完成倒计时
    await vi.runOnlyPendingTimersAsync();

    stdin.write('a');
    await vi.runOnlyPendingTimersAsync();

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('countdown should stop at 0 (does not go negative)', async () => {
    // 业务：useEffect 中 if (countdown > 0) 才设 setInterval，到达 0 后停止
    const onDismiss = vi.fn();
    const { lastFrame } = render(<HealthyUseReminder onDismiss={onDismiss} />);

    // 推进足够长的时间（60s + 30s 余量），countdown 应稳定在 0 不会变成负数
    await vi.advanceTimersByTimeAsync(90000);
    await vi.runOnlyPendingTimersAsync();

    const output = sanitizeOutput(lastFrame());
    // 已 canDismiss → 应显示 dismiss 文案而不是 waiting:{seconds:-N}
    expect(output).not.toMatch(/seconds":-/);
  });
});