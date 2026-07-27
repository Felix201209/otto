/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import {
  type AccountRow,
  type AccountView,
  getAccount,
  getDB,
  getOrganizationFeatures,
  getPark,
  getParkForOrganization,
  listParkServices,
  listParkServiceSpecialists,
  logAudit,
  normalizeTags,
  PARK_SERVICE_IDS,
  toAccountView,
} from './db.js';

export type TicketHistoryAction =
  | 'created'
  | 'accept'
  | 'respond'
  | 'transfer'
  | 'complete'
  | 'confirm';

export interface TicketHistoryEntry {
  id: string;
  action: TicketHistoryAction;
  statusBefore: string | null;
  statusAfter: string;
  responseType: string | null;
  responseText: string | null;
  createdAt: string;
  actor: { id: string; name: string } | null;
}

export interface TicketView {
  id: string;
  parkId: string | null;
  serviceId: string;
  title: string;
  description: string;
  formData: Record<string, string>;
  targetTags: string[];
  status: string;
  category: string | null;
  location: string | null;
  urgency: string | null;
  contact: string | null;
  contactPhone: string | null;
  responseType: string | null;
  responseText: string | null;
  responseAt: string | null;
  createdAt: string;
  updatedAt: string;
  creator: Pick<AccountView, 'id' | 'name' | 'username'>;
  recipientCount: number;
  recipients: Array<Pick<AccountView, 'id' | 'name'>>;
  deliveryStatus?: string;
  readAt?: string | null;
  isCreator?: boolean;
  isRecipient?: boolean;
  history: TicketHistoryEntry[];
  notifications: Array<{
    channel: 'otto' | 'sms' | 'feishu';
    event: string;
    status: 'sent' | 'failed' | 'skipped';
    detail: string | null;
    createdAt: string;
  }>;
}

interface TicketRow {
  id: string;
  organization_id: string;
  park_id: string | null;
  created_by_account_id: string;
  service_id: string | null;
  title: string;
  description: string;
  target_tags: string;
  form_data: string | null;
  category: string | null;
  location: string | null;
  urgency: string | null;
  contact: string | null;
  contact_phone: string | null;
  response_type: string | null;
  response_text: string | null;
  response_at: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  closed_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface TicketEventRow {
  id: string;
  event_order: number;
  actor_account_id: string | null;
  actor_name: string | null;
  action: TicketHistoryAction;
  status_before: string | null;
  status_after: string;
  response_type: string | null;
  response_text: string | null;
  created_at: string;
}

function recordTicketEvent(input: {
  organizationId: string;
  ticketId: string;
  actorAccountId: string | null;
  action: TicketHistoryAction;
  statusBefore: string | null;
  statusAfter: string;
  responseType?: string | null;
  responseText?: string | null;
}): void {
  getDB().prepare(
    `INSERT INTO ticket_events
     (id, organization_id, ticket_id, actor_account_id, action, status_before, status_after,
      response_type, response_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `ticket_event_${randomUUID()}`,
    input.organizationId,
    input.ticketId,
    input.actorAccountId,
    input.action,
    input.statusBefore,
    input.statusAfter,
    input.responseType ?? null,
    input.responseText ?? null,
  );
}

function ticketView(id: string, viewerAccountId?: string): TicketView {
  const row = getDB()
    .prepare('SELECT * FROM it_tickets WHERE id = ?')
    .get(id) as TicketRow | undefined;
  if (!row) throw new Error('Ticket not found');
  const activeCreator = getAccount(
    row.created_by_account_id,
    row.organization_id,
  );
  const creatorRow = activeCreator
    ? null
    : (getDB()
        .prepare(
          `SELECT id FROM accounts WHERE id = ? AND organization_id = ? AND deleted_at IS NOT NULL`,
        )
        .get(row.created_by_account_id, row.organization_id) as
        { id: string } | undefined);
  const creator: Pick<AccountView, 'id' | 'name' | 'username'> | null =
    activeCreator
      ? {
          id: activeCreator.id,
          name: activeCreator.name,
          username: activeCreator.username,
        }
      : creatorRow
        ? { id: creatorRow.id, name: '已删除账号', username: '已删除账号' }
        : null;
  if (!creator) throw new Error('Ticket creator not found');
  const deliveries = getDB()
    .prepare(
      `SELECT account_id, status, read_at FROM ticket_deliveries
     WHERE ticket_id = ? AND organization_id = ? ORDER BY delivered_at`,
    )
    .all(id, row.organization_id) as Array<{
    account_id: string;
    status: string;
    read_at: string | null;
  }>;
  const activeDeliveries = deliveries.filter((delivery) => delivery.status !== 'transferred');
  const recipientAccounts = activeDeliveries
    .map((delivery) => getAccount(delivery.account_id))
    .filter((account): account is AccountView => account !== null);
  const viewer = viewerAccountId ? getAccount(viewerAccountId) : null;
  const canSeeRecipients = viewer?.isAdmin || viewerAccountId === creator.id;
  const viewerDelivery = viewerAccountId
    ? deliveries.find((delivery) => delivery.account_id === viewerAccountId)
    : undefined;
  const notifications = viewer?.isAdmin
    ? (getDB()
        .prepare(
          `SELECT channel, event, status, detail, created_at FROM ticket_notifications
     WHERE ticket_id = ? ORDER BY created_at`,
        )
        .all(id) as Array<{
        channel: 'otto' | 'sms' | 'feishu';
        event: string;
        status: 'sent' | 'failed' | 'skipped';
        detail: string | null;
        created_at: string;
      }>)
    : [];
  let formData: Record<string, string> = {};
  try {
    const parsed = row.form_data
      ? (JSON.parse(row.form_data) as unknown)
      : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      formData = Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    }
  } catch {
    formData = {};
  }
  const eventRows = getDB().prepare(
    `SELECT e.id, e.rowid AS event_order, e.actor_account_id, a.name AS actor_name,
            e.action, e.status_before, e.status_after, e.response_type, e.response_text, e.created_at
     FROM ticket_events e
     LEFT JOIN accounts a ON a.id = e.actor_account_id
     WHERE e.ticket_id = ? AND e.organization_id = ?
     ORDER BY e.created_at, e.rowid`,
  ).all(id, row.organization_id) as TicketEventRow[];
  const historyCandidates: Array<{ order: number; event: TicketHistoryEntry }> = eventRows.map(
    (event) => ({
      order: 100 + event.event_order,
      event: {
        id: event.id,
        action: event.action,
        statusBefore: event.status_before,
        statusAfter: event.status_after,
        responseType: event.response_type,
        responseText: event.response_text,
        createdAt: event.created_at,
        actor: event.actor_account_id
          ? { id: event.actor_account_id, name: event.actor_name || '已删除账号' }
          : null,
      },
    }),
  );
  const hasAction = (action: TicketHistoryAction): boolean => eventRows.some(
    (event) => event.action === action,
  );
  const addLegacyEvent = (
    action: TicketHistoryAction,
    createdAt: string | null,
    statusBefore: string | null,
    statusAfter: string,
    order: number,
    responseType: string | null = null,
    responseText: string | null = null,
    actor: TicketHistoryEntry['actor'] = null,
  ): void => {
    if (!createdAt || hasAction(action)) return;
    historyCandidates.push({
      order,
      event: {
        id: `legacy_${action}_${row.id}`,
        action,
        statusBefore,
        statusAfter,
        responseType,
        responseText,
        createdAt,
        actor,
      },
    });
  };
  addLegacyEvent('created', row.created_at, null, '待接单', 0, null, null, {
    id: creator.id,
    name: creator.name,
  });
  const processingStatus = row.service_id === 'repair' ? '维修中' : '处理中';
  addLegacyEvent('accept', row.accepted_at, '待接单', processingStatus, 10);
  addLegacyEvent(
    'respond',
    row.response_at,
    row.accepted_at ? processingStatus : '待接单',
    row.response_type === '已完成维修' ? '待验收' : row.status,
    20,
    row.response_type,
    row.response_text,
  );
  const hasTerminalEvent = eventRows.some((event) => event.status_after === '已完成');
  if (!hasTerminalEvent && !eventRows.some((event) => event.status_after === '待验收')) {
    addLegacyEvent('complete', row.completed_at, processingStatus, '待验收', 30);
  }
  if (!hasTerminalEvent) {
    addLegacyEvent('confirm', row.closed_at, '待验收', '已完成', 40);
  }
  const history = historyCandidates
    .sort((left, right) => (
      left.event.createdAt.localeCompare(right.event.createdAt) || left.order - right.order
    ))
    .map((candidate) => candidate.event);
  return {
    id: row.id,
    parkId: row.park_id,
    serviceId: row.service_id || 'repair',
    title: row.title,
    description: row.description,
    formData,
    targetTags: JSON.parse(row.target_tags) as string[],
    status: row.status,
    category: row.category,
    location: row.location,
    urgency: row.urgency,
    contact: row.contact,
    contactPhone: row.contact_phone,
    responseType: row.response_type,
    responseText: row.response_text,
    responseAt: row.response_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    creator: {
      id: creator.id,
      name: creator.name,
      username: creator.username,
    },
    recipientCount: recipientAccounts.length,
    recipients: canSeeRecipients
      ? recipientAccounts.map((recipient) => ({
          id: recipient.id,
          name: recipient.name,
        }))
      : [],
    deliveryStatus: viewerDelivery?.status,
    readAt: viewerDelivery?.read_at,
    isCreator: viewerAccountId === creator.id,
    isRecipient: Boolean(viewerDelivery),
    history,
    notifications: notifications.map((notification) => ({
      channel: notification.channel,
      event: notification.event,
      status: notification.status,
      detail: notification.detail,
      createdAt: notification.created_at,
    })),
  };
}

export function getTicketForAccount(
  id: string,
  accountId: string,
): TicketView | null {
  const account = getAccount(accountId);
  if (!account) return null;
  const row = getDB()
    .prepare(
      'SELECT organization_id, park_id, created_by_account_id FROM it_tickets WHERE id = ?',
    )
    .get(id) as
    | {
        organization_id: string;
        park_id: string | null;
        created_by_account_id: string;
      }
    | undefined;
  if (!row) return null;
  const delivery = getDB()
    .prepare(
      'SELECT 1 FROM ticket_deliveries WHERE ticket_id = ? AND account_id = ?',
    )
    .get(id, accountId);
  const park = row.park_id ? getPark(row.park_id) : null;
  const isCreatorOrganizationAdmin =
    account.isAdmin && account.organizationId === row.organization_id;
  const isParkAdmin =
    account.isAdmin && park?.adminOrganizationId === account.organizationId;
  if (
    row.created_by_account_id !== accountId &&
    !delivery &&
    !isCreatorOrganizationAdmin &&
    !isParkAdmin
  )
    return null;
  return ticketView(id, accountId);
}

/**
 * 仅向已经有权查看该工单的账号返回创建者联系方式。园区处理方可以据此向
 * 跨组织创建者发送进度回执，但不能把 accountId 当作跨租户任意账号查询器。
 */
export function getTicketCreatorForAccount(
  id: string,
  accountId: string,
): AccountView | null {
  if (!getTicketForAccount(id, accountId)) return null;
  const row = getDB()
    .prepare(
      'SELECT organization_id, created_by_account_id FROM it_tickets WHERE id = ?',
    )
    .get(id) as
    { organization_id: string; created_by_account_id: string } | undefined;
  return row
    ? getAccount(row.created_by_account_id, row.organization_id)
    : null;
}

/** 已授权账号是否仍可使用该工单所属功能；企业 IT 工单不受园区开关影响。 */
export function isTicketFeatureEnabledForAccount(
  id: string,
  accountId: string,
): boolean {
  if (!getTicketForAccount(id, accountId)) return false;
  const viewer = getAccount(accountId);
  if (!viewer) return false;
  const row = getDB()
    .prepare('SELECT organization_id, park_id FROM it_tickets WHERE id = ?')
    .get(id) as { organization_id: string; park_id: string | null } | undefined;
  if (!row) return false;
  return (
    row.park_id === null ||
    (getOrganizationFeatures(row.organization_id).park_service &&
      getOrganizationFeatures(viewer.organizationId).park_service)
  );
}

const PARKING_APPLICATION_PRICES: Record<string, {
  label: string;
  amount: number;
  billingUnit: string;
}> = {
  'underground-fixed': { label: '地下固定停车位', amount: 260, billingUnit: '月' },
  '地下固定停车位:260元/月': { label: '地下固定停车位', amount: 260, billingUnit: '月' },
  'underground-tandem': { label: '地下固定子母停车位', amount: 390, billingUnit: '月' },
  '地下固定子母停车位:390元/月': { label: '地下固定子母停车位', amount: 390, billingUnit: '月' },
  'surface-temporary': { label: '地上临时停车位', amount: 1200, billingUnit: '半年' },
  '地上临时停车位:1200元/半年': { label: '地上临时停车位', amount: 1200, billingUnit: '半年' },
  'underground-temporary': { label: '地下临时停车位', amount: 1560, billingUnit: '半年' },
  '地下临时停车位:1560元/半年': { label: '地下临时停车位', amount: 1560, billingUnit: '半年' },
  cancel: { label: '退停车位', amount: 0, billingUnit: '次' },
  '退停车位': { label: '退停车位', amount: 0, billingUnit: '次' },
};

const NETWORK_PHONE_PRICES: Record<string, {
  label: string;
  amount: number;
  recurringMonthly: number;
}> = {
  'phone-open': { label: '开通电话（开通费235元/部，线路占用费35元/月/部）', amount: 270, recurringMonthly: 35 },
  '开通电话': { label: '开通电话（开通费235元/部，线路占用费35元/月/部）', amount: 270, recurringMonthly: 35 },
  'caller-id': { label: '来电显示（开通费50元/部，功能费5元/月/部）', amount: 55, recurringMonthly: 5 },
  '来电显示': { label: '来电显示（开通费50元/部，功能费5元/月/部）', amount: 55, recurringMonthly: 5 },
  'number-hold': { label: '停机保号（5元/月/部）', amount: 5, recurringMonthly: 5 },
  '停机保号': { label: '停机保号（5元/月/部）', amount: 5, recurringMonthly: 5 },
  'landline-stop': { label: '固话停机', amount: 0, recurringMonthly: 0 },
  '固话停机': { label: '固话停机', amount: 0, recurringMonthly: 0 },
  'leased-line-15': { label: '企业专线 15M（500元/月）', amount: 500, recurringMonthly: 500 },
  'leased-line-30': { label: '企业专线 30M（1000元/月）', amount: 1000, recurringMonthly: 1000 },
  'leased-line-45': { label: '企业专线 45M（1600元/月）', amount: 1600, recurringMonthly: 1600 },
  'leased-line-75': { label: '企业专线 75M（2900元/月）', amount: 2900, recurringMonthly: 2900 },
};

function requiredParkFormValue(
  formData: Record<string, string>,
  key: string,
  label: string,
): string {
  const value = formData[key]?.trim() || '';
  if (!value) throw new Error(`请填写${label}`);
  return value;
}

function parkFormPositiveInteger(value: string, label: string, allowZero = false): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1) || number > 1000) {
    throw new Error(`${label}必须是${allowZero ? '大于等于 0' : '大于等于 1'}的整数`);
  }
  return number;
}

function parkFormMoney(value: string, label: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) {
    throw new Error(`${label}必须是有效金额`);
  }
  return Math.round(amount * 100) / 100;
}

function validParkDate(value: string, label: string): string {
  const date = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`请选择有效的${label}`);
  return date;
}

function assertMeetingPeriod(startValue: string, endValue: string): {
  startTime: string;
  endTime: string;
  startMinutes: number;
  endMinutes: number;
} {
  const parse = (value: string): number => {
    const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
    if (!match) return Number.NaN;
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const startMinutes = parse(startValue);
  const endMinutes = parse(endValue);
  if (
    !Number.isInteger(startMinutes)
    || !Number.isInteger(endMinutes)
    || startMinutes < 9 * 60
    || endMinutes > 23 * 60
    || startMinutes >= endMinutes
    || startMinutes % 10 !== 0
    || endMinutes % 10 !== 0
  ) {
    throw new Error('会议时间必须在 09:00 到 23:00 之间，并按 10 分钟选择');
  }
  const format = (minutes: number): string => (
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  );
  return { startTime: format(startMinutes), endTime: format(endMinutes), startMinutes, endMinutes };
}

export function normalizeParkServiceFormData(
  serviceId: string,
  input: Record<string, string>,
): Record<string, string> {
  const formData = Object.fromEntries(Object.entries(input).map(([key, value]) => [
    key.slice(0, 50),
    value.trim().slice(0, 2000),
  ]));
  for (const [key, label] of [
    ['company', '公司名称'],
    ['roomNumber', '房间号'],
    ['contact', '联系人'],
    ['phone', '联系电话'],
  ] as const) {
    formData[key] = requiredParkFormValue(formData, key, label);
  }

  if (serviceId === 'renovation') {
    formData.area = requiredParkFormValue(formData, 'area', '装修区域');
    formData.startDate = validParkDate(
      requiredParkFormValue(formData, 'startDate', '计划开工日期'),
      '计划开工日期',
    );
  } else if (serviceId === 'parking') {
    const application = PARKING_APPLICATION_PRICES[
      requiredParkFormValue(formData, 'applicationType', '申请内容')
    ];
    if (!application) throw new Error('请选择有效的停车办理申请内容');
    const quantity = parkFormPositiveInteger(
      requiredParkFormValue(formData, 'quantity', '申请数量'),
      '申请数量',
    );
    formData.applicationType = application.label;
    formData.pricing = `${application.amount}元/${application.billingUnit}`;
    formData.billingUnit = application.billingUnit;
    const amountCny = application.amount * quantity;
    formData.amountCny = String(amountCny);
    formData.recurringMonthlyCny = String(
      application.billingUnit === '月'
        ? amountCny
        : application.billingUnit === '半年'
          ? Math.round((amountCny / 6) * 100) / 100
          : 0,
    );
  } else if (serviceId === 'network-phone') {
    const business = NETWORK_PHONE_PRICES[
      requiredParkFormValue(formData, 'businessType', '业务类型')
    ];
    if (!business) throw new Error('请选择有效的网络或电话业务类型');
    const quantity = parkFormPositiveInteger(
      requiredParkFormValue(formData, 'quantity', '工位或号码数量'),
      '工位或号码数量',
    );
    formData.businessType = business.label;
    formData.expectedDate = validParkDate(
      requiredParkFormValue(formData, 'expectedDate', '期望开通日期'),
      '期望开通日期',
    );
    formData.amountCny = String(business.amount * quantity);
    formData.recurringMonthlyCny = String(business.recurringMonthly * quantity);
  } else if (serviceId === 'meeting-room') {
    parkFormPositiveInteger(requiredParkFormValue(formData, 'attendees', '参会人数'), '参会人数');
    formData.roomId = requiredParkFormValue(formData, 'roomId', '会议室');
    formData.date = validParkDate(requiredParkFormValue(formData, 'date', '使用日期'), '使用日期');
    const period = assertMeetingPeriod(
      requiredParkFormValue(formData, 'startTime', '开始时间'),
      requiredParkFormValue(formData, 'endTime', '结束时间'),
    );
    const priceHalfDay = parkFormMoney(
      requiredParkFormValue(formData, 'priceHalfDay', '会议室价格'),
      '会议室价格',
    );
    const halfDayUnits = Math.ceil((period.endMinutes - period.startMinutes) / (4 * 60));
    formData.startTime = period.startTime;
    formData.endTime = period.endTime;
    formData.time = `${period.startTime}-${period.endTime}`;
    formData.amountCny = String(priceHalfDay * halfDayUnits);
    formData.pricing = `${priceHalfDay}元/半天，不足半天按半天计`;
  } else if (serviceId === 'electric-card') {
    formData.amount = String(
      parkFormMoney(requiredParkFormValue(formData, 'amount', '充值金额'), '充值金额'),
    );
    formData.amountCny = formData.amount;
  } else if (serviceId === 'repair') {
    formData.category = requiredParkFormValue(formData, 'category', '报修类别');
    formData.issue = requiredParkFormValue(formData, 'issue', '故障描述');
    formData.urgency = requiredParkFormValue(formData, 'urgency', '紧急程度');
  } else if (serviceId === 'vehicle-visit') {
    formData.visitDate = validParkDate(
      requiredParkFormValue(formData, 'visitDate', '来访日期'),
      '来访日期',
    );
    formData.reason = requiredParkFormValue(formData, 'reason', '拜访企业及事由');
    const vehicleCount = parkFormPositiveInteger(
      requiredParkFormValue(formData, 'vehicleCount', '来访车辆数量'),
      '来访车辆数量',
      true,
    );
    if (vehicleCount > 20) throw new Error('来访车辆数量不能超过 20');
    for (let index = 1; index <= vehicleCount; index += 1) {
      formData[`plate${index}`] = requiredParkFormValue(
        formData,
        `plate${index}`,
        `第 ${index} 辆车车牌号`,
      );
    }
  }
  return formData;
}

export function createTicket(input: {
  createdByAccountId: string;
  serviceId?: string;
  title: string;
  description: string;
  targetTags?: string[];
  formData?: Record<string, string>;
  category?: string;
  location?: string;
  urgency?: string;
  contact?: string;
  contactPhone?: string;
}): TicketView {
  const creator = getAccount(input.createdByAccountId);
  if (!creator) throw new Error('Account not found');
  const title = input.title.trim();
  const description = input.description.trim();
  const targetTags = normalizeTags(
    input.targetTags?.length ? input.targetTags : ['IT', '报修'],
  );
  if (!title || !description || targetTags.length === 0) {
    throw new Error('title, description and targetTags required');
  }

  const serviceId = input.serviceId?.trim() || 'it';
  const isParkService = PARK_SERVICE_IDS.has(serviceId);
  const normalizedFormData = isParkService
    ? normalizeParkServiceFormData(serviceId, input.formData ?? {})
    : input.formData ?? {};
  if (serviceId !== 'it' && !isParkService) throw new Error('服务类型不正确');

  const candidatePark = isParkService
    ? getParkForOrganization(creator.organizationId)
    : null;
  if (isParkService && !candidatePark) {
    throw new Error('企业尚未加入产业园');
  }
  if (
    candidatePark &&
    (!getOrganizationFeatures(creator.organizationId).park_service ||
      !getOrganizationFeatures(candidatePark.adminOrganizationId).park_service)
  ) {
    throw new Error('园区服务功能已由管理员关闭');
  }
  const park = candidatePark;
  const configuredParkService = park
    ? listParkServices(park.id).find((item) => item.id === serviceId)
    : undefined;
  if (park && !configuredParkService) throw new Error('园区服务不存在');
  if (configuredParkService && !configuredParkService.enabled) {
    throw new Error('园区服务已停用');
  }
  const parkSpecialists = park
    ? listParkServiceSpecialists(park.id).filter(
        (item) => item.serviceId === serviceId,
      )
    : [];
  const parkAdminFallback =
    park && parkSpecialists.length === 0
      ? (
          getDB()
            .prepare(
              `SELECT * FROM accounts WHERE organization_id = ? AND is_admin = 1
       AND status = 'active' AND deleted_at IS NULL ORDER BY name, username`,
            )
            .all(park.adminOrganizationId) as AccountRow[]
        ).map(toAccountView)
      : [];
  const placeholders = targetTags.map(() => '?').join(', ');
  const recipients =
    parkSpecialists.length > 0
      ? parkSpecialists
          .map((item) => getAccount(item.accountId))
          .filter((account): account is AccountView => account !== null)
      : parkAdminFallback.length > 0
        ? parkAdminFallback
        : (
            getDB()
              .prepare(
                `SELECT a.* FROM accounts a
     JOIN account_tags t ON t.account_id = a.id
     WHERE a.organization_id = ? AND t.organization_id = ?
       AND a.status = 'active' AND t.tag IN (${placeholders})
     GROUP BY a.id
     HAVING COUNT(DISTINCT t.tag) = ?
     ORDER BY a.name, a.username`,
              )
              .all(
                creator.organizationId,
                creator.organizationId,
                ...targetTags,
                targetTags.length,
              ) as AccountRow[]
          ).map(toAccountView);

  const id = `ticket_${randomUUID()}`;
  getDB()
    .prepare(
      `INSERT INTO it_tickets
       (id, organization_id, park_id, created_by_account_id, service_id, title, description, target_tags, form_data,
        category, location, urgency, contact, contact_phone, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '待接单')`,
    )
    .run(
      id,
      creator.organizationId,
      park?.id ?? null,
      creator.id,
      serviceId,
      title,
      description,
      JSON.stringify(targetTags),
      JSON.stringify(normalizedFormData),
      input.category?.trim() || null,
      input.location?.trim() || null,
      input.urgency?.trim() || null,
      input.contact?.trim() || null,
      input.contactPhone?.trim() || null,
    );
  recordTicketEvent({
    organizationId: creator.organizationId,
    ticketId: id,
    actorAccountId: creator.id,
    action: 'created',
    statusBefore: null,
    statusAfter: '待接单',
  });
  const deliver = getDB().prepare(
    `INSERT INTO ticket_deliveries (organization_id, ticket_id, account_id)
     VALUES (?, ?, ?)`,
  );
  for (const recipient of recipients)
    deliver.run(creator.organizationId, id, recipient.id);
  logAudit(
    'ticket_create',
    creator.employeeId,
    `Ticket ${id} delivered to ${recipients.length} account(s)`,
    creator.organizationId,
  );
  return ticketView(id, creator.id);
}

/** 通知只能在服务端使用完整账号资料，绝不把手机号或飞书 open_id 返回给普通客户端。 */
export function getTicketNotificationRecipients(
  ticketId: string,
): AccountView[] {
  const row = getDB()
    .prepare('SELECT organization_id FROM it_tickets WHERE id = ?')
    .get(ticketId) as { organization_id: string } | undefined;
  if (!row) return [];
  const deliveries = getDB()
    .prepare(
      `SELECT account_id FROM ticket_deliveries
     WHERE ticket_id = ? AND organization_id = ? AND status <> 'transferred' ORDER BY delivered_at`,
    )
    .all(ticketId, row.organization_id) as Array<{ account_id: string }>;
  return deliveries
    .map(({ account_id: accountId }) => getAccount(accountId))
    .filter((account): account is AccountView => account !== null);
}

export function getTicketTransferredNotificationRecipients(
  ticketId: string,
): AccountView[] {
  const row = getDB()
    .prepare('SELECT organization_id FROM it_tickets WHERE id = ?')
    .get(ticketId) as { organization_id: string } | undefined;
  if (!row) return [];
  const deliveries = getDB().prepare(
    `SELECT account_id FROM ticket_deliveries
     WHERE ticket_id = ? AND organization_id = ? AND status = 'transferred'
     ORDER BY delivered_at`,
  ).all(ticketId, row.organization_id) as Array<{ account_id: string }>;
  return deliveries
    .map(({ account_id: accountId }) => getAccount(accountId))
    .filter((account): account is AccountView => account !== null);
}

export function listTicketInbox(accountId: string): TicketView[] {
  const ids = getDB()
    .prepare(
      `SELECT t.id FROM ticket_deliveries d
     JOIN it_tickets t ON t.id = d.ticket_id
     WHERE d.account_id = ? AND d.organization_id = t.organization_id
     ORDER BY t.updated_at DESC, t.created_at DESC`,
    )
    .all(accountId) as Array<{ id: string }>;
  return ids.map(({ id }) => ticketView(id, accountId));
}

export function listTicketsForAccount(accountId: string): TicketView[] {
  const account = getAccount(accountId);
  if (!account) throw new Error('Account not found');
  const managedPark = getDB()
    .prepare(
      'SELECT id FROM parks WHERE admin_organization_id = ? AND status = ? LIMIT 1',
    )
    .get(account.organizationId, 'active') as { id: string } | undefined;
  const ids = (
    account.isAdmin
      ? managedPark
        ? getDB()
            .prepare(
              `SELECT id FROM it_tickets WHERE organization_id = ? OR park_id = ?
         ORDER BY updated_at DESC, created_at DESC`,
            )
            .all(account.organizationId, managedPark.id)
        : getDB()
            .prepare(
              `SELECT id FROM it_tickets WHERE organization_id = ? ORDER BY updated_at DESC, created_at DESC`,
            )
            .all(account.organizationId)
      : getDB()
          .prepare(
            `SELECT DISTINCT t.id FROM it_tickets t
       LEFT JOIN ticket_deliveries d ON d.ticket_id = t.id AND d.account_id = ?
       WHERE t.created_by_account_id = ? OR d.account_id = ?
       ORDER BY t.updated_at DESC, t.created_at DESC`,
          )
          .all(account.id, account.id, account.id)
  ) as Array<{ id: string }>;
  return ids.map(({ id }) => ticketView(id, account.id));
}

export function markTicketRead(
  ticketId: string,
  accountId: string,
): TicketView {
  const account = getAccount(accountId);
  if (!account) throw new Error('Account not found');
  const changed = getDB()
    .prepare(
      `UPDATE ticket_deliveries SET status = 'read', read_at = COALESCE(read_at, datetime('now'))
     WHERE ticket_id = ? AND account_id = ?`,
    )
    .run(ticketId, account.id);
  if (changed.changes === 0) throw new Error('Ticket delivery not found');
  return ticketView(ticketId, accountId);
}

export function updateTicket(input: {
  ticketId: string;
  accountId: string;
  action: 'respond' | 'accept' | 'complete' | 'confirm' | 'transfer';
  responseType?: string;
  responseText?: string;
  transferAccountId?: string;
  transferDepartment?: string;
}): TicketView {
  const account = getAccount(input.accountId);
  if (!account) throw new Error('Account not found');
  const database = getDB();
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = getTicketForAccount(input.ticketId, input.accountId);
    if (!current) throw new Error('Ticket not found');
    const ticketRow = database.prepare(
      'SELECT organization_id FROM it_tickets WHERE id = ?',
    ).get(input.ticketId) as { organization_id: string };
    const isActiveRecipient = Boolean(
      current.isRecipient && current.deliveryStatus !== 'transferred',
    );
    let statusAfter = current.status;
    let responseType: string | null = null;
    let responseText: string | null = null;

    if (input.action === 'confirm') {
      if (!current.isCreator) throw new Error('Only ticket creator can confirm');
      if (current.status !== '待验收') throw new Error('Ticket is not awaiting acceptance');
      statusAfter = '已完成';
      database.prepare(
        `UPDATE it_tickets SET status = '已完成', closed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND organization_id = ?`,
      ).run(input.ticketId, ticketRow.organization_id);
    } else {
      if (!isActiveRecipient) throw new Error('Only the currently assigned worker can update');
      if (input.action === 'respond') {
        if (!['待接单', '待派单', '维修中', '处理中', '已转交'].includes(current.status)) {
          throw new Error('Completed ticket cannot be updated');
        }
        responseType = input.responseType?.trim() || '';
        responseText = input.responseText?.trim() || '';
        if (!responseType || !responseText) {
          throw new Error('responseType and responseText required');
        }
        if (responseType.length > 80 || responseText.length > 2000) {
          throw new Error('Repair response is too long');
        }
        const isParkService = Boolean(current.parkId);
        statusAfter = current.serviceId === 'repair' && current.parkId
          ? ['待接单', '待派单'].includes(current.status) ? '已完成' : current.status
          : isParkService
            ? '已完成'
            : responseType === '已完成维修' ? '待验收' : current.status;
        database.prepare(
          `UPDATE it_tickets SET response_type = ?, response_text = ?, response_at = datetime('now'),
           status = ?,
           completed_at = CASE WHEN ? IN ('待验收', '已完成') THEN datetime('now') ELSE completed_at END,
           closed_at = CASE WHEN ? = '已完成' THEN datetime('now') ELSE closed_at END,
           updated_at = datetime('now') WHERE id = ? AND organization_id = ?`,
        ).run(
          responseType,
          responseText,
          statusAfter,
          statusAfter,
          statusAfter,
          input.ticketId,
          ticketRow.organization_id,
        );
      } else if (input.action === 'transfer') {
        if (current.serviceId !== 'repair' || !current.parkId) {
          throw new Error('只有物业报修可以转交');
        }
        if (!['待接单', '待派单', '维修中', '处理中'].includes(current.status)) {
          throw new Error('当前报修不能转交');
        }
        const park = getPark(current.parkId);
        if (!park) throw new Error('产业园不存在');
        const transferAccountId = input.transferAccountId?.trim() || '';
        const transferDepartment = input.transferDepartment?.trim() || '';
        let targets: AccountView[] = [];
        if (transferAccountId) {
          const target = getAccount(transferAccountId, park.adminOrganizationId);
          if (target?.status === 'active' && target.id !== account.id) targets = [target];
        } else if (transferDepartment) {
          targets = (database.prepare(
            `SELECT * FROM accounts
             WHERE organization_id = ? AND department = ? AND status = 'active'
               AND deleted_at IS NULL AND id <> ?
             ORDER BY name, username`,
          ).all(park.adminOrganizationId, transferDepartment, account.id) as AccountRow[])
            .map(toAccountView);
        }
        if (!targets.length) throw new Error('请选择有效的转交同事或部门');
        const targetLabel = transferAccountId
          ? targets[0]!.name
          : `${transferDepartment}（${targets.length} 人）`;
        responseType = `已转交至${targetLabel}`;
        responseText = input.responseText?.trim()
          || '请接手处理该物业报修，并在完成后确认工作结果。';
        if (responseText.length > 2000) throw new Error('转交说明不能超过 2000 个字符');
        statusAfter = '已转交';
        database.prepare(
          `UPDATE it_tickets SET response_type = ?, response_text = ?, response_at = datetime('now'),
           status = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?`,
        ).run(responseType, responseText, statusAfter, input.ticketId, ticketRow.organization_id);
        database.prepare(
          `UPDATE ticket_deliveries SET status = 'transferred', read_at = COALESCE(read_at, datetime('now'))
           WHERE ticket_id = ?`,
        ).run(input.ticketId);
        const deliver = database.prepare(
          `INSERT INTO ticket_deliveries (organization_id, ticket_id, account_id, status, read_at)
           VALUES (?, ?, ?, 'delivered', NULL)
           ON CONFLICT(ticket_id, account_id) DO UPDATE SET status = 'delivered', read_at = NULL,
             delivered_at = datetime('now')`,
        );
        for (const target of targets) {
          deliver.run(ticketRow.organization_id, input.ticketId, target.id);
        }
      } else if (input.action === 'accept') {
        if (!['待接单', '待派单'].includes(current.status)) {
          throw new Error('Ticket cannot be accepted');
        }
        statusAfter = current.serviceId === 'repair' ? '维修中' : '处理中';
        database.prepare(
          `UPDATE it_tickets SET status = ?, accepted_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ? AND organization_id = ?`,
        ).run(statusAfter, input.ticketId, ticketRow.organization_id);
      } else if (input.action === 'complete') {
        if (current.serviceId === 'repair' && current.parkId && current.status === '已转交') {
          statusAfter = '已完成';
          responseType = input.responseType?.trim() || '现场工作已完成';
          responseText = input.responseText?.trim() || '工作人员已完成转交事项。';
          database.prepare(
            `UPDATE it_tickets SET status = '已完成', response_type = ?, response_text = ?,
             response_at = datetime('now'), completed_at = datetime('now'), closed_at = datetime('now'),
             updated_at = datetime('now') WHERE id = ? AND organization_id = ?`,
          ).run(responseType, responseText, input.ticketId, ticketRow.organization_id);
        } else {
          if (!['维修中', '处理中'].includes(current.status)) {
            throw new Error('Ticket is not being processed');
          }
          statusAfter = '待验收';
          database.prepare(
            `UPDATE it_tickets SET status = '待验收', completed_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ? AND organization_id = ?`,
          ).run(input.ticketId, ticketRow.organization_id);
        }
      }
    }

    recordTicketEvent({
      organizationId: ticketRow.organization_id,
      ticketId: input.ticketId,
      actorAccountId: account.id,
      action: input.action,
      statusBefore: current.status,
      statusAfter,
      responseType,
      responseText,
    });
    logAudit(
      `ticket_${input.action}`,
      account.employeeId,
      `Ticket ${input.ticketId} ${input.action}`,
      ticketRow.organization_id,
    );
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* preserve the original error */ }
    throw error;
  }
  return ticketView(input.ticketId, input.accountId);
}

export function recordTicketNotification(input: {
  ticketId: string;
  recipientAccountId: string;
  channel: 'otto' | 'sms' | 'feishu';
  event: string;
  status: 'sent' | 'failed' | 'skipped';
  detail?: string | null;
}): void {
  const ticket = getDB()
    .prepare('SELECT organization_id FROM it_tickets WHERE id = ?')
    .get(input.ticketId) as { organization_id: string } | undefined;
  if (!ticket) throw new Error('Ticket not found');
  getDB()
    .prepare(
      `INSERT INTO ticket_notifications
      (id, organization_id, ticket_id, recipient_account_id, channel, event, status, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ticket_notice_${randomUUID()}`,
      ticket.organization_id,
      input.ticketId,
      input.recipientAccountId,
      input.channel,
      input.event,
      input.status,
      input.detail ?? null,
    );
}
