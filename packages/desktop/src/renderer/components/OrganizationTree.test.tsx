/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProductWorkspaceSnapshot } from 'otto-server';
import type { EnterpriseAccount, EnterpriseDirectMessage } from '../../preload/index.js';
import {
  DirectMessagePanel,
  OrganizationTree,
  parseDirectMessageTimestamp,
} from './OrganizationTree.js';

const askLocalPeerOttoMock = vi.hoisted(() => vi.fn(async () => '本机 Otto 给出的建议。'));

vi.mock('../peerOttoRunner.js', async () => {
  const actual = await vi.importActual<typeof import('../peerOttoRunner.js')>(
    '../peerOttoRunner.js',
  );
  return {
    ...actual,
    askLocalPeerOtto: askLocalPeerOttoMock,
  };
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const workspace: ProductWorkspaceSnapshot = {
  schemaVersion: 1,
  context: {
    edition: 'enterprise', role: 'company_owner', userId: 'u1', companyId: 'c1',
    departmentId: 'd1', positionId: 'p1', capabilities: ['organization:read'],
  },
  managerWorkspace: {
    profile: {
      managerId: 'u1', managerName: 'Felix', companyName: '北辰科技',
      createdAt: '2026-07-11T00:00:00.000Z',
    },
    context: {
      edition: 'enterprise', role: 'company_owner', userId: 'u1',
      companyId: 'c1', capabilities: ['organization:read'],
    },
    organization: {
      rootCompanyId: 'c1',
      companies: [{ id: 'c1', name: '北辰科技', ownerUserId: 'u1' }],
      departments: [{ id: 'd1', companyId: 'c1', name: 'CEO 办公室' }],
      positions: [{ id: 'p1', companyId: 'c1', departmentId: 'd1', title: 'CEO', incumbentUserId: 'u1' }],
    },
  },
  members: [{
    userId: 'u1', displayName: 'Felix', companyId: 'c1', departmentId: 'd1',
    positionId: 'p1', role: 'company_owner',
  }],
  friends: [],
  credits: { balance: 0, frozen: 0, status: 'design-preview' },
};

const memberWorkspace: ProductWorkspaceSnapshot = {
  ...workspace,
  context: {
    ...workspace.context,
    role: 'member',
    capabilities: ['organization:read'],
  },
  managerWorkspace: undefined,
  members: [],
};

const personalWorkspace: ProductWorkspaceSnapshot = {
  ...workspace,
  context: {
    edition: 'personal',
    role: 'personal',
    userId: 'local-user',
    capabilities: ['agent:base'],
  },
  managerWorkspace: undefined,
  members: [],
};

const authenticatedEnterpriseAccount: EnterpriseAccount = {
  id: 'acc_1',
  organizationId: 'org_acme',
  organizationName: '星河科技',
  employeeId: null,
  username: 'staff01',
  phone: '+8613800138000',
  name: '员工一号',
  role: '工程师',
  department: '研发部',
  positionId: null,
  positionTitle: null,
  isAdmin: false,
  status: 'active',
  tags: [],
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
};

const internalTestAccount: EnterpriseAccount = {
  ...authenticatedEnterpriseAccount,
  id: 'local_internal_test',
  organizationId: 'local-internal-test',
  organizationName: '内部测试',
  username: 'internal-test',
  phone: null,
  name: '内部测试',
  role: '测试成员',
  department: '内部测试',
};

function ensureOrganizationTreeOpen(): HTMLElement {
  const toggle = screen.getByRole('button', { name: '企业组织' });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  return toggle;
}

function ensureDepartmentOpen(name: string): HTMLElement {
  const toggle = screen.getByRole('button', { name });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  return toggle;
}

describe('OrganizationTree', () => {
  it('allows the user to explicitly reset an active MLS private-chat session', async () => {
    const enterpriseMessagesList = vi.fn(async (): Promise<EnterpriseDirectMessage[]> => [
      {
        id: 'mls-message-1',
        senderAccountId: 'acc_1',
        recipientAccountId: 'acc_2',
        content: '加密消息',
        createdAt: '2026-08-03T00:00:00.000Z',
        readAt: null,
        e2ee: true,
        e2eeProtocol: 'mls10-openmls-0.8',
      },
    ]);
    const enterpriseMessageSecurityReset = vi.fn(async () => undefined);
    Object.assign(window.otto, {
      enterpriseMessagesList,
      enterpriseMessageSecurityReset,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <DirectMessagePanel
        member={{
          id: 'acc_2',
          username: 'bob',
          name: 'Bob',
          role: 'Manager',
          department: 'R&D',
          isAdmin: false,
          status: 'active',
        }}
        currentAccount={authenticatedEnterpriseAccount}
        initialPosition={{ left: 0, top: 0 }}
        stackOrder={1}
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '重置加密会话' }));

    await waitFor(() =>
      expect(enterpriseMessageSecurityReset).toHaveBeenCalledWith('acc_2'),
    );
    expect((await screen.findByRole('status')).textContent).toContain(
      '加密会话已重置',
    );
  });

  it('treats SQLite chat timestamps without a timezone as UTC', () => {
    expect(
      parseDirectMessageTimestamp('2026-07-28 03:51:00').toISOString(),
    ).toBe('2026-07-28T03:51:00.000Z');
    expect(
      parseDirectMessageTimestamp('2026-07-28T11:51:00+08:00').toISOString(),
    ).toBe('2026-07-28T03:51:00.000Z');
  });
  it('默认展示公司和一级部门，仍可手动收起整棵组织树', () => {
    render(<OrganizationTree workspace={workspace} />);
    const toggle = screen.getByRole('button', { name: '企业组织' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('北辰科技')).toBeTruthy();
    expect(screen.getByText('CEO 办公室')).toBeTruthy();
    expect(screen.getByText('Felix')).toBeTruthy();
    expect(screen.getAllByText('CEO').length).toBeGreaterThan(0);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('北辰科技')).toBeNull();
  });

  it('右栏请求打开组织树时展开左侧真实组织入口', () => {
    const { rerender } = render(
      <OrganizationTree workspace={workspace} openRequest={0} />,
    );
    const toggle = screen.getByRole('button', { name: '企业组织' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    rerender(<OrganizationTree workspace={workspace} openRequest={1} />);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('北辰科技')).toBeTruthy();
  });

  it('成员视图挂载即通过 preload 加载组织架构，并正确显示 loading 和数据', async () => {
    let resolveOrganization!: (value: {
      organization: { id: string; name: string; status: 'active'; createdAt: string };
      members: Array<{
        id: string; username: string; name: string; role: string;
        department: string; isAdmin: boolean; status: 'active';
      }>;
      employeeCount: number;
    }) => void;
    const pending = new Promise<Parameters<typeof resolveOrganization>[0]>((resolve) => {
      resolveOrganization = resolve;
    });
    const enterpriseOrganizationView = vi.fn(() => pending);
    Object.assign(window.otto, { enterpriseOrganizationView });

    render(
      <OrganizationTree
        workspace={memberWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );
    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());

    ensureOrganizationTreeOpen();
    expect(screen.getByText('正在加载组织信息…')).toBeTruthy();

    resolveOrganization({
      organization: {
        id: 'org_acme',
        name: '星河科技',
        status: 'active',
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_1',
        username: 'staff01',
        name: '员工一号',
        role: '工程师',
        department: '研发部',
        isAdmin: false,
        status: 'active',
      }],
      employeeCount: 1,
    });

    expect(await screen.findByText('星河科技')).toBeTruthy();
    expect(screen.getByText('研发部')).toBeTruthy();
    expect(screen.getByText('员工一号')).toBeTruthy();
    expect(screen.getByText('工程师')).toBeTruthy();
  });

  it('远程组织树优先显示邀请码分配的职位，而不是泛化角色', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: '星河科技',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_2',
        username: 'brand.operator',
        name: '小周',
        role: '成员',
        department: '市场部',
        positionId: 'pos_brand',
        positionTitle: '品牌运营',
        avatarUrl: null,
        isAdmin: true,
        status: 'active' as const,
      }],
      employeeCount: 1,
    }));
    Object.assign(window.otto, { enterpriseOrganizationView });

    render(
      <OrganizationTree
        workspace={personalWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );
    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    ensureOrganizationTreeOpen();
    ensureDepartmentOpen('市场部');

    expect(await screen.findByText('品牌运营')).toBeTruthy();
    expect(screen.queryByText('成员')).toBeNull();
    expect(screen.queryByText('管理员')).toBeNull();
  });

  it('组织架构请求失败时结束 loading 并显示明确错误', async () => {
    const enterpriseOrganizationView = vi.fn(async () => {
      throw new Error('服务器暂不可用');
    });
    Object.assign(window.otto, { enterpriseOrganizationView });

    render(
      <OrganizationTree
        workspace={memberWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );
    ensureOrganizationTreeOpen();

    expect(await screen.findByText('组织信息加载失败：服务器暂不可用')).toBeTruthy();
    expect(screen.queryByText('正在加载组织信息…')).toBeNull();
    expect(enterpriseOrganizationView).toHaveBeenCalledOnce();
  });

  it('邀请码认证后的真实企业账号可从默认个人工作区连接远程组织树', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: '星河科技',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_1',
        username: 'staff01',
        name: '员工一号',
        role: '工程师',
        department: '研发部',
        isAdmin: false,
        status: 'active' as const,
      }],
      employeeCount: 1,
    }));
    Object.assign(window.otto, { enterpriseOrganizationView });

    render(
      <OrganizationTree
        workspace={personalWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    ensureOrganizationTreeOpen();
    expect(await screen.findByText('星河科技')).toBeTruthy();
    expect(screen.getByText('研发部')).toBeTruthy();
    expect(screen.getByText('员工一号')).toBeTruthy();
  });

  it('本地 ProductWorkspace 尚未连接时，真实企业账号仍可加载远程组织树', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: '星河科技',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_1',
        username: 'staff01',
        name: '员工一号',
        role: '工程师',
        department: '研发部',
        isAdmin: false,
        status: 'active' as const,
      }],
      employeeCount: 1,
    }));
    Object.assign(window.otto, { enterpriseOrganizationView });

    render(
      <OrganizationTree
        workspace={null}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    ensureOrganizationTreeOpen();
    expect(await screen.findByText('星河科技')).toBeTruthy();
  });

  it('默认免登录的本地测试身份不会冒充企业账号或触发组织请求', () => {
    const enterpriseOrganizationView = vi.fn();
    Object.assign(window.otto, { enterpriseOrganizationView });

    const { container } = render(
      <OrganizationTree
        workspace={personalWorkspace}
        enterpriseAccount={internalTestAccount}
      />,
    );

    expect(container.innerHTML).toBe('');
    expect(enterpriseOrganizationView).not.toHaveBeenCalled();
  });

  it('真实企业账号覆盖机器上残留的本机企业树，以服务端组织为权威', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: '服务端星河科技',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_1',
        username: 'staff01',
        name: '员工一号',
        role: '工程师',
        department: '研发部',
        isAdmin: false,
        status: 'active' as const,
      }],
      employeeCount: 1,
    }));
    Object.assign(window.otto, { enterpriseOrganizationView });

    render(
      <OrganizationTree
        workspace={workspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    ensureOrganizationTreeOpen();
    expect(await screen.findByText('服务端星河科技')).toBeTruthy();
    expect(screen.queryByText('北辰科技')).toBeNull();
  });

  it('CEO 保存职位后按修订号重新读取服务端组织树', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme', name: '星河科技', status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [],
      employeeCount: 0,
    }));
    Object.assign(window.otto, { enterpriseOrganizationView });

    const { rerender } = render(
      <OrganizationTree
        workspace={null}
        enterpriseAccount={authenticatedEnterpriseAccount}
        refreshRevision={0}
      />,
    );
    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());

    rerender(
      <OrganizationTree
        workspace={null}
        enterpriseAccount={authenticatedEnterpriseAccount}
        refreshRevision={1}
      />,
    );

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledTimes(2));
  });

  it('员工收到后台身份更新后按 updatedAt 重新读取服务端组织树', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme', name: '星河科技', status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [],
      employeeCount: 0,
    }));
    Object.assign(window.otto, { enterpriseOrganizationView });

    const { rerender } = render(
      <OrganizationTree
        workspace={null}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );
    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());

    rerender(
      <OrganizationTree
        workspace={null}
        enterpriseAccount={{
          ...authenticatedEnterpriseAccount,
          department: '产品部',
          positionTitle: '产品经理',
          updatedAt: '2026-07-20T12:00:00.000Z',
        }}
      />,
    );

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledTimes(2));
  });

  it('本机企业成员只有内测假身份时不调用远程接口', () => {
    const enterpriseOrganizationView = vi.fn();
    Object.assign(window.otto, { enterpriseOrganizationView });

    render(
      <OrganizationTree
        workspace={memberWorkspace}
        enterpriseAccount={internalTestAccount}
      />,
    );
    ensureOrganizationTreeOpen();

    expect(enterpriseOrganizationView).not.toHaveBeenCalled();
    expect(screen.getByText('已通过链接加入；组织详情将在企业服务同步后显示。'))
      .toBeTruthy();
  });

  it('真实企业组织树会定时刷新，新成员无需重启即可出现', async () => {
    vi.useFakeTimers();
    const organization = {
      id: 'org_acme',
      name: 'Acme',
      status: 'active' as const,
      createdAt: '2026-07-13T00:00:00.000Z',
    };
    const enterpriseOrganizationView = vi.fn()
      .mockResolvedValueOnce({
        organization,
        members: [{
          id: 'acc_1',
          username: 'alice',
          name: 'Alice',
          role: 'Engineer',
          department: 'R&D',
          isAdmin: false,
          status: 'active' as const,
        }],
        employeeCount: 1,
      })
      .mockResolvedValue({
        organization,
        members: [{
          id: 'acc_1',
          username: 'alice',
          name: 'Alice',
          role: 'Engineer',
          department: 'R&D',
          isAdmin: false,
          status: 'active' as const,
        }, {
          id: 'acc_2',
          username: 'bob',
          name: 'Bob',
          role: 'Designer',
          department: 'R&D',
          isAdmin: false,
          status: 'active' as const,
        }],
        employeeCount: 2,
      });
    Object.assign(window.otto, { enterpriseOrganizationView });

    try {
      render(
        <OrganizationTree
          workspace={personalWorkspace}
          enterpriseAccount={authenticatedEnterpriseAccount}
        />,
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(enterpriseOrganizationView).toHaveBeenCalledOnce();
      ensureOrganizationTreeOpen();
      expect(screen.getByText('Alice')).toBeTruthy();
      expect(screen.queryByText('Bob')).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
      });

      expect(screen.getByText('Bob')).toBeTruthy();
      expect(enterpriseOrganizationView).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('真实企业组织树支持自定义部门名称，并可折叠部门节点', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: 'Acme',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_1',
        username: 'alice',
        name: 'Alice',
        role: 'Engineer',
        department: 'Skunkworks Lab',
        isAdmin: false,
        status: 'active' as const,
      }, {
        id: 'acc_2',
        username: 'bob',
        name: 'Bob',
        role: 'Finance',
        department: '财务部',
        isAdmin: false,
        status: 'active' as const,
      }],
      employeeCount: 2,
    }));
    Object.assign(window.otto, { enterpriseOrganizationView });

    render(
      <OrganizationTree
        workspace={personalWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    ensureOrganizationTreeOpen();
    const department = await screen.findByRole('button', { name: 'Skunkworks Lab' });
    const otherDepartment = screen.getByRole('button', { name: '财务部' });
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(department.getAttribute('aria-expanded')).toBe('true');
    expect(otherDepartment.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Bob')).toBeNull();

    fireEvent.click(department);

    expect(department.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Alice')).toBeNull();
  });

  it('can ask Otto from a direct chat with recent messages', async () => {
    const messages: EnterpriseDirectMessage[] = [{
      id: 'dm_1',
      senderAccountId: 'acc_2',
      recipientAccountId: 'acc_1',
      content: 'Please help review the proposal today.',
      createdAt: '2026-07-19T09:00:00.000Z',
      readAt: null,
    }, {
      id: 'dm_2',
      senderAccountId: 'acc_1',
      recipientAccountId: 'acc_2',
      content: 'I will prepare a short version first.',
      createdAt: '2026-07-19T09:03:00.000Z',
      readAt: null,
    }];
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: 'Acme',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_1',
        username: 'alice',
        name: 'Alice',
        role: 'Engineer',
        department: 'R&D',
        isAdmin: false,
        status: 'active' as const,
      }, {
        id: 'acc_2',
        username: 'bob',
        name: 'Bob',
        role: 'Manager',
        department: 'R&D',
        isAdmin: false,
        status: 'active' as const,
        ottoOnline: true,
        ottoLastSeenAt: '2026-07-23T06:00:00.000Z',
      }],
      employeeCount: 2,
    }));
    const enterpriseMessagesList = vi.fn(async () => messages);
    const enterpriseMessageSend = vi.fn(async (_peerAccountId: string, content: string) => ({
      id: 'dm_own_otto',
      senderAccountId: 'acc_1',
      recipientAccountId: 'acc_2',
      content,
      createdAt: '2026-07-19T09:10:00.000Z',
      readAt: null,
    }));
    Object.assign(window.otto, {
      enterpriseOrganizationView,
      enterpriseMessagesList,
      enterpriseMessageSend,
    });

    render(
      <OrganizationTree
        workspace={personalWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    ensureOrganizationTreeOpen();
    ensureDepartmentOpen('R&D');
    fireEvent.click(await screen.findByText('Bob'));
    expect(await screen.findByText('Please help review the proposal today.')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Please help review the proposal today.' },
    });

    fireEvent.click(screen.getByRole('button', { name: '问 Otto' }));

    await waitFor(() => expect(askLocalPeerOttoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Please help review the proposal today.',
      }),
    ));
    expect(enterpriseMessageSend).toHaveBeenCalledWith(
      'acc_2',
      expect.stringContaining('我问了自己的 Otto（基于：我的 Otto 可用资料）'),
    );
    expect(enterpriseMessageSend).toHaveBeenCalledWith(
      'acc_2',
      expect.stringContaining('本机 Otto 给出的建议。'),
    );
  });

  it('shows unread direct-message counts on enterprise members and clears them when opening chat', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: 'Acme',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_1',
        username: 'alice',
        name: 'Alice',
        role: 'Engineer',
        department: 'R&D',
        isAdmin: false,
        status: 'active' as const,
      }, {
        id: 'acc_2',
        username: 'bob',
        name: 'Bob',
        role: 'Manager',
        department: 'R&D',
        isAdmin: false,
        status: 'active' as const,
        ottoOnline: true,
        ottoLastSeenAt: '2026-07-23T06:00:00.000Z',
      }],
      employeeCount: 2,
    }));
    const onMessageRead = vi.fn();
    const enterpriseMessagesList = vi.fn(async () => []);
    Object.assign(window.otto, {
      enterpriseOrganizationView,
      enterpriseMessagesList,
    });

    render(
      <OrganizationTree
        workspace={personalWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
        unreadCounts={{ 'enterprise:message:acc_2': 3 }}
        onMessageRead={onMessageRead}
      />,
    );

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    ensureOrganizationTreeOpen();
    expect(await screen.findByLabelText('3 条未读消息')).toBeTruthy();
    expect(await screen.findByText('在线')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Bob/ }));
    expect(onMessageRead).toHaveBeenCalledWith('acc_2');
    await waitFor(() => expect(enterpriseMessagesList).toHaveBeenCalledWith('acc_2'));
    expect(await screen.findByText('还没有消息，开始聊聊吧。')).toBeTruthy();
  });

  it('同时保留多个同事聊天窗口，并让每个窗口独立最小化、最大化、还原、拖动和关闭', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: 'Acme',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_1',
        username: 'alice',
        name: 'Alice',
        role: 'Engineer',
        department: 'R&D',
        isAdmin: false,
        status: 'active' as const,
      }, {
        id: 'acc_2',
        username: 'bob',
        name: 'Bob',
        role: 'Manager',
        department: 'R&D',
        isAdmin: false,
        status: 'active' as const,
      }, {
        id: 'acc_3',
        username: 'carol',
        name: 'Carol',
        role: 'Designer',
        department: 'Design',
        isAdmin: false,
        status: 'active' as const,
      }],
      employeeCount: 3,
    }));
    const onMessageRead = vi.fn();
    Object.assign(window.otto, {
      enterpriseOrganizationView,
      enterpriseMessagesList: vi.fn(async () => []),
    });

    render(
      <OrganizationTree
        workspace={personalWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
        onMessageRead={onMessageRead}
      />,
    );

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    ensureOrganizationTreeOpen();
    ensureDepartmentOpen('R&D');
    fireEvent.click(await screen.findByRole('button', { name: /Bob/ }));
    ensureDepartmentOpen('Design');
    fireEvent.click(await screen.findByRole('button', { name: /Carol/ }));

    const bobChat = await screen.findByRole('dialog', { name: '与 Bob 聊天' });
    const carolChat = await screen.findByRole('dialog', { name: '与 Carol 聊天' });
    expect(onMessageRead.mock.calls).toEqual([['acc_2'], ['acc_3']]);

    fireEvent.change(within(bobChat).getByRole('textbox', { name: '消息内容' }), {
      target: { value: '只属于 Bob 的草稿' },
    });
    expect(
      (within(carolChat).getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).value,
    ).toBe('');

    fireEvent.click(within(bobChat).getByRole('button', { name: '最小化聊天' }));
    expect(bobChat.classList.contains('is-minimized')).toBe(true);
    expect(carolChat.classList.contains('is-minimized')).toBe(false);

    fireEvent.click(within(bobChat).getByRole('button', { name: '最大化聊天' }));
    expect(bobChat.classList.contains('is-minimized')).toBe(false);
    expect(bobChat.classList.contains('is-maximized')).toBe(true);
    fireEvent.click(within(bobChat).getByRole('button', { name: '还原聊天' }));
    expect(bobChat.classList.contains('is-maximized')).toBe(false);

    const header = bobChat.querySelector('.otto-direct-chat__header') as HTMLElement;
    const leftBeforeDrag = bobChat.style.left;
    const topBeforeDrag = bobChat.style.top;
    const firePointer = (type: string, clientX: number, clientY: number): void => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
      Object.defineProperty(event, 'pointerId', { value: 7 });
      fireEvent(header, event);
    };
    firePointer('pointerdown', 300, 100);
    firePointer('pointermove', 360, 150);
    firePointer('pointerup', 360, 150);
    expect(bobChat.style.left).not.toBe(leftBeforeDrag);
    expect(bobChat.style.top).not.toBe(topBeforeDrag);

    fireEvent.click(within(bobChat).getByRole('button', { name: '关闭聊天' }));
    expect(screen.queryByRole('dialog', { name: '与 Bob 聊天' })).toBeNull();
    expect(screen.getByRole('dialog', { name: '与 Carol 聊天' })).toBeTruthy();
  });

  it('打开聊天及轮询到新消息后滚到最新消息，并为对应同事续清未读', async () => {
    const oldMessage: EnterpriseDirectMessage = {
      id: 'dm_old',
      senderAccountId: 'acc_2',
      recipientAccountId: 'acc_1',
      content: '旧消息',
      createdAt: '2026-07-27T08:00:00.000Z',
      readAt: '2026-07-27T08:01:00.000Z',
    };
    const newMessage: EnterpriseDirectMessage = {
      id: 'dm_new',
      senderAccountId: 'acc_2',
      recipientAccountId: 'acc_1',
      content: '轮询到的新消息',
      createdAt: '2026-07-27T08:02:00.000Z',
      readAt: null,
    };
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: 'Acme',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_1',
        username: 'alice',
        name: 'Alice',
        role: 'Engineer',
        department: 'R&D',
        isAdmin: false,
        status: 'active' as const,
      }, {
        id: 'acc_2',
        username: 'bob',
        name: 'Bob',
        role: 'Manager',
        department: 'R&D',
        isAdmin: false,
        status: 'active' as const,
      }],
      employeeCount: 2,
    }));
    const enterpriseMessagesList = vi.fn()
      .mockResolvedValueOnce([oldMessage])
      .mockResolvedValue([oldMessage, newMessage]);
    const onMessageRead = vi.fn();
    const scrollIntoView = vi.fn();
    const intervals: Array<{ callback: () => void; delay: number }> = [];
    vi.spyOn(window, 'setInterval').mockImplementation((handler, delay) => {
      intervals.push({
        callback: handler as () => void,
        delay: Number(delay),
      });
      return intervals.length as unknown as ReturnType<typeof window.setInterval>;
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    Object.assign(window.otto, {
      enterpriseOrganizationView,
      enterpriseMessagesList,
    });

    render(
      <OrganizationTree
        workspace={personalWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
        onMessageRead={onMessageRead}
      />,
    );

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    ensureOrganizationTreeOpen();
    fireEvent.click(await screen.findByRole('button', { name: /Bob/ }));
    expect(await screen.findByText('旧消息')).toBeTruthy();
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
      expect(onMessageRead).toHaveBeenCalledTimes(1);
    });

    scrollIntoView.mockClear();
    const messagePoll = intervals.find((interval) => interval.delay === 2_000);
    expect(messagePoll).toBeTruthy();
    await act(async () => {
      messagePoll!.callback();
    });

    expect(await screen.findByText('轮询到的新消息')).toBeTruthy();
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
      expect(onMessageRead).toHaveBeenCalledTimes(2);
    });
    expect(onMessageRead).toHaveBeenLastCalledWith('acc_2');

    scrollIntoView.mockClear();
    await act(async () => {
      messagePoll!.callback();
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('从托盘未读消息请求直接打开对应同事会话', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: 'Acme',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_1',
        username: 'alice',
        name: 'Alice',
        role: 'Engineer',
        department: 'R&D',
        isAdmin: false,
        status: 'active' as const,
      }, {
        id: 'acc_2',
        username: 'bob',
        name: 'Bob',
        role: 'Manager',
        department: 'R&D',
        isAdmin: false,
        status: 'active' as const,
      }],
      employeeCount: 2,
    }));
    const enterpriseMessagesList = vi.fn(async () => []);
    const onMessageRead = vi.fn();
    Object.assign(window.otto, {
      enterpriseOrganizationView,
      enterpriseMessagesList,
    });

    render(
      <OrganizationTree
        workspace={personalWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
        directChatOpenRequest={{ peerAccountId: 'acc_2', requestId: 1 }}
        onMessageRead={onMessageRead}
      />,
    );

    await waitFor(() => expect(enterpriseMessagesList).toHaveBeenCalledWith('acc_2'));
    expect(onMessageRead).toHaveBeenCalledWith('acc_2');
    expect(await screen.findByText('还没有消息，开始聊聊吧。')).toBeTruthy();
  });

  it('支持选择 PDF 附件并在无文字时直接发送', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: 'Acme',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_2',
        username: 'bob',
        name: 'Bob',
        role: 'Manager',
        department: 'R&D',
        isAdmin: false,
        status: 'active' as const,
      }],
      employeeCount: 1,
    }));
    const enterpriseMessageSend = vi.fn(async (
      _peerAccountId: string,
      content: string,
      attachments: Array<{ fileName: string; mimeType: string; size: number; data: string }>,
    ): Promise<EnterpriseDirectMessage> => ({
      id: 'dm_attachment',
      senderAccountId: 'acc_1',
      recipientAccountId: 'acc_2',
      content: content || '分享了 1 个文件：方案.pdf',
      createdAt: '2026-07-26T08:00:00.000Z',
      readAt: null,
      attachments: [{ id: 'attachment-1', ...attachments[0]! }],
    }));
    Object.assign(window.otto, {
      enterpriseOrganizationView,
      enterpriseMessagesList: vi.fn(async () => []),
      enterpriseMessageSend,
      selectFiles: vi.fn(async () => ['C:\\docs\\方案.pdf']),
      readFilePath: vi.fn(async () => ({
        filePath: 'C:\\docs\\方案.pdf',
        fileName: '方案.pdf',
        size: 4,
        mimeType: 'application/pdf',
        data: 'JVBERg==',
      })),
    });

    render(
      <OrganizationTree
        workspace={personalWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );
    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    ensureOrganizationTreeOpen();
    ensureDepartmentOpen('R&D');
    fireEvent.click(await screen.findByText('Bob'));
    await screen.findByText('还没有消息，开始聊聊吧。');

    fireEvent.click(screen.getByRole('button', { name: '添加文件或图片' }));
    expect(await screen.findByText('方案.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(enterpriseMessageSend).toHaveBeenCalledWith(
      'acc_2',
      '',
      [{
        fileName: '方案.pdf',
        mimeType: 'application/pdf',
        size: 4,
        data: 'JVBERg==',
      }],
    ));
    expect(await screen.findByRole('button', { name: '下载 方案.pdf' })).toBeTruthy();
  });

  it('summarizes enterprise Otto presence, refreshes on demand, and keeps online members easy to find', async () => {
    let calls = 0;
    const enterpriseOrganizationView = vi.fn(async () => {
      calls += 1;
      return {
        organization: {
          id: 'org_acme',
          name: 'Acme',
          status: 'active' as const,
          createdAt: '2026-07-13T00:00:00.000Z',
        },
        members: [{
          id: 'acc_1',
          username: 'alice',
          name: 'Alice',
          role: 'Engineer',
          department: 'R&D',
          isAdmin: false,
          status: 'active' as const,
        }, {
          id: 'acc_2',
          username: 'zara',
          name: 'Zara',
          role: 'Designer',
          department: 'R&D',
          isAdmin: false,
          status: 'active' as const,
          ottoOnline: false,
          ottoLastSeenAt: '2026-07-23T05:55:00.000Z',
        }, {
          id: 'acc_3',
          username: 'bob',
          name: 'Bob',
          role: 'Manager',
          department: 'R&D',
          isAdmin: false,
          status: 'active' as const,
          ottoOnline: true,
          ottoLastSeenAt: '2026-07-23T06:00:00.000Z',
        }],
        employeeCount: 3,
      };
    });
    Object.assign(window.otto, { enterpriseOrganizationView });

    render(
      <OrganizationTree
        workspace={personalWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    ensureOrganizationTreeOpen();
    expect(await screen.findByText('1/3 在线')).toBeTruthy();
    expect(screen.getByRole('button', { name: '刷新企业组织在线状态' })).toBeTruthy();
    const bob = await screen.findByRole('button', { name: /Bob/ });
    const zara = await screen.findByRole('button', { name: /Zara/ });
    expect(screen.getByText('Manager')).toBeTruthy();
    expect(screen.getByText('Designer')).toBeTruthy();
    expect(bob.closest('.otto-orgtree__position-group')?.textContent).toContain('Manager');
    expect(zara.closest('.otto-orgtree__position-group')?.textContent).toContain('Designer');

    fireEvent.click(screen.getByRole('button', { name: '刷新企业组织在线状态' }));
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
  });

  it('uses @otto as a direct-chat shortcut instead of sending it as a message', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: 'Acme',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_2',
        username: 'bob',
        name: 'Bob',
        role: 'Manager',
        department: 'R&D',
        isAdmin: false,
        status: 'active' as const,
      }],
      employeeCount: 1,
    }));
    const enterpriseMessagesList = vi.fn(async () => []);
    const enterpriseMessageSend = vi.fn(async (_peerAccountId: string, content: string) => ({
      id: 'dm_own_otto',
      senderAccountId: 'acc_1',
      recipientAccountId: 'acc_2',
      content,
      createdAt: '2026-07-19T09:10:00.000Z',
      readAt: null,
    }));
    Object.assign(window.otto, {
      enterpriseOrganizationView,
      enterpriseMessagesList,
      enterpriseMessageSend,
    });

    render(
      <OrganizationTree
        workspace={personalWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    ensureOrganizationTreeOpen();
    ensureDepartmentOpen('R&D');
    fireEvent.click(await screen.findByText('Bob'));
    await waitFor(() => expect(enterpriseMessagesList).toHaveBeenCalledWith('acc_2'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '@otto summarize action items' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(askLocalPeerOttoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'summarize action items',
      }),
    ));
    expect(enterpriseMessageSend).toHaveBeenCalledWith(
      'acc_2',
      expect.stringContaining('我问了自己的 Otto'),
    );
  });

  it('sends a peer Otto request as a structured direct message', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: 'Acme',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_2',
        username: 'bob',
        name: 'Bob',
        role: 'Manager',
        department: 'R&D',
        isAdmin: false,
        status: 'active' as const,
      }],
      employeeCount: 1,
    }));
    const enterpriseMessagesList = vi.fn(async () => []);
    const enterpriseMessageSend = vi.fn(async (_peerAccountId: string, content: string) => ({
      id: 'dm_atoa',
      senderAccountId: 'acc_1',
      recipientAccountId: 'acc_2',
      content,
      createdAt: '2026-07-19T09:10:00.000Z',
      readAt: null,
    }));
    Object.assign(window.otto, {
      enterpriseOrganizationView,
      enterpriseMessagesList,
      enterpriseMessageSend,
    });

    render(
      <OrganizationTree
        workspace={personalWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    ensureOrganizationTreeOpen();
    ensureDepartmentOpen('R&D');
    fireEvent.click(await screen.findByText('Bob'));
    await waitFor(() => expect(enterpriseMessagesList).toHaveBeenCalledWith('acc_2'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Are you free now?' } });
    fireEvent.click(screen.getByRole('button', { name: '问对方 Otto' }));

    await waitFor(() => expect(enterpriseMessageSend).toHaveBeenCalledOnce());
    expect(enterpriseMessageSend.mock.calls[0][0]).toBe('acc_2');
    expect(enterpriseMessageSend.mock.calls[0][1]).toContain('OTTO_ATOA_REQUEST ');
    expect(await screen.findByText(/向对方 Otto 提问：Are you free now\?/)).toBeTruthy();
  });

  it('把低频双方 Otto 协商折叠在加号里，并在发送前打开资料选择与提案预览流程', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: 'Acme',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [
        {
          id: 'acc_2',
          username: 'bob',
          name: 'Bob',
          role: 'Manager',
          department: 'R&D',
          isAdmin: false,
          status: 'active' as const,
        },
      ],
      employeeCount: 1,
    }));
    Object.assign(window.otto, {
      enterpriseOrganizationView,
      enterpriseMessagesList: vi.fn(async () => []),
    });

    render(
      <OrganizationTree
        workspace={personalWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );
    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    ensureOrganizationTreeOpen();
    ensureDepartmentOpen('R&D');
    fireEvent.click(await screen.findByText('Bob'));
    await screen.findByText('还没有消息，开始聊聊吧。');

    expect(screen.queryByRole('menuitem', { name: /双方 Otto 协商/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '更多 Otto 协作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /双方 Otto 协商/ }));

    expect(
      screen.getByRole('dialog', { name: '双方 Otto 协商' }),
    ).toBeTruthy();
    expect(screen.getByText(/默认不选/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '让我的 Otto 生成提案' })).toBeTruthy();
  });
});
