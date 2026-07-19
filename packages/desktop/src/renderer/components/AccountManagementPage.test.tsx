/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_TAG_PRESETS,
  AccountManagementPage,
  applyAccountTemplate,
  formatInviteRemaining,
  toggleAccountTag,
} from './AccountManagementPage.js';

const ADMIN = {
  id: 'acc_admin', organizationId: 'org_acme', organizationName: '星河科技',
  employeeId: null, username: 'admin', phone: '+8613800138000', name: '管理员',
  role: '企业管理员', department: 'IT部', isAdmin: true, status: 'active' as const,
  positionId: null, positionTitle: null,
  tags: ['企业管理员'], createdAt: '2026-07-14', updatedAt: '2026-07-14',
  usage: {
    accountId: 'acc_admin', inputTokens: 700, outputTokens: 534, totalTokens: 1234,
    requestCount: 7, lastUsedAt: '2026-07-15T08:30:00.000Z',
  },
};

const INVITE = {
  id: 'invite_1', organizationId: 'org_acme', code: 'ABCD-EFGH',
  link: 'https://59.110.154.44:7777/enterprise/join/ABCD-EFGH', status: 'active' as const,
  defaultDepartment: null,
  departmentId: null, positionId: null, positionTitle: null, defaultRole: null,
  maxUses: null, usedCount: 0,
  issuedAt: '2026-07-14T00:00:00.000Z', expiresAt: '2099-07-14T05:00:00.000Z',
  validHours: 168 as const,
};

const clipboardWrite = vi.fn(async () => undefined);

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const CREATED_ACCOUNT = {
  ...ADMIN,
  id: 'acc_new',
  username: 'new.member',
  name: '新成员',
  isAdmin: false,
  usage: {
    accountId: 'acc_new', inputTokens: 0, outputTokens: 0, totalTokens: 0,
    requestCount: 0, lastUsedAt: null,
  },
};

beforeEach(() => {
  clipboardWrite.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
  Object.defineProperty(window, 'otto', {
    configurable: true,
    value: {
      enterpriseAccounts: vi.fn(async () => [ADMIN]),
      enterpriseOrganizationInviteGet: vi.fn(async () => ({
        organization: { id: 'org_acme', name: '星河科技' }, invite: INVITE,
      })),
      enterpriseOrganizationInviteIssue: vi.fn(async () => ({
        organization: { id: 'org_acme', name: '星河科技' },
        invite: {
          ...INVITE, id: 'invite_2', code: 'WXYZ-2345',
          link: 'https://59.110.154.44:7777/enterprise/join/WXYZ-2345',
        },
      })),
      enterpriseAccountCreate: vi.fn(async () => CREATED_ACCOUNT),
      enterpriseAccountUpdate: vi.fn(async (_id, input) => ({ ...ADMIN, ...input })),
    } as unknown as Window['otto'],
  });
});

async function readyCreateButton(): Promise<HTMLButtonElement> {
  const button = screen.getByRole('button', { name: '新增账号' }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

describe('企业账号模板与标签预设', () => {
  it('套用 IT 支持模板时一次填好角色、部门与职责标签', () => {
    expect(applyAccountTemplate({
      username: '', password: '', name: '', phone: '', role: '', department: '', tags: '',
      isAdmin: false, status: 'active',
    }, 'it-support')).toMatchObject({
      role: 'IT 支持',
      department: 'IT部',
      tags: 'IT，报修，技术支持',
      isAdmin: false,
    });
  });

  it('预设标签可以无重复地选中和取消', () => {
    expect(ACCOUNT_TAG_PRESETS).toContain('普通成员');
    expect(toggleAccountTag('普通成员，IT', 'IT')).toBe('普通成员');
    expect(toggleAccountTag('普通成员', '审批')).toBe('普通成员，审批');
  });
});

describe('企业引入链接', () => {
  it('倒计时文案精确到秒，失效后明确提示管理员换新', () => {
    expect(formatInviteRemaining('2026-07-14T05:00:00.000Z', Date.parse('2026-07-14T00:00:01.000Z')))
      .toBe('4 小时 59 分 59 秒后失效');
    expect(formatInviteRemaining('2026-07-14T05:00:00.000Z', Date.parse('2026-07-14T05:00:00.000Z')))
      .toBe('已失效，请生成新链接');
  });

  it('管理员可复制完整链接或邀请码，并手动生成会立即替换旧链接', async () => {
    render(<AccountManagementPage currentAccount={ADMIN} onBack={() => undefined} />);

    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '复制完整引入链接' }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(
      'https://59.110.154.44:7777/enterprise/join/ABCD-EFGH',
    ));
    fireEvent.click(screen.getByRole('button', { name: '复制企业邀请码' }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith('ABCD-EFGH'));

    fireEvent.click(screen.getByRole('button', { name: '生成新引入链接' }));
    expect(await screen.findByText('WXYZ-2345')).toBeTruthy();
    expect(screen.queryByText('ABCD-EFGH')).toBeNull();
  });

  it('读取当前链接完成前禁止生成，避免晚返回的 GET 覆盖新 POST', async () => {
    const pending = deferred<{
      organization: { id: string; name: string };
      invite: typeof INVITE;
    }>();
    const issue = vi.fn(async () => ({
      organization: { id: 'org_acme', name: '星河科技' },
      invite: { ...INVITE, id: 'invite_new', code: 'NEW1-2345' },
    }));
    Object.assign(window.otto, {
      enterpriseOrganizationInviteGet: vi.fn(() => pending.promise),
      enterpriseOrganizationInviteIssue: issue,
    });

    render(<AccountManagementPage currentAccount={ADMIN} onBack={() => undefined} />);

    const generate = screen.getByRole('button', { name: '生成 7 天引入链接' }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    fireEvent.click(generate);
    expect(issue).not.toHaveBeenCalled();

    await act(async () => pending.resolve({
      organization: { id: 'org_acme', name: '星河科技' },
      invite: INVITE,
    }));
    await waitFor(() => expect(
      (screen.getByRole('button', { name: '生成新引入链接' }) as HTMLButtonElement).disabled,
    ).toBe(false));
  });
});

describe('企业账号目录', () => {
  it('初始目录仍在加载时锁定新增入口，避免晚到 GET 覆盖新建成员', async () => {
    const pending = deferred<typeof ADMIN[]>();
    Object.assign(window.otto, { enterpriseAccounts: vi.fn(() => pending.promise) });
    render(<AccountManagementPage currentAccount={ADMIN} onBack={() => undefined} />);

    const create = screen.getByRole('button', { name: '新增账号' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(create);
    expect(screen.queryByRole('dialog')).toBeNull();

    await act(async () => pending.resolve([ADMIN]));
    await waitFor(() => expect(create.disabled).toBe(false));
  });

  it('清理 Electron IPC 技术前缀，只向管理员显示服务端错误', async () => {
    Object.assign(window.otto, {
      enterpriseAccounts: vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'otto:enterprise-accounts': Error: 登录已失效，请重新登录",
        );
      }),
    });
    render(<AccountManagementPage currentAccount={ADMIN} onBack={() => undefined} />);

    expect((await screen.findByRole('alert')).textContent).toBe('登录已失效，请重新登录');
  });

  it('明确披露 Token 用量是客户端回传观察值，不冒充供应商账单', async () => {
    render(<AccountManagementPage currentAccount={ADMIN} onBack={() => undefined} />);
    expect(screen.getByText(/Token 用量由客户端回传/)).toBeTruthy();
    expect(screen.getByText(/不等同于模型供应商账单/)).toBeTruthy();
    await screen.findByRole('table', { name: '账号列表' });
  });

  it('使用原生表格语义展示账号用量与最后使用时间', async () => {
    render(<AccountManagementPage currentAccount={ADMIN} onBack={() => undefined} />);

    expect(await screen.findByRole('table', { name: '账号列表' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '成员' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: /1,234 tokens/ })).toBeTruthy();
    expect(screen.getByText('7 次请求')).toBeTruthy();
    expect(screen.getByText(/最后使用/).getAttribute('title')).toBe('2026-07-15T08:30:00.000Z');
  });

  it('创建失败后保留填写内容并允许原地重试', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('账号已存在'))
      .mockResolvedValueOnce(CREATED_ACCOUNT);
    Object.assign(window.otto, { enterpriseAccountCreate: create });
    render(<AccountManagementPage currentAccount={ADMIN} onBack={() => undefined} />);

    const trigger = await readyCreateButton();
    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole('textbox', { name: '登录账号' }), { target: { value: 'new.member' } });
    fireEvent.change(screen.getByRole('textbox', { name: '显示名称' }), { target: { value: '新成员' } });
    fireEvent.change(screen.getByLabelText('初始密码'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: '保存身份' }));

    expect((await screen.findByRole('alert')).textContent).toContain('账号已存在');
    expect((screen.getByRole('textbox', { name: '登录账号' }) as HTMLInputElement).value).toBe('new.member');

    fireEvent.click(screen.getByRole('button', { name: '保存身份' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('新成员')).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('更新失败后保留修改并允许重试，不会把旧账号数据写回表格', async () => {
    const updated = { ...ADMIN, name: '新管理员名称' };
    const update = vi.fn()
      .mockRejectedValueOnce(new Error('会话暂时不可用'))
      .mockResolvedValueOnce(updated);
    Object.assign(window.otto, { enterpriseAccountUpdate: update });
    render(<AccountManagementPage currentAccount={ADMIN} onBack={() => undefined} />);

    fireEvent.click(await screen.findByRole('button', { name: '编辑 管理员' }));
    fireEvent.change(screen.getByRole('textbox', { name: '显示名称' }), {
      target: { value: '新管理员名称' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存身份' }));

    expect((await screen.findByRole('alert')).textContent).toContain('会话暂时不可用');
    expect((screen.getByRole('textbox', { name: '显示名称' }) as HTMLInputElement).value)
      .toBe('新管理员名称');

    fireEvent.click(screen.getByRole('button', { name: '保存身份' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('button', { name: '编辑 新管理员名称' })).toBeTruthy();
    expect(update).toHaveBeenCalledTimes(2);
  });
});

describe('账号编辑弹窗', () => {
  it('初始聚焦表单，限制 Tab 焦点，Escape 关闭并恢复触发按钮焦点', async () => {
    const { container } = render(<AccountManagementPage currentAccount={ADMIN} onBack={() => undefined} />);
    const trigger = await readyCreateButton();
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: '新增账号' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '登录账号' })));
    const background = container.querySelector('.otto-account-page__content');
    expect(background?.getAttribute('aria-hidden')).toBe('true');
    expect(background?.hasAttribute('inert')).toBe(true);

    const close = screen.getByRole('button', { name: '关闭' });
    const cancel = screen.getByRole('button', { name: '取消' });
    close.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(background?.hasAttribute('aria-hidden')).toBe(false);
    expect(background?.hasAttribute('inert')).toBe(false);
  });

  it('保存期间禁止 X、Escape 和背景点击关闭，完成后才关闭并恢复焦点', async () => {
    const pending = deferred<typeof CREATED_ACCOUNT>();
    Object.assign(window.otto, { enterpriseAccountCreate: vi.fn(() => pending.promise) });
    render(<AccountManagementPage currentAccount={ADMIN} onBack={() => undefined} />);

    const trigger = await readyCreateButton();
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole('textbox', { name: '登录账号' }), { target: { value: 'new.member' } });
    fireEvent.change(screen.getByRole('textbox', { name: '显示名称' }), { target: { value: '新成员' } });
    fireEvent.change(screen.getByLabelText('初始密码'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: '保存身份' }));

    const dialog = screen.getByRole('dialog', { name: '新增账号' });
    const close = screen.getByRole('button', { name: '关闭' });
    expect((close as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.getByRole('dialog', { name: '新增账号' })).toBeTruthy();

    await act(async () => pending.resolve(CREATED_ACCOUNT));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
