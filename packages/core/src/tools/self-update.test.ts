/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildRelaunchScript,
  SelfUpdateTool,
  type RelaunchInstallMode,
} from './self-update.js';
import type { Config } from '../config/config.js';

/**
 * SelfUpdateTool / buildRelaunchScript — 飞书模式下"更新并重启 / 仅重启"。
 *
 * 重启方式（双轨）：
 *   - Windows: cmd.exe /c <command>（有 conpty，用户可见 TUI）
 *   - Linux/macOS: login shell -l -c <command>（加载 .bashrc/.profile，使 nvm 等 PATH 生效）
 */
describe('buildRelaunchScript', () => {
  const base = {
    parentPid: 12345,
    relaunchCommand: 'otto',
    relaunchArgs: ['--feishu'],
    scriptPath: '/tmp/otto-relaunch-12345.js',
  };

  const npmMode: RelaunchInstallMode = { type: 'npm', packageName: 'otto-ai' };
  const noneMode: RelaunchInstallMode = { type: 'none' };
  const tgzMode: RelaunchInstallMode = { type: 'tgz', path: '/abs/otto-ai-1.1.3.tgz' };

  it('always embeds parent PID polling via process.kill', () => {
    const script = buildRelaunchScript({ ...base, install: npmMode });
    expect(script).toContain('12345');
    expect(script).toContain('process.kill');
  });

  it('npm mode embeds `<pkg>@latest` install', () => {
    const script = buildRelaunchScript({ ...base, install: npmMode });
    expect(script).toContain('otto-ai@latest');
    expect(script).toContain('install');
    expect(script).toContain('-g');
  });

  it('tgz mode embeds the local tgz absolute path install', () => {
    const script = buildRelaunchScript({ ...base, install: tgzMode });
    expect(script).toContain('/abs/otto-ai-1.1.3.tgz');
    expect(script).toContain('install');
    expect(script).toContain('-g');
    expect(script).not.toContain('@latest');
  });

  it('none mode (restart only) installs nothing — INSTALL_ARGS is null', () => {
    const script = buildRelaunchScript({ ...base, install: noneMode });
    expect(script).toContain('INSTALL_ARGS = null');
    expect(script).not.toContain('@latest');
    expect(script).toContain('otto');
    expect(script).toContain('--feishu');
  });

  it('always embeds the relaunch command and args', () => {
    for (const install of [npmMode, noneMode, tgzMode]) {
      const script = buildRelaunchScript({ ...base, install });
      expect(script).toContain('otto');
      expect(script).toContain('--feishu');
    }
  });

  it('always self-deletes the temp script', () => {
    for (const install of [npmMode, noneMode, tgzMode]) {
      const script = buildRelaunchScript({ ...base, install });
      expect(script).toContain('unlink');
    }
  });

  it('always uses detached + unref to outlive itself', () => {
    for (const install of [npmMode, noneMode, tgzMode]) {
      const script = buildRelaunchScript({ ...base, install });
      expect(script).toContain('detached');
      expect(script).toContain('unref');
    }
  });

  it('produces valid JavaScript for all modes', () => {
    for (const install of [npmMode, noneMode, tgzMode]) {
      const script = buildRelaunchScript({ ...base, install });
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it('embeds args via JSON to avoid injection', () => {
    const script = buildRelaunchScript({
      ...base,
      install: noneMode,
      relaunchArgs: ['--feishu', '--weird "arg"'],
    });
    expect(script).toContain(JSON.stringify(['--feishu', '--weird "arg"']));
  });

  it('contains dual launch strategy: cmd.exe for Windows, login shell for non-Windows', () => {
    const script = buildRelaunchScript({ ...base, install: noneMode });
    // Windows branch
    expect(script).toContain('cmd.exe');
    expect(script).toContain('/c');
    // Non-Windows branch: login shell
    expect(script).toContain('findLoginShell');
    expect(script).toContain('-l');
    expect(script).toContain('-c');
    // Platform check
    expect(script).toContain('process.platform');
  });

  it('findLoginShell prioritizes bash over zsh over sh', () => {
    const script = buildRelaunchScript({ ...base, install: noneMode });
    expect(script).toContain('/bin/bash');
    expect(script).toContain('/bin/zsh');
    expect(script).toContain('/bin/sh');
    // bash 应排在 zsh 前面
    const bashIdx = script.indexOf('/bin/bash');
    const zshIdx = script.indexOf('/bin/zsh');
    const shIdx = script.indexOf('/bin/sh');
    expect(bashIdx).toBeLessThan(zshIdx);
    expect(zshIdx).toBeLessThan(shIdx);
  });

  it('listens for spawn error event so failures are observable', () => {
    const script = buildRelaunchScript({ ...base, install: noneMode });
    expect(script).toContain("on('error'");
  });

  it('redirects relaunch output to a log file when logPath is provided', () => {
    const script = buildRelaunchScript({
      ...base,
      install: noneMode,
      logPath: '/home/u/.otto-user/relaunch.log',
    });
    expect(script).toContain(JSON.stringify('/home/u/.otto-user/relaunch.log'));
    expect(script).toContain('openSync');
  });

  it('produces valid JavaScript with logPath', () => {
    const script = buildRelaunchScript({
      ...base,
      install: npmMode,
      logPath: '/tmp/relaunch.log',
    });
    expect(() => new Function(script)).not.toThrow();
  });

  it('embeds tgz path via JSON to handle spaces/backslashes safely', () => {
    const winPath = 'C:\\Users\\me\\pkgs\\otto-ai 1.1.3.tgz';
    const script = buildRelaunchScript({
      ...base,
      install: { type: 'tgz', path: winPath },
    });
    expect(script).toContain(JSON.stringify(winPath));
  });

  it('does not contain obsolete NODE_PATH / ENTRY_SCRIPT variables', () => {
    const script = buildRelaunchScript({ ...base, install: noneMode });
    expect(script).not.toContain('NODE_PATH');
    expect(script).not.toContain('ENTRY_SCRIPT');
  });
});

describe('SelfUpdateTool', () => {
  const makeConfig = (): Config =>
    ({ getModel: () => 'test-model' }) as unknown as Config;

  it('has the correct tool name and no required params', () => {
    const tool = new SelfUpdateTool(makeConfig());
    expect(tool.name).toBe('self_update');
    expect(tool.schema.parameters?.required ?? []).toEqual([]);
  });

  it('schema exposes action and source params to the model', () => {
    const tool = new SelfUpdateTool(makeConfig());
    const props = (tool.schema.parameters?.properties ?? {}) as Record<string, unknown>;
    expect(props).toHaveProperty('action');
    expect(props).toHaveProperty('source');
  });

  it('validates action enum', () => {
    const tool = new SelfUpdateTool(makeConfig());
    expect(tool.validateToolParams({ action: 'update_and_restart' })).toBeNull();
    expect(tool.validateToolParams({ action: 'restart_only' })).toBeNull();
    expect(tool.validateToolParams({ action: 'bogus' as never })).not.toBeNull();
  });

  it('requires source path when source is a local tgz', () => {
    const tool = new SelfUpdateTool(makeConfig());
    expect(
      tool.validateToolParams({ action: 'update_and_restart', source: 'local' }),
    ).not.toBeNull();
    expect(
      tool.validateToolParams({
        action: 'update_and_restart',
        source: 'local',
        sourcePath: '/abs/pkg.tgz',
      }),
    ).toBeNull();
  });

  it('restart_only ignores source and is always valid', () => {
    const tool = new SelfUpdateTool(makeConfig());
    expect(tool.validateToolParams({ action: 'restart_only' })).toBeNull();
  });

  it('description mentions update/restart', () => {
    const tool = new SelfUpdateTool(makeConfig());
    expect(tool.getDescription({}).toLowerCase()).toMatch(/updat|restart|重启|更新/);
  });
});
