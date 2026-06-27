/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ChildProcess } from 'child_process';
import { type CommandContext, MessageActionReturn } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

// Mock i18n
vi.mock('../utils/i18n.js', () => ({
    isChineseLocale: () => false,
    t: (key: string) => {
      const mockTranslations: Record<string, string> = {
        'command.login.description': '启动登录服务器',
      };
      return mockTranslations[key] || key;
    },
    tp: (key: string) => key,
    getLocalizedToolName: (name: string) => name,
  }));

// Mock 外部依赖 - 必须在导入 loginCommand 之前
const { mockAuthServerStart, mockAuthServer, mockExec } = vi.hoisted(() => {
  const startFn = vi.fn().mockResolvedValue(undefined);
  return {
    mockAuthServerStart: startFn,
    mockAuthServer: vi.fn().mockImplementation(() => ({
      start: startFn,
    })),
    mockExec: vi.fn(),
  };
});

vi.mock('otto-core', () => ({
    AuthServer: mockAuthServer,
  }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    exec: mockExec,
    default: {
      ...actual,
      exec: mockExec,
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    exec: mockExec,
    default: {
      ...actual,
      exec: mockExec,
    },
  };
});

// 现在导入 loginCommand
import { loginCommand, _resetAuthServer } from './loginCommand.js';

// Mock console 方法以避免测试输出污染
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

describe('loginCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    // 重置全局状态
    _resetAuthServer();

    // 重置所有 mock
    vi.clearAllMocks();

    // 创建 mock context
    mockContext = createMockCommandContext();

    // 重置 AuthServer mock
    mockAuthServerStart.mockResolvedValue(undefined);

    // 设置 child_process.exec mock
    mockExec.mockImplementation((_command, callback) => {
      // 模拟成功执行
      if (callback) {
        callback(null, '', '');
      }
      return {} as ChildProcess;
    });
  });

  // 基本属性测试
  it('should have the correct name and description', () => {
    expect(loginCommand.name).toBe('login');
    expect(loginCommand.description).toBe('启动登录服务器');
    expect(loginCommand.kind).toBe('built-in');
  });

  it('should have an action function', () => {
    expect(loginCommand.action).toBeDefined();
    expect(typeof loginCommand.action).toBe('function');
  });

  // BYO-key 行为测试：Otto 自带 key，/login 不再启动 AuthServer/打开浏览器，
  // 而是直接返回一条提示用户用 /model 或 otto setup 的 info 消息。
  describe('BYO-key behavior', () => {
    it('should return a BYO-key hint message without starting auth server or browser', async () => {
      if (!loginCommand.action) {
        throw new Error('Login command must have an action');
      }

      const result = await loginCommand.action(mockContext, '') as MessageActionReturn;

      // 不再创建/启动 AuthServer，也不再打开浏览器
      expect(mockAuthServer).not.toHaveBeenCalled();
      expect(mockAuthServerStart).not.toHaveBeenCalled();
      expect(mockExec).not.toHaveBeenCalled();

      // 返回 BYO-key 提示消息（关键词匹配，避免硬编码整句）
      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toEqual(expect.stringContaining('otto setup'));
      expect(result.content).toEqual(expect.stringContaining('/model'));
    });

    it('should always succeed with an info message regardless of input args', async () => {
      if (!loginCommand.action) {
        throw new Error('Login command must have an action');
      }

      const result = await loginCommand.action(mockContext, 'anything') as MessageActionReturn;

      // 不再有 AuthServer 启动失败这种错误路径——始终返回 info 提示
      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toEqual(expect.stringContaining('otto setup'));
    });
  });
});
