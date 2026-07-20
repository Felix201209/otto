/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ParkServicesPlugin 单测（v1.6.0 起无悬浮小钮，入口=openParkServices 事件）：
 * 默认不渲染、事件打开、9 项服务 3×3、内置流程可本地演示、三种关闭、
 * 无障碍属性、企业定制覆盖。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, screen, cleanup, act, waitFor } from '@testing-library/react';
import { ParkServicesPlugin, openParkServices } from './ParkServicesPlugin.js';
import type { EnterpriseRepairTicket } from '../../preload/index.js';

afterEach(() => {
  cleanup();
  window.localStorage.removeItem('otto:local-repair-ticket');
  if (window.otto) {
    for (const key of [
      'enterpriseSession', 'enterpriseTicketList', 'enterpriseTicketSubmit',
      'enterpriseTicketAction', 'enterpriseTicketRead', 'parkNativeNotify',
    ]) delete (window.otto as unknown as Record<string, unknown>)[key];
  }
});

/** 监听 Composer 注入事件（insertComposerDraft 派发的 CustomEvent）。 */
function listenDraft(): { texts: string[]; stop: () => void } {
  const texts: string[] = [];
  const handler = (e: Event): void => {
    texts.push((e as CustomEvent<string>).detail);
  };
  window.addEventListener('otto:composer-insert', handler);
  return { texts, stop: () => window.removeEventListener('otto:composer-insert', handler) };
}

/** 经右侧面板同款事件通路打开弹窗。 */
function openDialog(): void {
  act(() => {
    openParkServices();
  });
}

function installRepairBridge(kind: 'reporter' | 'worker' = 'reporter') {
  const account = {
    id: kind === 'worker' ? 'worker-1' : 'reporter-1',
    organizationId: 'org-1', organizationName: '测试园区', employeeId: null,
    username: kind, phone: '+8613800138000', feishuOpenId: 'ou_test',
    name: kind === 'worker' ? '维修张工' : '报修员工', role: '成员', department: 'IT部',
    positionId: null, positionTitle: null,
    isAdmin: false, status: 'active' as const,
    tags: kind === 'worker' ? ['维修工作人员'] : ['普通成员'],
    createdAt: '2026-07-20', updatedAt: '2026-07-20',
  };
  let tickets: EnterpriseRepairTicket[] = kind === 'worker' ? [{
    id: 'ticket-1', title: '某某会议室 · 水电报修', description: '灯坏了',
    targetTags: ['维修工作人员'], status: '待接单', category: '水电', location: '某某会议室',
    urgency: '普通', contact: '报修员工', contactPhone: '13800138000',
    responseType: null, responseText: null, responseAt: null,
    createdAt: '2026-07-20', updatedAt: '2026-07-20',
    creator: { id: 'reporter-1', name: '报修员工', username: 'reporter', phone: '+8613800138000', feishuOpenId: 'ou_reporter' },
    recipientCount: 1, recipients: [account], deliveryStatus: 'delivered', readAt: null,
    isCreator: false, isRecipient: true, notifications: [],
  }] : [];
  const submit = vi.fn(async (input: {
    title: string; description: string; targetTags?: string[]; category?: string;
    location?: string; urgency?: string; contact?: string; contactPhone?: string;
  }) => {
    const ticket = {
      id: 'ticket-new', ...input, status: '待接单', responseType: null, responseText: null,
      responseAt: null, createdAt: '2026-07-20', updatedAt: '2026-07-20',
      creator: { id: account.id, name: account.name, username: account.username, phone: account.phone, feishuOpenId: account.feishuOpenId },
      recipientCount: 1, recipients: [], isCreator: true, isRecipient: false, notifications: [],
    } as EnterpriseRepairTicket;
    tickets = [ticket];
    return ticket;
  });
  const action = vi.fn(async (id: string, input: {
    action: 'respond' | 'accept' | 'complete' | 'confirm';
    responseType?: string; responseText?: string;
  }) => {
    const current = tickets.find((ticket) => ticket.id === id)!;
    const status = input.action === 'accept' ? '维修中'
      : input.action === 'complete' || input.responseType === '已完成维修' ? '待验收'
        : input.action === 'confirm' ? '已完成' : current.status;
    const next = {
      ...current, status, updatedAt: `${Date.now()}`,
      ...(input.action === 'respond' ? { responseType: input.responseType, responseText: input.responseText, responseAt: '2026-07-20T01:00:00Z' } : {}),
    };
    tickets = tickets.map((ticket) => ticket.id === id ? next : ticket);
    return next;
  });
  Object.assign(window.otto, {
    enterpriseSession: vi.fn(async () => ({ serverUrl: 'https://enterprise.test', account })),
    enterpriseTicketList: vi.fn(async () => tickets),
    enterpriseTicketSubmit: submit,
    enterpriseTicketAction: action,
    enterpriseTicketRead: vi.fn(async (id: string) => {
      const next = { ...tickets.find((ticket) => ticket.id === id)!, readAt: '2026-07-20' };
      tickets = tickets.map((ticket) => ticket.id === id ? next : ticket);
      return next;
    }),
    parkNativeNotify: vi.fn(async () => true),
  });
  return { submit, action };
}

describe('ParkServicesPlugin', () => {
  it('默认不渲染任何可见节点（无悬浮小钮，弹窗关闭）', () => {
    const { container } = render(<ParkServicesPlugin />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelector('.otto-park-fab')).toBeNull();
  });

  it('openParkServices 事件打开居中对话框，9 项服务齐全', () => {
    render(<ParkServicesPlugin />);
    openDialog();
    expect(screen.getByRole('dialog')).toBeTruthy();
    for (const name of [
      '装修管理', '满意度调查', '园区公告', '停车位办理', '网络与电话', '会议室预约',
      '电卡充电', '客户报修', '来访车辆',
    ]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(screen.queryByText('行政后勤')).toBeNull();
    expect(screen.queryByText('班车通勤')).toBeNull();
    expect(screen.queryByText('餐饮服务')).toBeNull();
    expect(document.querySelectorAll('.otto-park-service')).toHaveLength(9);
    expect(Array.from(document.querySelectorAll('.otto-park-service__name')).slice(0, 2).map((node) => node.textContent)).toEqual(['园区公告', '满意度调查']);
  });

  it('内置服务先进入本地演示，可把真实填写请求交给 Otto', () => {
    const l = listenDraft();
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('会议室预约'));
    expect(screen.getByLabelText('会议室预约申请表')).toBeTruthy();
    expect(screen.getAllByText('会议服务专员')).toHaveLength(2);
    fireEvent.click(screen.getByText('改用 Otto 填写'));
    expect(l.texts).toHaveLength(1);
    expect(l.texts[0]).toContain('宏创园区会议室');
    expect(screen.queryByRole('dialog')).toBeNull();
    l.stop();
  });

  it('园区公告是接收端：园区发布后右下角弹窗，员工点击查看', () => {
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('园区公告'));
    expect(screen.getByText('本地模拟公告 · Otto 只作为企业接收端')).toBeTruthy();
    expect(screen.getByText('暂无新公告')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '模拟园区发布公告' }));
    expect(screen.getByLabelText('查看园区公告').textContent).toContain('下午临时停水通知');
    fireEvent.click(screen.getByLabelText('查看园区公告'));
    expect(screen.getByText('公告详情')).toBeTruthy();
    expect(screen.getByText('已读回执已记录')).toBeTruthy();
  });

  it('满意度调查是双向流程：园区发布问卷，员工填写并提交', () => {
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('满意度调查'));
    expect(screen.getByText('园区尚未发布问卷。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '模拟发布问卷' }));
    expect(screen.getByText('问卷已发布，等待员工提交。')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('总体满意度'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('重点关注'), { target: { value: '会议室环境' } });
    fireEvent.click(screen.getByRole('button', { name: '提交问卷' }));
    expect(screen.getByText('园区端已收到反馈')).toBeTruthy();
    expect(screen.getByText('4 分 · 会议室环境 · 已进入满意度汇总')).toBeTruthy();
  });

  it('报修通过企业服务器提交并自动投递维修工作人员', async () => {
    const bridge = installRepairBridge('reporter');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('客户报修'));
    const requestForm = await screen.findByLabelText('客户报修申请表');
    expect(screen.getByText('Otto 填报提示')).toBeTruthy();
    fireEvent.submit(requestForm);
    expect(await screen.findByText(/已提交工单 ticket-new/)).toBeTruthy();
    expect(bridge.submit).toHaveBeenCalledWith(expect.objectContaining({ targetTags: ['维修工作人员'] }));
  });

  it('服务器报修类别选择其他时允许填写自定义类别', async () => {
    const bridge = installRepairBridge('reporter');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('客户报修'));
    await screen.findByLabelText('客户报修申请表');
    fireEvent.change(screen.getByLabelText('报修类别'), { target: { value: '其他' } });
    fireEvent.change(screen.getByLabelText('请填写其他类别'), { target: { value: '玻璃门损坏' } });
    fireEvent.submit(screen.getByLabelText('客户报修申请表'));
    await waitFor(() => expect(bridge.submit).toHaveBeenCalledWith(expect.objectContaining({ category: '玻璃门损坏' })));
  });

  it('被管理员指定的维修人员能收到工单并推进状态', async () => {
    const bridge = installRepairBridge('worker');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('客户报修'));
    fireEvent.click(await screen.findByRole('button', { name: /维修工作台/ }));
    expect(screen.getByText('灯坏了')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '接单并处理' }));
    await waitFor(() => expect(bridge.action).toHaveBeenCalledWith('ticket-1', { action: 'accept' }));
    fireEvent.click(screen.getByRole('button', { name: '提交维修完成' }));
    await waitFor(() => expect(bridge.action).toHaveBeenCalledWith('ticket-1', { action: 'complete' }));
  });

  it('维修人员使用结构化回复表，不增加聊天窗口', async () => {
    const bridge = installRepairBridge('worker');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('客户报修'));
    fireEvent.click(await screen.findByRole('button', { name: /维修工作台/ }));
    fireEvent.change(screen.getByLabelText('处理方式'), { target: { value: '远程指导' } });
    fireEvent.change(screen.getByLabelText('给报修人的说明'), { target: { value: '请先检查开关' } });
    fireEvent.submit(screen.getByLabelText('维修回复表'));
    await waitFor(() => expect(bridge.action).toHaveBeenCalledWith('ticket-1', {
      action: 'respond', responseType: '远程指导', responseText: '请先检查开关',
    }));
    expect(screen.queryByPlaceholderText('输入消息')).toBeNull();
  });

  it('其他园区服务使用各自的申请字段和处理选项', () => {
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('装修管理'));
    expect(screen.getByText(/装修申请先核对施工范围/)).toBeTruthy();
    expect(screen.getByLabelText('装修管理申请表')).toBeTruthy();
    expect(screen.getByRole('button', { name: '提交装修管理申请' })).toBeTruthy();
  });

  it('Esc / 点遮罩 / 右上 × 都能关闭', () => {
    render(<ParkServicesPlugin />);

    openDialog();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    openDialog();
    const overlay = document.querySelector('.otto-park-overlay')!;
    fireEvent.mouseDown(overlay);
    expect(screen.queryByRole('dialog')).toBeNull();

    openDialog();
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('无障碍：dialog 具备 aria-modal 且由标题 labelledby（默认品牌名）', () => {
    render(<ParkServicesPlugin />);
    openDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)?.textContent).toBe('宏创AI园区服务');
  });

  it('企业定制：parkConfig 的 brandName/services 覆盖内置默认', async () => {
    const otto = {
      parkConfig: () =>
        Promise.resolve({
          brandName: '星火智慧园区服务',
          services: [{ name: '自定义服务A', desc: '描述A', prompt: '模板A' }],
        }),
    };
    (window as unknown as { otto: typeof otto }).otto = otto;
    try {
      render(<ParkServicesPlugin />);
      openDialog();
      expect(await screen.findByText('星火智慧园区服务')).toBeTruthy();
      expect(screen.getByText('自定义服务A')).toBeTruthy();
      expect(screen.queryByText('装修管理')).toBeNull();
    } finally {
      delete (window as unknown as { otto?: typeof otto }).otto;
    }
  });

  it('企业定制：只给 parkName 时默认服务换园区称呼', async () => {
    const otto = {
      parkConfig: () => Promise.resolve({ parkName: '星火园区' }),
    };
    (window as unknown as { otto: typeof otto }).otto = otto;
    try {
      const l = listenDraft();
      render(<ParkServicesPlugin />);
      openDialog();
      await screen.findByText('会议室预约');
      fireEvent.click(screen.getByText('会议室预约'));
      fireEvent.click(screen.getByText('改用 Otto 填写'));
      await new Promise((r) => setTimeout(r, 0));
      expect(l.texts[0]).toContain('星火园区会议室');
      l.stop();
    } finally {
      delete (window as unknown as { otto?: typeof otto }).otto;
    }
  });
});
