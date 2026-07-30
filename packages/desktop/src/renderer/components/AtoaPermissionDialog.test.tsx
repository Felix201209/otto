/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  AtoaPermissionDialog,
  type AtoaPermissionRequest,
} from './AtoaPermissionDialog.js';

const request: AtoaPermissionRequest = {
  peer: {
    id: 'peer-1',
    username: 'alice',
    name: 'Alice',
    department: '产品部',
    positionTitle: '产品经理',
    role: 'member',
  },
  payload: {
    v: 1 as const,
    id: 'req-1',
    question: '能比较我们的日程并协商评审时间吗？',
    createdAt: '2026-07-20T00:00:00.000Z',
    mode: 'consult' as const,
    requestedSources: ['current_chat', 'schedules'],
    initiatorProposal: '发起方 Otto 建议 15:00。',
  },
};

describe('A2A 权限选择弹窗', () => {
  it('默认不授权任何资料，允许只勾选指定范围', () => {
    const onDecision = vi.fn();
    render(<AtoaPermissionDialog request={request} onDecision={onDecision} />);

    expect(screen.getByRole('dialog', { name: 'Otto 协作权限' })).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('产品部 · 产品经理')).toBeTruthy();
    expect(screen.getByText(request.payload.question)).toBeTruthy();
    expect(screen.getAllByRole('checkbox').every((item) => !(item as HTMLInputElement).checked))
      .toBe(true);
    expect(
      (screen.getByRole('button', {
        name: '允许所选范围',
      }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: /当前聊天/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /日程/ }));
    fireEvent.click(screen.getByRole('button', { name: '允许所选范围' }));
    expect(onDecision).toHaveBeenCalledWith({
      kind: 'allow',
      sources: ['current_chat', 'schedules'],
    });
  });

  it('全部授权只代表界面列出的四类资料，不包含本机文件或密钥', () => {
    const onDecision = vi.fn();
    render(<AtoaPermissionDialog request={request} onDecision={onDecision} />);

    expect(screen.getByText(/不包括本机文件、模型密钥/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '允许全部可授权资料' }));
    expect(onDecision).toHaveBeenCalledWith({
      kind: 'allow',
      sources: [
        'current_chat',
        'enterprise_knowledge',
        'work_logs',
        'schedules',
      ],
    });
  });

  it('拒绝回答明确返回 deny', () => {
    const onDecision = vi.fn();
    render(<AtoaPermissionDialog request={request} onDecision={onDecision} />);
    fireEvent.click(screen.getByRole('button', { name: '拒绝回答' }));
    expect(onDecision).toHaveBeenCalledWith({ kind: 'deny' });
  });
});
