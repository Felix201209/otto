/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildInitialChatTools,
  buildRuntimeSystemInstruction,
  OttoClient,
} from './client.js';

describe('OttoClient A2A 隔离上下文', () => {
  it('禁用环境上下文时不读取或发送 cwd、系统信息和目录树', async () => {
    const client = Object.create(OttoClient.prototype) as OttoClient;
    (client as unknown as { config: { getEnvironmentContextDisabled(): boolean } }).config = {
      getEnvironmentContextDisabled: () => true,
    };

    const parts = await (client as unknown as { getEnvironment(): Promise<Array<{ text?: string }>> })
      .getEnvironment();

    expect(parts).toEqual([{
      text: expect.stringContaining('A2A isolated context'),
    }]);
    expect(parts[0]?.text).not.toContain('Working Directory');
    expect(parts[0]?.text).not.toContain('PROJECT STRUCTURE');
  });

  it('禁用工具时连 OttoChat 初始生成配置也保持空工具集', () => {
    const getFunctionDeclarations = vi.fn(() => [{ name: 'read_file' }]);

    expect(buildInitialChatTools(true, { getFunctionDeclarations })).toEqual([]);
    expect(getFunctionDeclarations).not.toHaveBeenCalled();
    expect(buildInitialChatTools(false, { getFunctionDeclarations }))
      .toEqual([{ functionDeclarations: [{ name: 'read_file' }] }]);
  });

  it('隔离模式只使用 A2A 最小规则，不构建含本机文件与 Skills 的完整系统提示', () => {
    const buildFullSystemInstruction = vi.fn(() => [
      'OTTO_SYSTEM_MD_SECRET',
      '/Users/felix/private-project',
      '.llm-wiki',
      'GLOBAL_SKILLS_METADATA',
    ].join('\n'));

    const prompt = buildRuntimeSystemInstruction({
      isolatedA2A: true,
      userRules: '你是 A2A 安全协作 Agent，只回答本轮获准问题。',
      preferredLanguage: '简体中文',
      buildFullSystemInstruction,
    });

    expect(buildFullSystemInstruction).not.toHaveBeenCalled();
    expect(prompt).toContain('A2A 安全协作 Agent');
    expect(prompt).toContain('简体中文');
    expect(prompt).not.toContain('OTTO_SYSTEM_MD_SECRET');
    expect(prompt).not.toContain('/Users/felix/private-project');
    expect(prompt).not.toContain('.llm-wiki');
    expect(prompt).not.toContain('GLOBAL_SKILLS_METADATA');
  });
});
