/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import { DesktopAutomationTool } from './desktop-automation.js';
import type { DesktopAutomationToolParams } from './desktop-automation.js';
import { createMockConfig } from '../utils/test-helpers.js';
import { ProcessGuard } from '../utils/process-guard.js';
import {
  DoctorService,
  type CommandRunner,
  type ModuleResolver,
} from '../services/doctor.js';

const NO_MODULES: ModuleResolver = () => {
  throw new Error('no modules');
};

/** fake runner：present 集合里的二进制 which 命中，其余失败。 */
function makeRunner(present: Set<string>): CommandRunner {
  return async (command: string) => {
    const w = command.match(/^(?:which|where)\s+(\S+)/);
    if (w) {
      if (present.has(w[1])) return `/usr/local/bin/${w[1]}`;
      throw new Error(`which: ${w[1]} not found`);
    }
    const v = command.match(/^(\S+)\s/);
    if (v && present.has(v[1])) return `${v[1]} version 1.0.0`;
    throw new Error(`${command}: not found`);
  };
}

/** 构造装了「缺 cliclick 的 mac DoctorService」的工具（不触碰真实二进制）。 */
function toolMissingCliclick(): DesktopAutomationTool {
  const doctor = new DoctorService(makeRunner(new Set()), NO_MODULES, 'darwin', () => false);
  return new DesktopAutomationTool(createMockConfig(), doctor);
}

describe('DesktopAutomationTool', () => {
  let tool: DesktopAutomationTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new DesktopAutomationTool(createMockConfig());
  });

  // --- Metadata ---
  it('has correct name', () => { expect(DesktopAutomationTool.Name).toBe('desktop_automation'); });
  it('has display name', () => { expect(tool.displayName).toBe('DesktopAutomation'); });
  it('has Terminal icon', () => { expect(tool.icon).toBe('terminal'); });

  // --- Validation: missing params ---
  it('rejects launch_app without app_name', () => {
    expect(tool.validateToolParams({ action: 'launch_app' })).toContain('app_name');
  });
  it('rejects quit_app without app_name', () => {
    expect(tool.validateToolParams({ action: 'quit_app' })).toContain('app_name');
  });
  it('rejects window_manager without app_name', () => {
    expect(tool.validateToolParams({ action: 'window_manager' })).toContain('app_name');
  });
  it('rejects window_manager without window_operation', () => {
    expect(tool.validateToolParams({ action: 'window_manager', app_name: 'Safari' })).toContain('window_operation');
  });
  it('rejects keyboard without keys', () => {
    expect(tool.validateToolParams({ action: 'keyboard' })).toContain('keys');
  });
  it('rejects type_text without text', () => {
    expect(tool.validateToolParams({ action: 'type_text' })).toContain('text');
  });
  it('rejects hotkey without keys', () => {
    expect(tool.validateToolParams({ action: 'hotkey' })).toContain('keys');
  });
  it('rejects mouse without x,y', () => {
    expect(tool.validateToolParams({ action: 'mouse' })).toContain('coordinates');
  });
  it('rejects drag without to_x,to_y', () => {
    expect(tool.validateToolParams({ action: 'drag', x: 0, y: 0 })).toContain('to_x');
  });
  it('rejects scroll without scroll_amount', () => {
    expect(tool.validateToolParams({ action: 'scroll' })).toContain('scroll_amount');
  });
  it('rejects run_script without script', () => {
    expect(tool.validateToolParams({ action: 'run_script' })).toContain('script');
  });

  // --- Validation: valid params ---
  it('accepts launch_app with app_name', () => {
    expect(tool.validateToolParams({ action: 'launch_app', app_name: 'Safari' })).toBeNull();
  });
  it('accepts window_manager with valid combination', () => {
    expect(tool.validateToolParams({ action: 'window_manager', app_name: 'Finder', window_operation: 'tile_left' })).toBeNull();
  });
  it('accepts keyboard with keys', () => {
    expect(tool.validateToolParams({ action: 'keyboard', keys: 'cmd+c' })).toBeNull();
  });
  it('accepts type_text', () => {
    expect(tool.validateToolParams({ action: 'type_text', text: 'hello' })).toBeNull();
  });
  it('accepts hotkey', () => {
    expect(tool.validateToolParams({ action: 'hotkey', keys: 'ctrl+shift+esc' })).toBeNull();
  });
  it('accepts mouse click', () => {
    expect(tool.validateToolParams({ action: 'mouse', x: 100, y: 200 })).toBeNull();
  });
  it('accepts drag', () => {
    expect(tool.validateToolParams({ action: 'drag', x: 0, y: 0, to_x: 500, to_y: 500 })).toBeNull();
  });
  it('accepts scroll', () => {
    expect(tool.validateToolParams({ action: 'scroll', scroll_amount: 3 })).toBeNull();
  });
  it('accepts screenshot', () => {
    expect(tool.validateToolParams({ action: 'screenshot' })).toBeNull();
  });
  it('accepts clipboard', () => {
    expect(tool.validateToolParams({ action: 'clipboard' })).toBeNull();
  });
  it('accepts get_active_app', () => {
    expect(tool.validateToolParams({ action: 'get_active_app' })).toBeNull();
  });
  it('accepts list_windows', () => {
    expect(tool.validateToolParams({ action: 'list_windows' })).toBeNull();
  });
  it('accepts screen_info', () => {
    expect(tool.validateToolParams({ action: 'screen_info' })).toBeNull();
  });
  it('accepts wait_for_app', () => {
    expect(tool.validateToolParams({ action: 'wait_for_app', app_name: 'Safari' })).toBeNull();
  });
  it('accepts all 17 actions', () => {
    const actions: Array<{ action: DesktopAutomationToolParams['action']; extra?: Record<string, unknown> }> = [
      { action: 'launch_app', extra: { app_name: 'Test' } },
      { action: 'quit_app', extra: { app_name: 'Test' } },
      { action: 'window_manager', extra: { app_name: 'Test', window_operation: 'tile_left' } },
      { action: 'keyboard', extra: { keys: 'cmd+c' } },
      { action: 'type_text', extra: { text: 'hi' } },
      { action: 'hotkey', extra: { keys: 'ctrl+shift+esc' } },
      { action: 'mouse', extra: { x: 0, y: 0 } },
      { action: 'drag', extra: { x: 0, y: 0, to_x: 100, to_y: 100 } },
      { action: 'scroll', extra: { scroll_amount: 1 } },
      { action: 'screenshot', extra: {} },
      { action: 'clipboard', extra: {} },
      { action: 'run_script', extra: { script: 'echo hi' } },
      { action: 'get_active_app', extra: {} },
      { action: 'list_windows', extra: {} },
      { action: 'screen_info', extra: {} },
      { action: 'wait_for_app', extra: { app_name: 'Test' } },
      { action: 'get_window_position', extra: { app_name: 'Test' } },
    ];
    for (const a of actions) {
      expect(tool.validateToolParams({ ...a.extra, action: a.action })).toBeNull();
    }
  });

  // --- getDescription ---
  it('getDescription includes action', () => {
    const d = tool.getDescription({ action: 'launch_app', app_name: 'Safari' });
    expect(d).toContain('launch_app');
    expect(d).toContain('Safari');
  });

  // --- shouldConfirmExecute ---
  it('shouldConfirmExecute returns confirmation in DEFAULT mode', async () => {
    const r = await tool.shouldConfirmExecute(
      { action: 'launch_app', app_name: 'Safari' },
      new AbortController().signal,
    );
    expect(r).not.toBe(false);
  });
  it('shouldConfirmExecute for run_script has warning prefix', async () => {
    const r = await tool.shouldConfirmExecute(
      { action: 'run_script', script: 'test' },
      new AbortController().signal,
    );
    if (r && typeof r === 'object') {
      expect(r.title).toContain('[WARN]');
    }
  });

  // --- doctor 前置：cliclick（仅 mac 键鼠/输入类动作）---
  const isMac = os.platform() === 'darwin';

  it.runIf(isMac)('fails loudly on keyboard when cliclick missing, with install command', async () => {
    const t = toolMissingCliclick();
    const r = await t.execute({ action: 'keyboard', keys: 'cmd+c' }, new AbortController().signal);
    const content = String(r.llmContent);
    expect(content).toContain('keyboard FAIL');
    expect(content).toContain('cliclick');
    expect(content).toContain('brew install cliclick');
  });

  it.runIf(isMac)('fails loudly on mouse click when cliclick missing', async () => {
    const t = toolMissingCliclick();
    const r = await t.execute({ action: 'mouse', x: 10, y: 10 }, new AbortController().signal);
    expect(String(r.llmContent)).toContain('cliclick');
  });

  it.runIf(isMac)('does NOT run cliclick preflight for window_manager (osascript path)', async () => {
    // 窗口类走 osascript，不应触发 cliclick 前置体检。用 spy 断言 doctor.check
    // 对 window_manager 未被调用（若被调用即说明误拦），同时对 keyboard 会被调用。
    // mock ProcessGuard.exec 让底层 osascript 秒回，避免真实执行副作用/超时。
    const execSpy = vi
      .spyOn(ProcessGuard, 'exec')
      .mockResolvedValue({ stdout: '', stderr: '' });
    try {
      const doctor = new DoctorService(makeRunner(new Set()), NO_MODULES, 'darwin', () => false);
      const spy = vi.spyOn(doctor, 'check');
      const t = new DesktopAutomationTool(createMockConfig(), doctor);

      // keyboard：应触发 cliclick 前置（doctor.check 被调用）。
      await t.execute({ action: 'keyboard', keys: 'cmd+c' }, new AbortController().signal);
      expect(spy).toHaveBeenCalled();

      // window_manager：不应触发 cliclick 前置。重置计数后单独验证。
      spy.mockClear();
      await t.execute(
        { action: 'window_manager', app_name: '__NoSuchApp_ZZZ__', window_operation: 'tile_left' },
        new AbortController().signal,
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      execSpy.mockRestore();
    }
  });
});
