/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ToolCalls · AskUserQuestion 问答卡单测：
 *   工具卡在 awaiting_approval + confirmationDetails.type==='question' 时，整卡
 *   替换成交互式问答卡。验证选项作答、Other 自由文本、提交 payload、跳过路径。
 *   这是「答案能不能正确回传」的前端保证——server 侧闸门由 runtime.test.ts 覆盖。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import type { ToolCall } from 'otto-server';
import { ToolCallsCard } from './ToolCalls.js';

/** 造一张待作答的 ask_user_question 工具卡。 */
function questionCard(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'call-1',
    toolName: 'ask_user_question',
    parameters: {},
    status: 'awaiting_approval' as ToolCall['status'],
    confirmationDetails: {
      type: 'question',
      title: '需要你确认',
      questions: [
        {
          question: '选哪个？',
          header: '选择',
          options: [
            { label: 'A 方案', description: '甲' },
            { label: 'B 方案', description: '乙' },
          ],
        },
      ],
    },
    ...overrides,
  };
}

describe('ToolCalls · AskUserQuestion 问答卡', () => {
  it('渲染问题与选项，选中后提交回传正确 answers', () => {
    const onRespond = vi.fn();
    render(
      <ToolCallsCard
        toolCalls={[questionCard()]}
        onRespondQuestion={onRespond}
      />,
    );

    // 问题文本与两个选项 + 自动追加的 Other 都在。
    expect(screen.getByText('选哪个？')).toBeTruthy();
    expect(screen.getByText('A 方案')).toBeTruthy();
    expect(screen.getByText('B 方案')).toBeTruthy();
    expect(screen.getByText('Other')).toBeTruthy();

    // 未作答时提交禁用。
    const submit = screen.getByRole('button', { name: '提交' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    // 选 A 方案 → 提交启用 → 点击回传。
    fireEvent.click(screen.getByText('A 方案'));
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith('call-1', 'approved', {
      answers: { '选哪个？': 'A 方案' },
    });
  });

  it('选 Other → 输入自由文本 → 提交用输入内容作答', () => {
    const onRespond = vi.fn();
    render(
      <ToolCallsCard
        toolCalls={[questionCard()]}
        onRespondQuestion={onRespond}
      />,
    );

    // 选 Other 前无输入框；选中后出现。
    fireEvent.click(screen.getByText('Other'));
    const input = screen.getByPlaceholderText('输入你的回答…') as HTMLInputElement;
    expect(input).toBeTruthy();

    // Other 选中但为空时不可提交。
    const submit = screen.getByRole('button', { name: '提交' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'C 自定义' } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    expect(onRespond).toHaveBeenCalledWith('call-1', 'approved', {
      answers: { '选哪个？': 'C 自定义' },
    });
  });

  it('跳过 → 以 rejected 回传（不带答案）', () => {
    const onRespond = vi.fn();
    render(
      <ToolCallsCard
        toolCalls={[questionCard()]}
        onRespondQuestion={onRespond}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    expect(onRespond).toHaveBeenCalledWith('call-1', 'rejected');
  });

  it('多选题：选中多项，提交以逗号连接答案', () => {
    const onRespond = vi.fn();
    render(
      <ToolCallsCard
        toolCalls={[
          questionCard({
            confirmationDetails: {
              type: 'question',
              title: 't',
              questions: [
                {
                  question: '要哪些？',
                  header: '多选',
                  multiSelect: true,
                  options: [
                    { label: '甲', description: '' },
                    { label: '乙', description: '' },
                    { label: '丙', description: '' },
                  ],
                },
              ],
            },
          }),
        ]}
        onRespondQuestion={onRespond}
      />,
    );

    fireEvent.click(screen.getByText('甲'));
    fireEvent.click(screen.getByText('丙'));
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    expect(onRespond).toHaveBeenCalledWith('call-1', 'approved', {
      answers: { '要哪些？': '甲, 丙' },
    });
  });

  it('提交后进入已提交态，按钮禁用防重复提交', () => {
    const onRespond = vi.fn();
    render(
      <ToolCallsCard
        toolCalls={[questionCard()]}
        onRespondQuestion={onRespond}
      />,
    );
    fireEvent.click(screen.getByText('A 方案'));
    const submit = screen.getByRole('button', { name: '提交' });
    fireEvent.click(submit);
    // 文案变「已提交」，再点无效。
    const sent = screen.getByRole('button', { name: '已提交' });
    expect((sent as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(sent);
    expect(onRespond).toHaveBeenCalledTimes(1);
  });
});

describe('ToolCalls · 敏感操作确认卡', () => {
  it('展示风险与操作内容，并可允许或拒绝', () => {
    const onRespond = vi.fn();
    const tool: ToolCall = {
      id: 'danger-1', toolName: 'run_shell_command', parameters: {},
      status: 'awaiting_approval' as ToolCall['status'],
      confirmationDetails: {
        type: 'exec', title: '危险命令 - 必须确认', command: 'rm -rf build', riskLevel: 'high',
      },
    };
    render(<ToolCallsCard toolCalls={[tool]} onRespondQuestion={onRespond} />);
    expect(screen.getByText('高风险操作')).toBeTruthy();
    expect(screen.getByText('rm -rf build')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '允许执行' }));
    expect(onRespond).toHaveBeenCalledWith('danger-1', 'approved');
  });
});

describe('ToolCalls · 飞书授权二维码', () => {
  it('从 lark_cli 实时输出渲染可扫码二维码，并保留浏览器授权入口', () => {
    const openExternal = vi.fn(async () => undefined);
    (window as unknown as { otto: { openExternal: typeof openExternal } }).otto = {
      openExternal,
    };
    const authUrl =
      'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=flow-1&user_code=9NVZ-JH8A';
    const tool: ToolCall = {
      id: 'lark-auth',
      toolName: 'lark_cli',
      parameters: { command: 'auth login' },
      status: 'executing' as ToolCall['status'],
      liveOutput: `请扫码授权：\n${authUrl}\n等待授权完成...`,
    };

    render(<ToolCallsCard toolCalls={[tool]} />);

    expect(screen.getByRole('img', { name: '飞书授权二维码' })).toBeTruthy();
    expect(screen.getByText('授权码：9NVZ-JH8A')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '在浏览器中打开授权页面' }));
    expect(openExternal).toHaveBeenCalledWith(authUrl);
  });

  it('拒绝把非飞书域名伪装成授权二维码', () => {
    const tool: ToolCall = {
      id: 'fake-auth',
      toolName: 'lark_cli',
      parameters: { command: 'auth login' },
      status: 'executing' as ToolCall['status'],
      liveOutput:
        'https://evil.example/oauth/v1/device/verify?user_code=STEAL-ME',
    };

    render(<ToolCallsCard toolCalls={[tool]} />);

    expect(screen.queryByRole('img', { name: '飞书授权二维码' })).toBeNull();
  });

  it('同时校验 HTTPS、官方主机和已知授权路径', () => {
    const invalidCases = [
      'http://accounts.feishu.cn/oauth/v1/device/verify?user_code=NOPE-1',
      'https://accounts.feishu.cn/unrelated?user_code=NOPE-2',
      'https://accounts.feishu.cn.evil.example/oauth/v1/device/verify?user_code=NOPE-3',
    ];

    for (const [index, url] of invalidCases.entries()) {
      const { unmount } = render(
        <ToolCallsCard
          toolCalls={[{
            id: `invalid-auth-${index}`,
            toolName: 'lark_cli',
            parameters: {},
            status: 'executing' as ToolCall['status'],
            liveOutput: url,
          }]}
        />,
      );
      expect(screen.queryByRole('img', { name: '飞书授权二维码' })).toBeNull();
      unmount();
    }
  });

  it('支持 Lark 官方 CLI 授权页，但不信任其它工具输出的同一链接', () => {
    const authUrl =
      'https://open.larksuite.com/page/cli?user_code=LARK-1234&from=cli';
    const validTool: ToolCall = {
      id: 'lark-global-auth',
      toolName: 'lark_cli',
      parameters: {},
      status: 'executing' as ToolCall['status'],
      liveOutput: authUrl,
    };
    const { unmount } = render(<ToolCallsCard toolCalls={[validTool]} />);
    expect(screen.getByRole('img', { name: '飞书授权二维码' })).toBeTruthy();
    expect(screen.getByText('授权码：LARK-1234')).toBeTruthy();
    unmount();

    render(
      <ToolCallsCard
        toolCalls={[{ ...validTool, id: 'other-tool', toolName: 'web_fetch' }]}
      />,
    );
    expect(screen.queryByRole('img', { name: '飞书授权二维码' })).toBeNull();
  });

  it('从彩色终端输出中提取官方授权链接', () => {
    const escape = String.fromCharCode(27);
    const authUrl =
      'https://accounts.feishu.cn/oauth/v1/device/verify?user_code=COLOR-1234';
    const tool: ToolCall = {
      id: 'colored-lark-auth',
      toolName: 'lark_cli',
      parameters: {},
      status: 'executing' as ToolCall['status'],
      liveOutput: `${escape}[36m${authUrl}${escape}[0m`,
    };

    render(<ToolCallsCard toolCalls={[tool]} />);

    expect(screen.getByRole('img', { name: '飞书授权二维码' })).toBeTruthy();
    expect(screen.getByText('授权码：COLOR-1234')).toBeTruthy();
  });
});
