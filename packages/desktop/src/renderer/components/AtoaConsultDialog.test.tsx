/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { parseAtoaMessage } from '../atoaProtocol.js';
import { AtoaConsultDialog } from './AtoaConsultDialog.js';

const member = {
  id: 'peer-1',
  username: 'alice',
  name: 'Alice',
  role: 'member',
  department: '产品部',
  departmentId: 'dept-1',
  positionId: 'pos-1',
  positionTitle: '产品经理',
  avatarUrl: null,
  isAdmin: false,
  status: 'active' as const,
};

const account = {
  id: 'me',
  organizationId: 'org-1',
  organizationName: 'Otto 企业',
  accountType: 'enterprise' as const,
  employeeId: 'OTTO-001',
  username: 'bob',
  phone: null,
  name: 'Bob',
  role: 'member',
  department: '研发部',
  positionId: 'pos-2',
  positionTitle: '工程师',
  isAdmin: false,
  status: 'active' as const,
  tags: [],
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
};

describe('双方 Otto 协商发起弹窗', () => {
  it('先生成本方提案并预览，用户再次确认后才发送给对方 Otto', async () => {
    const collectContext = vi.fn(async () => ({
      context: '我的日程：16:00 后有空。',
      loadedSources: ['schedules' as const],
      failedSources: [],
    }));
    const askOtto = vi.fn(async () => '建议 16:30 评审，先审接口，仍需双方确认。');
    const sendMessage = vi.fn(async (_peerAccountId: string, _content: string) => ({
      id: 'sent-1',
      senderAccountId: 'me',
      recipientAccountId: 'peer-1',
      content: '',
      createdAt: '2026-07-20T01:00:00.000Z',
      readAt: null,
    }));
    const onSent = vi.fn();

    render(
      <AtoaConsultDialog
        account={account}
        member={member}
        schedules={[]}
        onClose={vi.fn()}
        onSent={onSent}
        collectContext={collectContext}
        askOtto={askOtto}
        sendMessage={sendMessage}
      />,
    );

    fireEvent.change(screen.getByLabelText('协商目标'), {
      target: { value: '协商明天的接口评审时间和分工' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /日程/ }));
    fireEvent.click(screen.getByRole('button', { name: '让我的 Otto 生成提案' }));

    await screen.findByText('建议 16:30 评审，先审接口，仍需双方确认。');
    expect(collectContext).toHaveBeenCalledWith(['schedules']);
    expect(askOtto).toHaveBeenCalledWith({
      question: '协商明天的接口评审时间和分工',
      workContext: '我的日程：16:00 后有空。',
      mode: 'consult_initiator',
    });
    expect(sendMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认发送给对方 Otto' }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    const parsed = parseAtoaMessage(sendMessage.mock.calls[0][1]);
    expect(parsed).toMatchObject({
      kind: 'request',
      payload: {
        mode: 'consult',
        requestedSources: ['schedules'],
        initiatorProposal: '建议 16:30 评审，先审接口，仍需双方确认。',
      },
    });
    expect(onSent).toHaveBeenCalledOnce();
  });

  it('未选择资料也允许生成无资料提案，但明确不读取数据源', async () => {
    const collectContext = vi.fn(async () => ({
      context: '本次未授权任何资料。',
      loadedSources: [],
      failedSources: [],
    }));
    const askOtto = vi.fn(async () => '可先询问双方候选时间。');
    render(
      <AtoaConsultDialog
        account={account}
        member={member}
        schedules={[]}
        onClose={vi.fn()}
        onSent={vi.fn()}
        collectContext={collectContext}
        askOtto={askOtto}
        sendMessage={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('协商目标'), {
      target: { value: '协商会议' },
    });
    fireEvent.click(screen.getByRole('button', { name: '让我的 Otto 生成提案' }));
    await screen.findByText('可先询问双方候选时间。');
    expect(collectContext).toHaveBeenCalledWith([]);
  });
});
