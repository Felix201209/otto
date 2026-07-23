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
import type { EnterpriseParkPublication, EnterpriseRepairTicket } from '../../preload/index.js';

afterEach(() => {
  cleanup();
  window.localStorage.removeItem('otto:local-repair-ticket');
  if (window.otto) {
    for (const key of [
      'enterpriseSession', 'enterpriseTicketList', 'enterpriseTicketSubmit',
      'enterpriseTicketAction', 'enterpriseTicketRead', 'parkNativeNotify',
      'notificationShow', 'notificationMarkRead',
      'enterpriseParkPublications', 'enterpriseParkPublicationRead', 'enterpriseParkSurveySubmit',
      'enterpriseParkView', 'parkConfig',
    ]) delete (window.otto as unknown as Record<string, unknown>)[key];
  }
});

/** 经右侧面板同款事件通路打开弹窗。 */
function openDialog(): void {
  act(() => {
    openParkServices();
  });
}

function installRepairBridge(kind: 'reporter' | 'worker' = 'reporter', ticketCount = 1) {
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
  const workerTickets = Array.from({ length: ticketCount }, (_, index): EnterpriseRepairTicket => {
    const location = index === 0 ? '某某会议室' : 'A 座大厅';
    const category = index === 0 ? '水电' : '空调';
    const issue = index === 0 ? '灯坏了' : '空调漏水';
    return {
      id: `ticket-${index + 1}`, serviceId: 'repair', title: `${location} · ${category}报修`, description: issue,
      formData: { location, category, issue, urgency: '普通', contact: '报修员工', phone: '13800138000' },
      targetTags: ['维修工作人员'], status: '待接单', category, location,
      urgency: '普通', contact: '报修员工', contactPhone: '13800138000',
      responseType: null, responseText: null, responseAt: null,
      createdAt: '2026-07-20', updatedAt: '2026-07-20',
      creator: { id: 'reporter-1', name: '报修员工', username: 'reporter' },
      recipientCount: 1, recipients: [{ id: account.id, name: account.name }], deliveryStatus: 'delivered', readAt: null,
      isCreator: false, isRecipient: true, notifications: [],
    };
  });
  let tickets: EnterpriseRepairTicket[] = kind === 'worker' ? workerTickets : [];
  const submit = vi.fn(async (input: {
    serviceId?: string; title: string; description: string; targetTags?: string[]; formData?: Record<string, string>; category?: string;
    location?: string; urgency?: string; contact?: string; contactPhone?: string;
  }) => {
    const ticket = {
      id: 'ticket-new', ...input, status: '待接单', responseType: null, responseText: null,
      responseAt: null, createdAt: '2026-07-20', updatedAt: '2026-07-20',
      creator: { id: account.id, name: account.name, username: account.username },
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
    notificationShow: vi.fn(async () => undefined),
    notificationMarkRead: vi.fn(async () => undefined),
    enterpriseParkPublications: vi.fn(async () => []),
  });
  return { submit, action };
}

function installPublicationBridge(kind: 'announcement' | 'satisfaction') {
  const account = {
    id: 'reporter-1', organizationId: 'org-1', organizationName: '测试园区', employeeId: null,
    username: 'reporter', phone: '+8613800138000', feishuOpenId: 'ou_test', name: '报修员工',
    role: '成员', department: '行政部', positionId: null, positionTitle: null,
    isAdmin: false, status: 'active' as const, tags: ['普通成员'], createdAt: '2026-07-20', updatedAt: '2026-07-20',
  };
  let items: EnterpriseParkPublication[] = [{
    id: `publication-${kind}`, kind,
    title: kind === 'announcement' ? '下午临时停水通知' : '第三季度满意度调查',
    body: kind === 'announcement' ? '今天 14:00–16:00 园区停水，请提前准备。' : '请评价本季度园区服务。',
    createdAt: '2026-07-20T08:00:00Z', readAt: null, submittedAt: null, responseData: null,
  }];
  const read = vi.fn(async (id: string) => {
    const next = { ...items.find((item) => item.id === id)!, readAt: '2026-07-20T08:01:00Z' };
    items = items.map((item) => item.id === id ? next : item);
    return next;
  });
  const submit = vi.fn(async (id: string, responseData: Record<string, string>) => {
    const next = { ...items.find((item) => item.id === id)!, readAt: '2026-07-20T08:01:00Z', submittedAt: '2026-07-20T08:02:00Z', responseData };
    items = items.map((item) => item.id === id ? next : item);
    return next;
  });
  Object.assign(window.otto, {
    enterpriseSession: vi.fn(async () => ({ serverUrl: 'https://enterprise.test', account })),
    enterpriseParkPublications: vi.fn(async () => items),
    enterpriseParkPublicationRead: read,
    enterpriseParkSurveySubmit: submit,
    parkNativeNotify: vi.fn(async () => true),
  });
  return { read, submit };
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

  it('中心接口返回 null 时表示未加入园区，不回退本机配置也不允许事件打开', async () => {
    const enterpriseParkView = vi.fn(async () => null);
    const parkConfig = vi.fn(async () => ({ brandName: '旧本机宏创园区服务' }));
    Object.assign(window.otto, { enterpriseParkView, parkConfig });
    render(<ParkServicesPlugin />);

    await waitFor(() => expect(enterpriseParkView).toHaveBeenCalledOnce());
    openDialog();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(parkConfig).not.toHaveBeenCalled();
  });

  it('中心园区请求失败时 fail closed，不展示陈旧本机品牌', async () => {
    const enterpriseParkView = vi.fn(async () => {
      throw new Error('园区服务暂时不可用');
    });
    const parkConfig = vi.fn(async () => ({ brandName: '陈旧宏创园区服务' }));
    Object.assign(window.otto, { enterpriseParkView, parkConfig });
    render(<ParkServicesPlugin />);

    await waitFor(() => expect(enterpriseParkView).toHaveBeenCalledOnce());
    openDialog();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(parkConfig).not.toHaveBeenCalled();
  });

  it('普通用户只看到真实申请表，不出现后台人员或模拟入口', async () => {
    installRepairBridge('reporter');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('会议室预约'));
    expect(await screen.findByLabelText('会议室预约申请表')).toBeTruthy();
    expect(screen.queryByText(/本地模拟/)).toBeNull();
    expect(screen.queryByText(/张工|维修工作台|园区端/)).toBeNull();
  });

  it('园区公告只显示服务器发布的内容，并记录已读', async () => {
    const bridge = installPublicationBridge('announcement');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('园区公告'));
    const item = await screen.findByRole('button', { name: /下午临时停水通知/ });
    fireEvent.click(item);
    await waitFor(() => expect(bridge.read).toHaveBeenCalledWith('publication-announcement'));
    expect(screen.queryByText(/模拟发布/)).toBeNull();
  });

  it('满意度调查实名提交一次，界面不包含发布端', async () => {
    const bridge = installPublicationBridge('satisfaction');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('满意度调查'));
    await screen.findByLabelText('员工填写满意度调查');
    fireEvent.change(screen.getByLabelText('总体满意度'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('重点关注'), { target: { value: '会议室环境' } });
    fireEvent.change(screen.getByLabelText('改进建议'), { target: { value: '希望加强巡检' } });
    fireEvent.click(screen.getByRole('button', { name: '提交问卷' }));
    await waitFor(() => expect(bridge.submit).toHaveBeenCalledWith('publication-satisfaction', expect.objectContaining({ score: '4', focus: '会议室环境', submittedBy: '报修员工' })));
    expect((await screen.findByRole('button', { name: '已实名提交，不能修改' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/模拟发布|园区端/)).toBeNull();
  });

  it('报修通过企业服务器提交并自动投递维修工作人员', async () => {
    const bridge = installRepairBridge('reporter');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('客户报修'));
    const requestForm = await screen.findByLabelText('客户报修申请表');
    expect((screen.getByLabelText('故障位置') as HTMLInputElement).value).toBe('');
    fireEvent.submit(requestForm);
    expect(await screen.findByText(/申请已提交，园区服务中心正在安排工作人员/)).toBeTruthy();
    expect(bridge.submit).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'repair' }));
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

  it('维修人员从右下角待办提醒直接进入处理表，不显示角色切换', async () => {
    const bridge = installRepairBridge('worker');
    render(<ParkServicesPlugin />);
    await waitFor(() => expect(window.otto.notificationShow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'park:ticket:ticket-1',
      source: 'park',
    })));
    fireEvent.click(await screen.findByLabelText(/打开园区服务通知/));
    expect(await screen.findByText('灯坏了')).toBeTruthy();
    expect(screen.queryByText(/维修工作台|我要报修/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '接单并处理' }));
    await waitFor(() => expect(bridge.action).toHaveBeenCalledWith('ticket-1', { action: 'accept' }));
    fireEvent.click(screen.getByRole('button', { name: '提交办理完成' }));
    await waitFor(() => expect(bridge.action).toHaveBeenCalledWith('ticket-1', { action: 'complete' }));
  });

  it('多个报修待办不会重合，每个工单都有独立系统通知和可点击入口', async () => {
    installRepairBridge('worker', 2);
    render(<ParkServicesPlugin />);

    const toasts = await screen.findAllByLabelText(/打开园区服务通知/);
    expect(toasts).toHaveLength(2);
    expect(window.otto.notificationShow).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'park-ticket:ticket-1:2026-07-20',
      sessionId: 'park:ticket:ticket-1',
      source: 'park',
      title: 'Otto 待处理提醒 · 园区服务',
    }));
    expect(window.otto.notificationShow).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'park-ticket:ticket-2:2026-07-20',
      sessionId: 'park:ticket:ticket-2',
      source: 'park',
      title: 'Otto 待处理提醒 · 园区服务',
    }));

    fireEvent.click(screen.getByLabelText(/A 座大厅/));
    expect(await screen.findByText('空调漏水')).toBeTruthy();
    expect(window.otto.notificationMarkRead).toHaveBeenCalledWith('park:ticket:ticket-2');
  });

  it('工作人员关闭通知后仍可从九宫格上方找回自己的待办，普通用户看不到该入口', async () => {
    installRepairBridge('worker');
    render(<ParkServicesPlugin />);
    openDialog();
    const task = await screen.findByRole('button', { name: /打开工作人员待办：某某会议室/ });
    expect(screen.getByText(/仅工作人员可见/)).toBeTruthy();
    fireEvent.click(task);
    expect(await screen.findByLabelText('园区服务回复表')).toBeTruthy();

    cleanup();
    installRepairBridge('reporter');
    render(<ParkServicesPlugin />);
    openDialog();
    await waitFor(() => expect(window.otto.enterpriseTicketList).toHaveBeenCalled());
    expect(screen.queryByLabelText('我的园区待办')).toBeNull();
  });

  it('维修人员使用结构化回复表，不增加聊天窗口', async () => {
    const bridge = installRepairBridge('worker');
    render(<ParkServicesPlugin />);
    fireEvent.click(await screen.findByLabelText(/打开园区服务通知/));
    fireEvent.change(await screen.findByLabelText('处理方式'), { target: { value: '远程指导' } });
    fireEvent.change(screen.getByLabelText('给申请人的说明'), { target: { value: '请先检查开关' } });
    fireEvent.submit(screen.getByLabelText('园区服务回复表'));
    await waitFor(() => expect(bridge.action).toHaveBeenCalledWith('ticket-1', {
      action: 'respond', responseType: '远程指导', responseText: '请先检查开关',
    }));
    expect(screen.queryByPlaceholderText('输入消息')).toBeNull();
  });

  it('其他园区服务使用各自的真实空白申请表', async () => {
    installRepairBridge('reporter');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('装修管理'));
    expect(await screen.findByLabelText('装修管理申请表')).toBeTruthy();
    expect(screen.getByText(/客户只需如实填写并提交申请单/)).toBeTruthy();
    expect((screen.getByLabelText('装修区域') as HTMLInputElement).value).toBe('');
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
    expect(document.getElementById(labelledBy)?.textContent).toBe('园区服务');
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
      enterpriseSession: () => Promise.resolve({ serverUrl: 'https://enterprise.test', account: null }),
      enterpriseTicketList: () => Promise.resolve([]),
      enterpriseParkPublications: () => Promise.resolve([]),
    };
    (window as unknown as { otto: typeof otto }).otto = otto;
    try {
      render(<ParkServicesPlugin />);
      openDialog();
      await screen.findByText('会议室预约');
      fireEvent.click(screen.getByText('会议室预约'));
      expect(await screen.findByText('请先登录企业账号。')).toBeTruthy();
      expect(screen.queryByText(/本地演示|改用 Otto 填写/)).toBeNull();
    } finally {
      delete (window as unknown as { otto?: typeof otto }).otto;
    }
  });
});
