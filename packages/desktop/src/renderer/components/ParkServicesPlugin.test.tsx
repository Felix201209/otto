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
import { render, fireEvent, screen, cleanup, act, waitFor, within } from '@testing-library/react';
import {
  ParkServicesPlugin,
  effectiveMeetingSlotStatus,
  isActionableStaffTicket,
  isMeetingSlotPast,
  isStaffHistoryTicket,
  openParkServices,
  serviceFormFields,
} from './ParkServicesPlugin.js';
import type { EnterpriseAccount, EnterpriseParkPublication, EnterpriseRepairTicket } from '../../preload/index.js';

afterEach(() => {
  cleanup();
  window.localStorage.removeItem('otto:local-repair-ticket');
  if (window.otto) {
    for (const key of [
      'enterpriseSession', 'enterpriseTicketList', 'enterpriseTicketSubmit',
      'enterpriseTicketAction', 'enterpriseTicketRead', 'parkNativeNotify',
      'notificationShow', 'notificationMarkRead', 'onNotificationSessionOpen',
      'enterpriseParkPublications', 'enterpriseParkPublicationRead', 'enterpriseParkSurveySubmit',
      'enterpriseParkView', 'enterpriseParkStatistics', 'enterpriseParkResources',
      'enterpriseOrganizationView', 'parkConfig',
    ]) delete (window.otto as unknown as Record<string, unknown>)[key];
  }
});

/** 经右侧面板同款事件通路打开弹窗。 */
function openDialog(): void {
  act(() => {
    openParkServices();
  });
}


function installRepairBridge(kind: 'reporter' | 'worker' = 'reporter', ticketCount = 1, statuses: string[] = []) {
  const account: EnterpriseAccount = {
    id: kind === 'worker' ? 'worker-1' : 'reporter-1',
    organizationId: 'org-1', organizationName: '测试企业', employeeId: null,
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
      id: `ticket-${index + 1}`, applicationNumber: `20260720${String(index + 1).padStart(3, '0')}`,
      serviceId: 'repair', title: `${location} · ${category}报修`, description: issue,
      formData: {
        company: '测试企业', roomNumber: '1203 室', contact: '报修员工', phone: '13800138000',
        category, issue, urgency: '普通',
      },
      targetTags: ['维修工作人员'], status: statuses[index] ?? '待接单', category, location,
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
      id: 'ticket-new', applicationNumber: '20260720009', ...input,
      status: '待接单', responseType: null, responseText: null,
      responseAt: null, createdAt: '2026-07-20', updatedAt: '2026-07-20',
      creator: { id: account.id, name: account.name, username: account.username },
      recipientCount: 1, recipients: [], isCreator: true, isRecipient: false, notifications: [],
    } as EnterpriseRepairTicket;
    tickets = [ticket];
    return ticket;
  });
  const action = vi.fn(async (id: string, input: {
    action: 'respond' | 'accept' | 'complete' | 'confirm' | 'respond_and_transfer';
    responseType?: string; responseText?: string;
    transferDepartment?: string; transferNote?: string;
  }) => {
    const current = tickets.find((ticket) => ticket.id === id)!;
    const status = input.action === 'accept' ? '维修中'
      : input.action === 'respond_and_transfer' ? '已转交'
      : input.action === 'complete' || input.responseType === '已完成维修' ? '待验收'
        : input.action === 'confirm' ? '已完成' : current.status;
    const next = {
      ...current, status, updatedAt: `${Date.now()}`,
      ...(['respond', 'respond_and_transfer'].includes(input.action)
        ? { responseType: input.responseType, responseText: input.responseText, responseAt: '2026-07-20T01:00:00Z' }
        : {}),
    };
    tickets = tickets.map((ticket) => ticket.id === id ? next : ticket);
    return next;
  });
  const read = vi.fn(async (id: string) => {
    const current = tickets.find((ticket) => ticket.id === id)!;
    const next = current.isCreator
      ? { ...current, creatorUpdateReadAt: current.creatorUpdateAt || current.responseAt || '2026-07-20T01:00:00Z' }
      : { ...current, readAt: '2026-07-20T01:00:00Z' };
    tickets = tickets.map((ticket) => ticket.id === id ? next : ticket);
    return next;
  });
  const notificationSessionListeners = new Set<(sessionId: string) => void>();
  const onNotificationSessionOpen = vi.fn((listener: (sessionId: string) => void) => {
    notificationSessionListeners.add(listener);
    return () => { notificationSessionListeners.delete(listener); };
  });
  Object.assign(window.otto, {
    enterpriseParkView: vi.fn(async () => ({
      id: 'park-1',
      name: '测试园区',
      slug: 'test-park',
      brandName: '测试园区服务',
      adminOrganizationId: 'park-org',
      status: 'active' as const,
      createdAt: '2026-07-20',
      updatedAt: '2026-07-20',
      isAdminOrganization: false,
      tenantAddress: '科技大厦 A 座',
      tenantRoomNumber: '1203 室',
    })),
    enterpriseSession: vi.fn(async () => ({ serverUrl: 'https://enterprise.test', account })),
    enterpriseTicketList: vi.fn(async () => tickets),
    enterpriseTicketSubmit: submit,
    enterpriseTicketAction: action,
    enterpriseTicketRead: read,
    enterpriseOrganizationView: vi.fn(async () => ({
      organization: {
        id: 'org-1', name: '测试企业', status: 'active' as const, parkId: 'park-1', createdAt: '2026-07-20',
      },
      members: [
        {
          id: account.id, username: account.username, name: account.name, role: account.role,
          department: account.department, isAdmin: false, status: 'active' as const,
        },
        {
          id: 'engineer-1', username: 'engineer', name: '工程李工', role: '成员',
          department: '工程部', isAdmin: false, status: 'active' as const,
        },
      ],
      employeeCount: 2,
    })),
    parkNativeNotify: vi.fn(async () => true),
    notificationShow: vi.fn(async () => undefined),
    notificationMarkRead: vi.fn(async () => undefined),
    onNotificationSessionOpen,
    enterpriseParkPublications: vi.fn(async () => []),
  });
  const setTickets = (next: EnterpriseRepairTicket[]): void => { tickets = next; };
  return {
    submit, action, read, account,
    getTickets: () => tickets,
    setTickets,
    openSystemNotification: (sessionId: string) => {
      for (const listener of notificationSessionListeners) listener(sessionId);
    },
  };
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
    recipientCount: 4, readCount: 0,
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
    enterpriseParkView: vi.fn(async () => ({
      id: 'park-1',
      name: '测试园区',
      slug: 'test-park',
      brandName: '测试园区服务',
      adminOrganizationId: 'park-org',
      status: 'active' as const,
      createdAt: '2026-07-20',
      updatedAt: '2026-07-20',
      isAdminOrganization: false,
      tenantAddress: '科技大厦 A 座',
      tenantRoomNumber: '1203 室',
    })),
    enterpriseParkPublications: vi.fn(async () => items),
    enterpriseParkPublicationRead: read,
    enterpriseParkSurveySubmit: submit,
    parkNativeNotify: vi.fn(async () => true),
  });
  return { read, submit };
}

describe('ParkServicesPlugin', () => {
  it('已转出的原客服只保留历史，新接收人进入待办', () => {
    const ticket = {
      status: '已转交', deliveryStatus: 'transferred', isRecipient: true,
    } as EnterpriseRepairTicket;
    expect(isActionableStaffTicket(ticket)).toBe(false);
    expect(isStaffHistoryTicket(ticket)).toBe(true);
    expect(isActionableStaffTicket({ ...ticket, deliveryStatus: 'delivered' })).toBe(true);
  });

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
      '装修管理', '满意度调查', '园区公告', '停车办理', '网络与电话', '会议室预约',
      '电卡服务', '物业报修', '车辆与访客',
    ]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(screen.queryByText('行政后勤')).toBeNull();
    expect(screen.queryByText('班车通勤')).toBeNull();
    expect(screen.queryByText('餐饮服务')).toBeNull();
    expect(document.querySelectorAll('.otto-park-service')).toHaveLength(9);
    expect(Array.from(document.querySelectorAll('.otto-park-service__name')).slice(0, 2).map((node) => node.textContent)).toEqual(['园区公告', '满意度调查']);
  });

  it('园区窗口支持最小化、最大化还原和拖动', () => {
    render(<ParkServicesPlugin />);
    openDialog();

    fireEvent.click(screen.getByRole('button', { name: '最小化园区服务窗口' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '还原园区服务窗口' }));

    const dialog = screen.getByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: '最大化园区服务窗口' }));
    expect(dialog.classList.contains('is-maximized')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '还原园区服务窗口' }));
    expect(dialog.classList.contains('is-maximized')).toBe(false);

    const header = dialog.querySelector('.otto-park-dialog__head') as HTMLElement;
    const pointerEvent = (type: string, x: number, y: number): Event => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, {
        pointerId: { value: 1 },
        button: { value: 0 },
        clientX: { value: x },
        clientY: { value: y },
      });
      return event;
    };
    act(() => {
      fireEvent(header, pointerEvent('pointerdown', 100, 100));
      fireEvent(header, pointerEvent('pointermove', 145, 125));
      fireEvent(header, pointerEvent('pointerup', 145, 125));
    });
    expect(dialog.getAttribute('style')).toContain('translate(45px, 25px)');
  });

  it('可以同时打开多个园区服务窗口，并分别最小化和继续办理', () => {
    render(<ParkServicesPlugin />);
    openDialog();

    fireEvent.click(within(screen.getByLabelText('园区服务列表')).getByRole('button', { name: /装修管理/ }));
    const renovationDialog = screen.getByRole('dialog', { name: '装修管理' });

    openDialog();
    fireEvent.click(within(screen.getByLabelText('园区服务列表')).getByRole('button', { name: /停车办理/ }));
    const parkingDialog = screen.getByRole('dialog', { name: '停车办理' });

    expect(renovationDialog).toBeTruthy();
    expect(parkingDialog).toBeTruthy();
    fireEvent.click(within(renovationDialog).getByRole('button', { name: '最小化装修管理窗口' }));
    expect(screen.queryByRole('dialog', { name: '装修管理' })).toBeNull();
    expect(screen.getByRole('dialog', { name: '停车办理' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '还原装修管理窗口' })).toBeTruthy();
  });

  it('中心接口返回 null 时不显示宏创园区面板，也不回退旧本机品牌', async () => {
    const enterpriseParkView = vi.fn(async () => null);
    const parkConfig = vi.fn(async () => ({ brandName: '旧本机宏创园区服务' }));
    Object.assign(window.otto, { enterpriseParkView, parkConfig });
    render(<ParkServicesPlugin />);

    await waitFor(() => expect(enterpriseParkView).toHaveBeenCalledOnce());
    openDialog();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('宏创园区服务')).toBeNull();
    expect(screen.queryByText('旧本机宏创园区服务')).toBeNull();
    expect(parkConfig).not.toHaveBeenCalled();
  });

  it('中心园区请求失败时不显示宏创园区面板，不展示陈旧本机品牌', async () => {
    const enterpriseParkView = vi.fn(async () => {
      throw new Error('园区服务暂时不可用');
    });
    const parkConfig = vi.fn(async () => ({ brandName: '陈旧宏创园区服务' }));
    Object.assign(window.otto, { enterpriseParkView, parkConfig });
    render(<ParkServicesPlugin />);

    await waitFor(() => expect(enterpriseParkView).toHaveBeenCalledOnce());
    openDialog();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('宏创园区服务')).toBeNull();
    expect(screen.queryByText('陈旧宏创园区服务')).toBeNull();
    expect(parkConfig).not.toHaveBeenCalled();
  });

  it('产业园管理方可查看总量并展开企业的七类服务使用次数', async () => {
    const enterpriseParkView = vi.fn(async () => ({
      id: 'park-admin-1',
      name: '星河产业园',
      slug: 'star-park',
      brandName: '星河园区服务',
      adminOrganizationId: 'park-admin-org',
      status: 'active' as const,
      createdAt: '2026-07-20T08:00:00Z',
      updatedAt: '2026-07-20T08:00:00Z',
      isAdminOrganization: true,
    }));
    const services = [
      { serviceId: 'renovation', name: '装修管理', count: 1 },
      { serviceId: 'parking', name: '停车办理', count: 1 },
      { serviceId: 'network-phone', name: '网络与电话', count: 1 },
      { serviceId: 'meeting-room', name: '会议室预约', count: 3 },
      { serviceId: 'electric-card', name: '电卡服务', count: 1 },
      { serviceId: 'repair', name: '物业报修', count: 1 },
      { serviceId: 'vehicle-visit', name: '车辆与访客', count: 4 },
    ].map((service) => ({
      ...service,
      amountCny: service.serviceId === 'parking' ? 260 : 0,
      recurringMonthlyCny: service.serviceId === 'parking' ? 260 : 0,
      firstUsedAt: '2026-07-19T09:00:00Z',
      lastUsedAt: '2026-07-20T09:20:00Z',
    }));
    const enterpriseParkStatistics = vi.fn(async () => ({
      parkId: 'park-admin-1',
      parkName: '星河产业园',
      generatedAt: '2026-07-20T09:30:00Z',
      organizationCount: 2,
      activeOrganizationCount: 2,
      totalServiceUses: 12,
      totalAmountCny: 260,
      recurringMonthlyCny: 260,
      vehicleVisits: 4,
      meetingRoomBookings: 3,
      firstUsedAt: '2026-07-19T09:00:00Z',
      lastUsedAt: '2026-07-20T09:20:00Z',
      services,
      organizations: [{
        organizationId: 'tenant-star',
        name: '星河科技',
        slug: 'star-tech',
        status: 'active' as const,
        address: '科技大厦 A 座',
        roomNumber: '1203 室',
        totalUses: 12,
        totalAmountCny: 260,
        recurringMonthlyCny: 260,
        vehicleVisits: 4,
        meetingRoomBookings: 3,
        firstUsedAt: '2026-07-19T09:00:00Z',
        lastUsedAt: '2026-07-20T09:20:00Z',
        services,
      }],
    }));
    Object.assign(window.otto, { enterpriseParkView, enterpriseParkStatistics });

    render(<ParkServicesPlugin />);
    await waitFor(() => expect(enterpriseParkView).toHaveBeenCalledOnce());
    openDialog();

    const statisticsPanel = await screen.findByLabelText('产业园服务统计');
    expect(enterpriseParkStatistics).toHaveBeenCalledOnce();
    expect(statisticsPanel.textContent).toContain('入驻企业2');
    expect(statisticsPanel.textContent).toContain('服务使用12');
    expect(statisticsPanel.textContent).toContain('车辆来访4');
    expect(statisticsPanel.textContent).toContain('会议室预约3');

    const organizationButton = screen.getByRole('button', { name: /星河科技/ });
    expect(organizationButton.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(organizationButton);
    expect(organizationButton.getAttribute('aria-expanded')).toBe('true');
    const detailId = organizationButton.getAttribute('aria-controls');
    const detail = detailId ? document.getElementById(detailId) : null;
    expect(detail?.textContent).toContain('装修管理1 次');
    expect(detail?.textContent).toContain('会议室预约3 次');
    expect(detail?.textContent).toContain('车辆与访客4 次');
  });

  it('普通入驻企业不请求也不显示全园服务统计', async () => {
    const enterpriseParkView = vi.fn(async () => ({
      id: 'park-tenant-1',
      name: '星河产业园',
      slug: 'star-park',
      brandName: '星河园区服务',
      adminOrganizationId: 'park-admin-org',
      status: 'active' as const,
      createdAt: '2026-07-20T08:00:00Z',
      updatedAt: '2026-07-20T08:00:00Z',
      isAdminOrganization: false,
      tenantAddress: '科技大厦 B 座',
      tenantRoomNumber: '806 室',
    }));
    const enterpriseParkStatistics = vi.fn();
    Object.assign(window.otto, { enterpriseParkView, enterpriseParkStatistics });

    render(<ParkServicesPlugin />);
    await waitFor(() => expect(enterpriseParkView).toHaveBeenCalledOnce());
    openDialog();

    expect(screen.queryByLabelText('产业园服务统计')).toBeNull();
    expect(enterpriseParkStatistics).not.toHaveBeenCalled();
  });
  it('普通用户只看到真实申请表，不出现后台人员或模拟入口', async () => {
    installRepairBridge('reporter');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(await screen.findByText('会议室预约'));
    expect(await screen.findByLabelText('会议室预约申请表')).toBeTruthy();
    expect(screen.queryByText(/本地模拟/)).toBeNull();
    expect(screen.queryByText(/张工|维修工作台|园区端/)).toBeNull();
  });

  it('园区公告只显示服务器发布的内容，并记录已读', async () => {
    const bridge = installPublicationBridge('announcement');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(await screen.findByText('园区公告'));
    const item = await screen.findByRole('button', { name: /下午临时停水通知/ });
    fireEvent.click(item);
    await waitFor(() => expect(bridge.read).toHaveBeenCalledWith('publication-announcement'));
    expect(screen.queryByText(/模拟发布/)).toBeNull();
  });

  it('满意度调查实名提交一次，界面不包含发布端', async () => {
    const bridge = installPublicationBridge('satisfaction');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(await screen.findByText('满意度调查'));
    const survey = await screen.findByLabelText('员工填写满意度调查');
    expect((screen.getByLabelText('公司名称') as HTMLInputElement).value).toBe('测试园区');
    expect((screen.getByLabelText('房间号') as HTMLInputElement).value).toBe('1203 室');
    expect((screen.getByLabelText('联系人') as HTMLInputElement).value).toBe('报修员工');
    expect((screen.getByLabelText('联系电话') as HTMLInputElement).value).toBe('13800138000');
    fireEvent.change(screen.getByLabelText('总体满意度'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('重点关注'), { target: { value: '会议室环境' } });
    fireEvent.change(screen.getByLabelText('改进建议'), { target: { value: '希望加强巡检' } });
    fireEvent.submit(survey);
    await waitFor(() => expect(bridge.submit).toHaveBeenCalledWith('publication-satisfaction', expect.objectContaining({
      company: '测试园区', roomNumber: '1203 室',
      contact: '报修员工', phone: '13800138000', score: '4', focus: '会议室环境',
      submittedBy: '报修员工',
    })));
    expect((await screen.findByRole('button', { name: '已实名提交，不能修改' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/模拟发布|园区端/)).toBeNull();
  });

  it('报修通过企业服务器提交并自动投递维修工作人员', async () => {
    const bridge = installRepairBridge('reporter');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(await screen.findByText('物业报修'));
    const requestForm = await screen.findByLabelText('物业报修申请表');
    fireEvent.change(screen.getByLabelText('报修类别'), { target: { value: '灯具维修' } });
    fireEvent.change(screen.getByLabelText('故障描述'), { target: { value: '灯具无法点亮' } });
    fireEvent.change(screen.getByLabelText('紧急程度'), { target: { value: '普通' } });
    fireEvent.submit(requestForm);
    await waitFor(() => expect(bridge.submit).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'repair',
      formData: expect.objectContaining({ category: '灯具维修', issue: '灯具无法点亮', urgency: '普通' }),
    })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('服务器报修类别允许直接填写自定义类别', async () => {
    const bridge = installRepairBridge('reporter');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(await screen.findByText('物业报修'));
    await screen.findByLabelText('物业报修申请表');
    fireEvent.change(screen.getByLabelText('报修类别'), { target: { value: '玻璃门损坏' } });
    fireEvent.change(screen.getByLabelText('故障描述'), { target: { value: '玻璃门无法关闭' } });
    fireEvent.change(screen.getByLabelText('紧急程度'), { target: { value: '普通' } });
    fireEvent.submit(screen.getByLabelText('物业报修申请表'));
    await waitFor(() => expect(bridge.submit).toHaveBeenCalledWith(expect.objectContaining({
      category: '玻璃门损坏',
      formData: expect.objectContaining({ category: '玻璃门损坏' }),
    })));
  });

  it('所有申请类园区服务都包含公司、房间、联系人和电话', () => {
    for (const serviceId of ['renovation', 'parking', 'network-phone', 'meeting-room', 'electric-card', 'repair', 'vehicle-visit']) {
      expect(serviceFormFields(serviceId).slice(0, 4).map((field) => field.key)).toEqual([
        'company', 'roomNumber', 'contact', 'phone',
      ]);
    }
  });

  it('电卡统一使用充电度数，车辆来访必须包含具体时间', () => {
    expect(serviceFormFields('electric-card').map((field) => field.key)).toContain('chargingKwh');
    expect(serviceFormFields('electric-card').map((field) => field.key)).not.toContain('amount');
    expect(serviceFormFields('vehicle-visit').map((field) => field.key)).toContain('visitTime');
  });

  it('当天过去的会议时段变灰，未来时段保持可预约', () => {
    const now = new Date('2026-07-28T06:35:00.000Z');
    expect(isMeetingSlotPast('2026-07-28', '14:30', now)).toBe(true);
    expect(isMeetingSlotPast('2026-07-28', '15:00', now)).toBe(false);
    expect(effectiveMeetingSlotStatus({
      id: 'past-slot',
      roomId: 'room-1',
      date: '2026-07-28',
      slotKey: '14:30',
      label: '14:30–15:00',
      status: 'available',
      updatedAt: '2026-07-28',
    }, now)).toBe('closed');
  });

  it('会议日期和过去时段始终按园区北京时间判断', () => {
    const afterShanghaiMidnight = new Date('2026-07-28T16:30:00.000Z');
    expect(
      isMeetingSlotPast('2026-07-28', '22:30', afterShanghaiMidnight),
    ).toBe(true);
    expect(
      isMeetingSlotPast('2026-07-29', '09:00', afterShanghaiMidnight),
    ).toBe(false);

    const afterTenInShanghai = new Date('2026-07-29T02:05:00.000Z');
    expect(
      isMeetingSlotPast('2026-07-29', '10:00', afterTenInShanghai),
    ).toBe(true);
    expect(
      isMeetingSlotPast('2026-07-29', '10:30', afterTenInShanghai),
    ).toBe(false);
  });

  it('会议室同日可选，22:00–23:00 完整显示两个 30 分钟时段，黄色时段可再次点击取消', async () => {
    installRepairBridge('reporter');
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = [
      tomorrowDate.getFullYear(),
      String(tomorrowDate.getMonth() + 1).padStart(2, '0'),
      String(tomorrowDate.getDate()).padStart(2, '0'),
    ].join('-');
    const keys = ['22:00', '22:30'];
    Object.assign(window.otto, {
      enterpriseParkResources: vi.fn(async () => ({
        settings: { parkingTotal: 10, parkingNote: null, updatedAt: tomorrow },
        meetingRooms: [{
          id: 'room-1', name: '中型会议室', location: 'A 座 3 层', capacity: 12,
          priceHalfDay: 400, equipment: ['投屏'], imageUrl: null, openingHours: '09:00–23:00',
          enabled: true, createdAt: tomorrow, updatedAt: tomorrow,
        }],
        meetingSlots: keys.map((slotKey, index) => ({
          id: `slot-${index}`, roomId: 'room-1', date: tomorrow, slotKey,
          label: `${slotKey}–${index === 1 ? '23:00' : '22:30'}`,
          status: 'available' as const, updatedAt: tomorrow,
        })),
      })),
    });
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(await screen.findByText('会议室预约'));
    fireEvent.change(await screen.findByLabelText('会议室名称'), { target: { value: 'room-1' } });
    const todayDate = new Date();
    const today = [
      todayDate.getFullYear(),
      String(todayDate.getMonth() + 1).padStart(2, '0'),
      String(todayDate.getDate()).padStart(2, '0'),
    ].join('-');
    expect((screen.getByLabelText('使用日期') as HTMLInputElement).min).toBe(today);
    fireEvent.change(screen.getByLabelText('使用日期'), { target: { value: tomorrow } });

    const timeline = await screen.findByRole('group', { name: '09:00 到 23:00 会议室预约时间轴' });
    expect(timeline.querySelectorAll('button')).toHaveLength(2);
    const first = screen.getByRole('button', { name: /22:00–22:30，可预约/ });
    fireEvent.click(first);
    expect(first.classList.contains('is-selected')).toBe(true);
    expect(screen.getByText(/已选择 22:00–22:30/)).toBeTruthy();
    expect(screen.getByText(/不足半天按半天计；本次预计 400 元/)).toBeTruthy();
    fireEvent.click(first);
    expect(first.classList.contains('is-selected')).toBe(false);
    expect(screen.queryByText(/已选择 22:00–22:30/)).toBeNull();
  });

  it('会议预约冲突后立即刷新资源，避免继续显示已失效的绿色时段', async () => {
    installRepairBridge('reporter');
    const date = new Date();
    date.setDate(date.getDate() + 1);
    const tomorrow = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
    const resources = vi.fn(async () => ({
      settings: { parkingTotal: 10, parkingNote: null, updatedAt: tomorrow },
      meetingRooms: [{
        id: 'room-1', name: '中型会议室', location: 'A 座 3 层', capacity: 12,
        priceHalfDay: 400, equipment: ['投屏'], imageUrl: null, openingHours: '09:00–23:00',
        enabled: true, createdAt: tomorrow, updatedAt: tomorrow,
      }],
      meetingSlots: [{
        id: 'slot-1', roomId: 'room-1', date: tomorrow, slotKey: '22:00',
        label: '22:00–22:30', status: 'available' as const, updatedAt: tomorrow,
      }],
    }));
    Object.assign(window.otto, {
      enterpriseParkResources: resources,
      enterpriseTicketSubmit: vi.fn(async () => {
        throw new Error('该时段刚刚已被预约，请选择其他时段');
      }),
    });
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(await screen.findByText('会议室预约'));
    fireEvent.change(await screen.findByLabelText('会议室名称'), { target: { value: 'room-1' } });
    fireEvent.change(screen.getByLabelText('使用日期'), { target: { value: tomorrow } });
    fireEvent.click(await screen.findByRole('button', { name: /22:00–22:30，可预约/ }));
    fireEvent.change(screen.getByLabelText('参会人数'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('会议内容'), { target: { value: '项目评审' } });
    fireEvent.submit(screen.getByLabelText('会议室预约申请表'));

    expect((await screen.findByRole('alert')).textContent).toContain('该时段刚刚已被预约');
    await waitFor(() => expect(resources.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('电卡支持小数度数，并在申请说明中显示单价和预计金额', async () => {
    const bridge = installRepairBridge('reporter');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(await screen.findByText('电卡服务'));
    const charging = await screen.findByLabelText('充电度数') as HTMLInputElement;
    expect(charging.min).toBe('0.1');
    expect(charging.step).toBe('0.1');
    fireEvent.change(charging, { target: { value: '12.5' } });
    fireEvent.submit(screen.getByLabelText('电卡服务申请表'));

    await waitFor(() => expect(bridge.submit).toHaveBeenCalledOnce());
    expect(bridge.submit.mock.calls[0][0].description).toContain('充电度数：12.5 度');
    expect(bridge.submit.mock.calls[0][0].description).toContain('计费标准：1.2 元/度');
    expect(bridge.submit.mock.calls[0][0].description).toContain('预计金额：15.00 元');
  });

  it('园区申请默认带出企业入驻资料和账号信息，缺失手机号时保持空白', async () => {
    const bridge = installRepairBridge('reporter');
    bridge.account.phone = null;
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(await screen.findByText('物业报修'));
    await screen.findByLabelText('物业报修申请表');

    expect((screen.getByLabelText('公司名称') as HTMLInputElement).value).toBe('测试企业');
    expect((screen.getByLabelText('房间号') as HTMLInputElement).value).toBe('1203 室');
    expect((screen.getByLabelText('联系人') as HTMLInputElement).value).toBe('报修员工');
    expect((screen.getByLabelText('联系电话') as HTMLInputElement).value).toBe('');
  });

  it('停车申请标题和说明只显示中文选项，不泄露内部枚举值', async () => {
    const bridge = installRepairBridge('reporter');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(await screen.findByText('停车办理'));
    const form = await screen.findByLabelText('停车办理申请表');
    await waitFor(() => expect((screen.getByLabelText('公司名称') as HTMLInputElement).value).toBe('测试企业'));
    fireEvent.change(screen.getByLabelText('申请内容'), { target: { value: 'underground-fixed' } });
    fireEvent.change(screen.getByLabelText('申请数量'), { target: { value: '1' } });
    fireEvent.submit(form);

    await waitFor(() => expect(bridge.submit).toHaveBeenCalledOnce());
    const submitted = bridge.submit.mock.calls[0][0];
    expect(submitted.title).toContain('地下固定停车位');
    expect(submitted.description).toContain('地下固定停车位 · 260 元/月');
    expect(submitted.title).not.toContain('underground-fixed');
    expect(submitted.description).not.toContain('underground-fixed');
  });

  it('客服一次完成回复并固定转交工程部，不允许选择个人', async () => {
    const bridge = installRepairBridge('worker');
    render(<ParkServicesPlugin />);
    await waitFor(() => expect(window.otto.notificationShow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'park:ticket:ticket-1',
      source: 'park',
    })));
    fireEvent.click(await screen.findByLabelText(/打开园区服务通知/));
    await waitFor(() => expect(bridge.read).toHaveBeenCalledWith('ticket-1'));
    expect(await screen.findByText('灯坏了')).toBeTruthy();
    expect(screen.queryByText('申请人')).toBeNull();
    expect(screen.queryByRole('button', { name: '接单并处理' })).toBeNull();
    expect(screen.queryByRole('button', { name: '提交办理完成' })).toBeNull();
    expect(screen.getByText('工程部')).toBeTruthy();
    expect(screen.queryByLabelText('转交给同事')).toBeNull();
    fireEvent.change(screen.getByLabelText('处理方式'), { target: { value: '预约已收到' } });
    fireEvent.change(screen.getByLabelText('回复内容补充'), { target: { value: '客服已收到，将安排工程部上门' } });
    fireEvent.submit(screen.getByLabelText('物业报修回复并转交工程部'));
    await waitFor(() => expect(bridge.action).toHaveBeenCalledWith('ticket-1', {
      action: 'respond_and_transfer',
      responseType: '预约已收到',
      responseText: '客服已收到，将安排工程部上门',
      transferDepartment: '工程部',
      transferNote: '请工程部接手处理该物业报修，并在完成后记录工作结果。',
    }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('登录时多个待办合并成一个汇总提醒，具体工单仍可从待办列表打开', async () => {
    const bridge = installRepairBridge('worker', 2);
    render(<ParkServicesPlugin />);

    fireEvent.click(await screen.findByLabelText('打开园区待办汇总'));
    expect(window.otto.notificationShow).toHaveBeenCalledTimes(1);
    expect(window.otto.notificationShow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'park:service',
      source: 'park',
      title: 'Otto 待处理提醒 · 园区服务',
    }));
    expect(window.otto.notificationMarkRead).toHaveBeenCalledWith('park:service');
    await waitFor(() => expect(bridge.read).toHaveBeenCalledTimes(2));

    fireEvent.click(await screen.findByRole('button', { name: /打开工作人员待办：A 座大厅/ }));
    expect(await screen.findByText('空调漏水')).toBeTruthy();
  });

  it('点过系统园区提醒后不再重复弹窗，未处理工单继续保留在我的园区待办', async () => {
    const bridge = installRepairBridge('worker');
    render(<ParkServicesPlugin />);
    await waitFor(() => expect(window.otto.notificationShow).toHaveBeenCalledTimes(1));

    act(() => bridge.openSystemNotification('park:ticket:ticket-1'));
    await waitFor(() => expect(bridge.read).toHaveBeenCalledWith('ticket-1'));
    expect(await screen.findByText('灯坏了')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '← 返回服务列表' }));
    expect(await screen.findByLabelText('我的园区待办')).toBeTruthy();
    expect(screen.getByText(/待接单/)).toBeTruthy();

    cleanup();
    const ticketList = vi.mocked(window.otto.enterpriseTicketList);
    const previousListCalls = ticketList.mock.calls.length;
    render(<ParkServicesPlugin />);
    await waitFor(() => expect(ticketList.mock.calls.length).toBeGreaterThan(previousListCalls));
    expect(window.otto.notificationShow).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText(/打开园区服务通知|打开园区待办汇总/)).toBeNull();

    openDialog();
    expect(await screen.findByLabelText('我的园区待办')).toBeTruthy();
    expect(await screen.findByRole('button', { name: /打开工作人员待办：某某会议室/ })).toBeTruthy();
  });

  it('申请人收到持久回复通知，并从首页右侧历史查看统一申请编号', async () => {
    const bridge = installRepairBridge('worker');
    const creatorTicket = {
      ...bridge.getTickets()[0],
      status: '待验收',
      responseType: '预约已收到',
      responseText: '工程部明天上午上门',
      responseAt: '2026-07-20T01:00:00Z',
      creatorUpdateAt: '2026-07-20T01:00:00Z',
      creatorUpdateReadAt: null,
      updatedAt: '2026-07-20T01:00:00Z',
      isCreator: true,
      isRecipient: false,
      deliveryStatus: undefined,
      readAt: null,
    };
    bridge.setTickets([creatorTicket]);
    render(<ParkServicesPlugin />);

    await waitFor(() => expect(window.otto.notificationShow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'park:ticket:ticket-1',
      persistent: true,
      preview: expect.stringContaining('申请单 20260720001'),
    })));
    expect(await screen.findByLabelText(/打开园区服务通知/)).toBeTruthy();

    openDialog();
    const history = await screen.findByLabelText('我的园区申请历史记录');
    expect(within(history).getByText(/20260720001/)).toBeTruthy();
    expect(screen.queryByText('我的办理进度')).toBeNull();
    fireEvent.click(within(history).getByRole('button', { name: /打开我的申请历史/ }));
    const detail = await screen.findByRole('dialog', { name: '物业报修' });
    expect(within(detail).getByText('20260720001')).toBeTruthy();
    expect(within(detail).getByText('物业报修', { selector: 'strong' })).toBeTruthy();
    expect(within(detail).queryByText('灯坏了')).toBeNull();
    expect(within(detail).getAllByText('预约已收到')).toHaveLength(2);
    expect(window.otto.notificationMarkRead).toHaveBeenCalledWith('park:ticket:ticket-1');
    await waitFor(() => expect(bridge.read).toHaveBeenCalledWith('ticket-1'));

    cleanup();
    const notificationsBeforeRemount = vi.mocked(window.otto.notificationShow).mock.calls.length;
    render(<ParkServicesPlugin />);
    await waitFor(() => expect(window.otto.enterpriseTicketList).toHaveBeenCalled());
    expect(window.otto.notificationShow).toHaveBeenCalledTimes(notificationsBeforeRemount);
  });

  it('客服未打开的历史任务不会被自动已读，状态通知持续保留', async () => {
    installRepairBridge('worker', 3, ['已完成', '待验收', '待接单']);
    render(<ParkServicesPlugin />);

    await waitFor(() => expect(window.otto.notificationShow).toHaveBeenCalledTimes(3));
    expect(window.otto.notificationShow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'park:ticket:ticket-3',
    }));
    expect(window.otto.notificationMarkRead).not.toHaveBeenCalledWith('park:ticket:ticket-1');
    expect(window.otto.notificationMarkRead).not.toHaveBeenCalledWith('park:ticket:ticket-2');
    expect(await screen.findAllByLabelText(/打开园区服务通知/)).toHaveLength(3);
    openDialog();
    expect(await screen.findAllByRole('button', { name: /打开工作人员待办/ })).toHaveLength(1);
    expect(screen.getByText(/1 项待处理/)).toBeTruthy();
  });

  it('客服只有已处理历史时仍保留未打开通知，打开后才写已读', async () => {
    const bridge = installRepairBridge('worker', 2, ['已完成', '待验收']);
    render(<ParkServicesPlugin />);

    expect(await screen.findAllByLabelText(/打开园区服务通知/)).toHaveLength(2);
    expect(window.otto.notificationMarkRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByLabelText(/打开园区服务通知/)[0]);
    await waitFor(() => expect(bridge.read).toHaveBeenCalledTimes(1));
    expect(window.otto.notificationMarkRead).toHaveBeenCalledTimes(1);
  });

  it('六条未打开园区通知全部保留，不因显示上限自行消失', async () => {
    const bridge = installRepairBridge('worker', 6, Array.from({ length: 6 }, () => '已完成'));
    render(<ParkServicesPlugin />);

    expect(await screen.findAllByLabelText(/打开园区服务通知/)).toHaveLength(6);
    expect(window.otto.notificationShow).toHaveBeenCalledTimes(6);
    expect(bridge.read).not.toHaveBeenCalled();
  });

  it('工作人员可在待办右侧搜索、按九类筛选并按时间查看完整服务历史', async () => {
    const bridge = installRepairBridge('worker', 3, ['已完成', '待验收', '已完成']);
    const [repair, network, parking] = bridge.getTickets();
    bridge.setTickets([
      {
        ...repair,
        serviceId: 'repair',
        title: 'A 座 1203 · 网络报修',
        description: '办公室网络中断',
        formData: {
          company: '星河科技', address: '科技大厦 A 座', roomNumber: '1203',
          contact: '李经理', phone: '13800138000', issue: '办公室网络中断',
        },
        responseType: '现场维修完成',
        responseText: '交换机端口已更换，网络恢复',
        responseAt: '2026-07-20T10:04:00Z',
        updatedAt: '2026-07-20T10:05:00Z',
        history: [
          {
            id: 'h1-created', action: 'created', statusBefore: null, statusAfter: '待接单',
            responseType: null, responseText: null, createdAt: '2026-07-20T10:00:00Z',
            actor: { id: 'reporter-1', name: '报修员工' },
          },
          {
            id: 'h1-accept', action: 'accept', statusBefore: '待接单', statusAfter: '维修中',
            responseType: null, responseText: null, createdAt: '2026-07-20T10:01:00Z',
            actor: { id: 'worker-1', name: '维修张工' },
          },
          {
            id: 'h1-response-1', action: 'respond', statusBefore: '维修中', statusAfter: '维修中',
            responseType: '远程指导', responseText: '请先检查墙面开关', createdAt: '2026-07-20T10:02:00Z',
            actor: { id: 'worker-1', name: '维修张工' },
          },
          {
            id: 'h1-response-2', action: 'respond', statusBefore: '维修中', statusAfter: '维修中',
            responseType: '现场处理', responseText: '确认交换机端口损坏', createdAt: '2026-07-20T10:03:00Z',
            actor: { id: 'worker-1', name: '维修张工' },
          },
          {
            id: 'h1-complete', action: 'complete', statusBefore: '维修中', statusAfter: '待验收',
            responseType: null, responseText: null, createdAt: '2026-07-20T10:04:00Z',
            actor: { id: 'worker-1', name: '维修张工' },
          },
          {
            id: 'h1-confirm', action: 'confirm', statusBefore: '待验收', statusAfter: '已完成',
            responseType: null, responseText: null, createdAt: '2026-07-20T10:05:00Z',
            actor: { id: 'reporter-1', name: '报修员工' },
          },
        ],
      },
      {
        ...network,
        serviceId: 'network-phone',
        title: 'B 座 806 · 固话开通',
        description: '申请两个固定电话工位',
        formData: { company: '海川设计', address: '科技大厦 B 座', roomNumber: '806' },
        responseType: '线路已开通', responseText: '等待企业验收',
        responseAt: '2026-07-20T12:00:00Z', updatedAt: '2026-07-20T12:00:00Z',
        history: [{
          id: 'h2-complete', action: 'complete', statusBefore: '处理中', statusAfter: '待验收',
          responseType: null, responseText: null, createdAt: '2026-07-20T12:00:00Z',
          actor: { id: 'worker-1', name: '维修张工' },
        }],
      },
      {
        ...parking,
        serviceId: 'parking',
        title: '停车位办理 · 京 A12345',
        description: '固定停车位办理',
        formData: { company: '远景咨询', plate: '京 A12345' },
        responseType: '车位已开通', responseText: '门禁权限已生效',
        responseAt: '2026-07-20T11:00:00Z', updatedAt: '2026-07-20T11:00:00Z',
        history: [{
          id: 'h3-confirm', action: 'confirm', statusBefore: '待验收', statusAfter: '已完成',
          responseType: null, responseText: null, createdAt: '2026-07-20T11:00:00Z',
          actor: { id: 'reporter-1', name: '报修员工' },
        }],
      },
    ]);

    render(<ParkServicesPlugin />);
    openDialog();
    const historyPanel = await screen.findByLabelText('我的园区服务历史记录');
    expect(historyPanel).toBeTruthy();
    expect((screen.getByLabelText('园区历史分类') as HTMLSelectElement).options).toHaveLength(10);
    expect(screen.getAllByRole('button', { name: /打开园区历史/ }).map((button) => button.getAttribute('aria-label'))).toEqual([
      '打开园区历史：B 座 806 · 固话开通',
      '打开园区历史：停车位办理 · 京 A12345',
      '打开园区历史：A 座 1203 · 网络报修',
    ]);

    fireEvent.change(screen.getByLabelText('园区历史分类'), { target: { value: 'network-phone' } });
    expect(screen.getAllByRole('button', { name: /打开园区历史/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: '打开园区历史：B 座 806 · 固话开通' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('园区历史分类'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('园区历史排序'), { target: { value: 'asc' } });
    expect(screen.getAllByRole('button', { name: /打开园区历史/ })[0].getAttribute('aria-label')).toBe('打开园区历史：A 座 1203 · 网络报修');

    fireEvent.change(screen.getByLabelText('搜索园区服务历史'), { target: { value: '墙面开关' } });
    expect(screen.getAllByRole('button', { name: /打开园区历史/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '打开园区历史：A 座 1203 · 网络报修' }));

    expect(await screen.findByText('历史记录只读')).toBeTruthy();
    expect(screen.getByLabelText('园区服务处理历史')).toBeTruthy();
    expect(screen.getByText('办公室网络中断')).toBeTruthy();
    expect(screen.queryByText('星河科技')).toBeNull();
    expect(screen.getByText((_, node) => node?.textContent === '远程指导：请先检查墙面开关')).toBeTruthy();
    expect(screen.getByText((_, node) => node?.textContent === '现场处理：确认交换机端口损坏')).toBeTruthy();
    expect(screen.queryByLabelText('物业报修客服回复')).toBeNull();
  });

  it('工作人员关闭通知后仍可从九宫格上方找回自己的待办，普通用户看不到该入口', async () => {
    installRepairBridge('worker');
    render(<ParkServicesPlugin />);
    openDialog();
    const task = await screen.findByRole('button', { name: /打开工作人员待办：某某会议室/ });
    expect(screen.getByText(/仅工作人员可见/)).toBeTruthy();
    fireEvent.click(task);
    expect(await screen.findByLabelText('物业报修回复并转交工程部')).toBeTruthy();

    cleanup();
    installRepairBridge('reporter');
    render(<ParkServicesPlugin />);
    openDialog();
    await waitFor(() => expect(window.otto.enterpriseTicketList).toHaveBeenCalled());
    expect(screen.queryByLabelText('我的园区待办')).toBeNull();
  });

  it('维修客服使用结构化回复并转交工程部，不增加聊天窗口', async () => {
    const bridge = installRepairBridge('worker');
    render(<ParkServicesPlugin />);
    fireEvent.click(await screen.findByLabelText(/打开园区服务通知/));
    fireEvent.change(await screen.findByLabelText('处理方式'), { target: { value: '远程指导' } });
    fireEvent.change(screen.getByLabelText('回复内容补充'), { target: { value: '请先检查开关' } });
    fireEvent.submit(screen.getByLabelText('物业报修回复并转交工程部'));
    await waitFor(() => expect(bridge.action).toHaveBeenCalledWith('ticket-1', {
      action: 'respond_and_transfer',
      responseType: '远程指导',
      responseText: '请先检查开关',
      transferDepartment: '工程部',
      transferNote: '请工程部接手处理该物业报修，并在完成后记录工作结果。',
    }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByPlaceholderText('输入消息')).toBeNull();
  });

  it('所有园区服务回复候选都包含“预约已收到”和“订单已收到”', async () => {
    const bridge = installRepairBridge('worker');
    const parkingTicket = {
      ...bridge.getTickets()[0],
      serviceId: 'parking',
      title: '停车位办理申请',
      description: '地下固定停车位 · 1 个',
    };
    bridge.setTickets([parkingTicket]);
    render(<ParkServicesPlugin />);
    fireEvent.click(await screen.findByLabelText(/打开园区服务通知/));
    await screen.findByLabelText('园区服务回复表');

    const options = Array.from(document.querySelectorAll(
      '#otto-park-response-parking option',
    )).map((option) => option.getAttribute('value'));
    expect(options).toContain('预约已收到');
    expect(options).toContain('订单已收到');
    expect(screen.getByLabelText('回复内容补充')).toBeTruthy();
  });

  it('其他园区服务使用各自的真实空白申请表', async () => {
    installRepairBridge('reporter');
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(await screen.findByText('装修管理'));
    expect(await screen.findByLabelText('装修管理申请表')).toBeTruthy();
    expect(screen.queryByText(/客户只需如实填写并提交申请单/)).toBeNull();
    expect(screen.queryByText('填写申请')).toBeNull();
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
    expect(document.getElementById(labelledBy)?.textContent).toBe('宏创园区服务');
  });

  it('企业定制：parkConfig 的 brandName/services 覆盖内置默认', async () => {
    const otto = {
      parkConfig: () =>
        Promise.resolve({
          brandName: '星火智慧园区服务',
          services: [{ name: '自定义服务A', desc: '描述A', prompt: '模板A' }],
        }),
      enterpriseSession: () => Promise.resolve({ serverUrl: 'https://enterprise.test', account: null }),
      enterpriseTicketList: () => Promise.resolve([]),
    };
    (window as unknown as { otto: typeof otto }).otto = otto;
    try {
      render(<ParkServicesPlugin />);
      openDialog();
      expect(await screen.findByText('星火智慧园区服务')).toBeTruthy();
      expect(screen.getByText('自定义服务A')).toBeTruthy();
      expect(screen.queryByText('装修管理')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /自定义服务A/ }));
      expect(await screen.findByText('请先登录企业账号。')).toBeTruthy();
      expect(screen.queryByText('模板A')).toBeNull();
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
