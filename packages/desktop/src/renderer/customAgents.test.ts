/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildCustomAgentKickoff,
  createCustomAgent,
  customAgentStorageKey,
  parseCustomAgents,
} from './customAgents.js';

describe('自定义专家定义', () => {
  it('按账号和企业隔离本地定义，避免退出后串到另一个账号', () => {
    expect(customAgentStorageKey('org-a', 'account-1'))
      .not.toBe(customAgentStorageKey('org-a', 'account-2'));
    expect(customAgentStorageKey('org-a', 'account-1'))
      .not.toBe(customAgentStorageKey('org-b', 'account-1'));
  });

  it('创建时规范化名称与职责，并拒绝空壳或过长内容', () => {
    expect(createCustomAgent(
      { name: '  招投标助手  ', instructions: '  整理标书要求并生成检查清单。  ' },
      { id: 'custom-1', now: '2026-07-20T16:00:00.000Z' },
    )).toEqual({
      id: 'custom-1',
      name: '招投标助手',
      instructions: '整理标书要求并生成检查清单。',
      createdAt: '2026-07-20T16:00:00.000Z',
    });

    expect(() => createCustomAgent(
      { name: ' ', instructions: '有职责' },
      { id: 'custom-2', now: '2026-07-20T16:00:00.000Z' },
    )).toThrow('请输入专家名称');
    expect(() => createCustomAgent(
      { name: '助手', instructions: ' ' },
      { id: 'custom-3', now: '2026-07-20T16:00:00.000Z' },
    )).toThrow('请输入职责说明');
    expect(() => createCustomAgent(
      { name: '超长'.repeat(30), instructions: '有职责' },
      { id: 'custom-4', now: '2026-07-20T16:00:00.000Z' },
    )).toThrow('专家名称不能超过 40 个字符');
  });

  it('读取持久化内容时丢弃损坏、越界或注入形态的记录', () => {
    const parsed = parseCustomAgents(JSON.stringify([
      {
        id: 'custom-valid_1',
        name: '合同审阅',
        instructions: '提取风险条款并给出修改建议。',
        createdAt: '2026-07-20T16:00:00.000Z',
      },
      {
        id: '../../unsafe',
        name: '危险记录',
        instructions: '不应加载',
        createdAt: '2026-07-20T16:00:00.000Z',
      },
      { id: 'custom-empty', name: '', instructions: '', createdAt: 'bad' },
    ]));

    expect(parsed).toEqual([expect.objectContaining({
      id: 'custom-valid_1',
      name: '合同审阅',
    })]);
    expect(parseCustomAgents('{not-json')).toEqual([]);
  });

  it('启动提示明确继承真实企业身份与权限，不把自定义名称冒充额外账号', () => {
    const agent = createCustomAgent(
      { name: '客户成功助手', instructions: '跟进客户风险与续费待办。' },
      { id: 'custom-cs', now: '2026-07-20T16:00:00.000Z' },
    );
    const prompt = buildCustomAgentKickoff(agent, {
      edition: 'enterprise',
      organizationName: '星河科技',
      department: '客户成功部',
      positionTitle: '客户成功经理',
    });

    expect(prompt).toContain('客户成功助手');
    expect(prompt).toContain('跟进客户风险与续费待办');
    expect(prompt).toContain('星河科技');
    expect(prompt).toContain('客户成功部');
    expect(prompt).toContain('不获得任何额外账号、部门、数据或操作权限');
  });
});
