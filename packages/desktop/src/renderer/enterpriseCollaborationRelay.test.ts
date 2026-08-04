/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { parseAtoaMessage } from './atoaProtocol.js';
import { executeEnterpriseCollaborationRelay } from './enterpriseCollaborationRelay.js';

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
  positionId: null,
  positionTitle: '工程师',
  isAdmin: false,
  status: 'active' as const,
  tags: [],
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
};

const organization = {
  organization: {
    id: 'org-1',
    name: 'Otto 企业',
    status: 'active' as const,
    createdAt: '2026-07-20T00:00:00.000Z',
  },
  members: [
    {
      id: 'me',
      username: 'bob',
      name: 'Bob',
      role: 'member',
      department: '研发部',
      positionTitle: '工程师',
      isAdmin: false,
      status: 'active' as const,
    },
    {
      id: 'peer-1',
      username: 'alice',
      name: 'Alice',
      role: 'member',
      department: '产品部',
      positionTitle: '产品经理',
      isAdmin: false,
      status: 'active' as const,
    },
  ],
  employeeCount: 2,
};

const dependencies = () => ({
  getOrganizationView: vi.fn(async () => organization),
  sendMessage: vi.fn(async (_peer: string, content: string) => ({
    id: 'sent-1',
    senderAccountId: 'me',
    recipientAccountId: 'peer-1',
    content,
    createdAt: '2026-07-20T01:00:00.000Z',
    readAt: null,
  })),
  requestConsult: vi.fn(async () => ({
    id: 'consult-1',
    senderAccountId: 'me',
    recipientAccountId: 'peer-1',
    content: 'consult',
    createdAt: '2026-07-20T01:00:00.000Z',
    readAt: null,
  })),
  updateAccount: vi.fn(async (id: string, input: {
    department: string;
    positionTitle: string;
    role?: string | null;
  }) => ({
    ...organization.members.find((member) => member.id === id)!,
    organizationId: 'org-1',
    organizationName: 'Otto 企业',
    accountType: 'enterprise' as const,
    employeeId: null,
    phone: null,
    positionId: null,
    tags: [],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T02:00:00.000Z',
    ...input,
  })),
});

describe('enterprise_collaboration renderer 真实中继', () => {
  it('does not expose decrypted private-chat history to Otto tools', async () => {
    await expect(executeEnterpriseCollaborationRelay(
      { action: 'list_messages', recipientAccountId: 'peer-1' },
      account,
      dependencies(),
    )).rejects.toThrow('action');
  });
  it('list_members 返回真实 active 企业树成员和可用于后续动作的账号 ID', async () => {
    const deps = dependencies();
    const result = await executeEnterpriseCollaborationRelay(
      { action: 'list_members' },
      account,
      deps,
    );
    expect(result).toEqual({
      ok: true,
      organization: { id: 'org-1', name: 'Otto 企业' },
      members: [
        expect.objectContaining({ id: 'me', name: 'Bob' }),
        expect.objectContaining({ id: 'peer-1', name: 'Alice' }),
      ],
    });
  });

  it('发送前校验目标仍是当前组织 active 成员，并返回真实服务端消息', async () => {
    const deps = dependencies();
    const result = await executeEnterpriseCollaborationRelay(
      {
        action: 'send_message',
        recipientAccountId: 'peer-1',
        content: '请确认接口评审时间。',
      },
      account,
      deps,
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'peer-1',
      '请确认接口评审时间。',
    );
    expect(result).toMatchObject({
      ok: true,
      action: 'send_message',
      message: { id: 'sent-1' },
    });

    await expect(
      executeEnterpriseCollaborationRelay(
        {
          action: 'send_message',
          recipientAccountId: 'removed-user',
          content: '不能发送',
        },
        account,
        deps,
      ),
    ).rejects.toThrow('不在当前企业组织树');
  });

  it('ask_peer_otto 发送严格协议请求，不能伪造即时回答', async () => {
    const deps = dependencies();
    const result = await executeEnterpriseCollaborationRelay(
      {
        action: 'ask_peer_otto',
        recipientAccountId: 'peer-1',
        question: '今天可以评审吗？',
      },
      account,
      deps,
    );
    const parsed = parseAtoaMessage(deps.sendMessage.mock.calls[0][1]);
    expect(parsed).toMatchObject({
      kind: 'request',
      payload: { mode: 'answer', question: '今天可以评审吗？' },
    });
    expect(result).toMatchObject({
      ok: true,
      action: 'ask_peer_otto',
      status: 'waiting_for_peer_permission',
    });
  });

  it('consult_peer_otto 打开真实双方协商流程，而不是只改消息标签', async () => {
    const deps = dependencies();
    const result = await executeEnterpriseCollaborationRelay(
      {
        action: 'consult_peer_otto',
        recipientAccountId: 'peer-1',
        question: '比较双方日程并协商评审时间',
      },
      account,
      deps,
    );
    expect(deps.requestConsult).toHaveBeenCalledWith(
      organization.members[1],
      '比较双方日程并协商评审时间',
    );
    expect(result).toMatchObject({
      ok: true,
      action: 'consult_peer_otto',
      status: 'waiting_for_peer_permission',
      message: { id: 'consult-1' },
    });
  });

  it('企业管理员可通过真实账号更新接口安排同组织成员的部门与职位', async () => {
    const deps = dependencies();
    const result = await executeEnterpriseCollaborationRelay(
      {
        action: 'assign_member_position',
        recipientAccountId: 'peer-1',
        department: '产品部',
        positionTitle: '产品经理',
        role: '产品负责人',
      },
      { ...account, isAdmin: true },
      deps,
    );

    expect(deps.updateAccount).toHaveBeenCalledWith('peer-1', {
      department: '产品部',
      positionTitle: '产品经理',
      role: '产品负责人',
    });
    expect(result).toMatchObject({
      ok: true,
      action: 'assign_member_position',
      member: {
        id: 'peer-1',
        department: '产品部',
        positionTitle: '产品经理',
        role: '产品负责人',
      },
    });
  });

  it('非管理员不能任命职位，非法字段也不会到达账号更新接口', async () => {
    const deps = dependencies();
    await expect(executeEnterpriseCollaborationRelay(
      {
        action: 'assign_member_position',
        recipientAccountId: 'peer-1',
        department: '产品部',
        positionTitle: '产品经理',
      },
      account,
      deps,
    )).rejects.toThrow('仅企业管理员');
    await expect(executeEnterpriseCollaborationRelay(
      {
        action: 'assign_member_position',
        recipientAccountId: 'peer-1',
        department: '产品部',
        positionTitle: '产品经理',
        isAdmin: true,
      },
      { ...account, isAdmin: true },
      deps,
    )).rejects.toThrow('未知字段');
    expect(deps.updateAccount).not.toHaveBeenCalled();
  });

  it('个人账号和非法参数 fail closed，不调用任何企业 IPC', async () => {
    const deps = dependencies();
    await expect(
      executeEnterpriseCollaborationRelay(
        { action: 'list_members' },
        { ...account, accountType: 'personal' },
        deps,
      ),
    ).rejects.toThrow('仅企业账号');
    await expect(
      executeEnterpriseCollaborationRelay(
        { action: 'ask_peer_otto', recipientAccountId: 'peer-1' },
        account,
        deps,
      ),
    ).rejects.toThrow('question');
    expect(deps.getOrganizationView).not.toHaveBeenCalled();
  });
});
