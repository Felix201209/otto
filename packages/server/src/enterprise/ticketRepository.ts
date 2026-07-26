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
  status: string;
  created_at: string;
  updated_at: string;
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
  const recipientAccounts = deliveries
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
      JSON.stringify(input.formData ?? {}),
      input.category?.trim() || null,
      input.location?.trim() || null,
      input.urgency?.trim() || null,
      input.contact?.trim() || null,
      input.contactPhone?.trim() || null,
    );
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
     WHERE ticket_id = ? AND organization_id = ? ORDER BY delivered_at`,
    )
    .all(ticketId, row.organization_id) as Array<{ account_id: string }>;
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
  action: 'respond' | 'accept' | 'complete' | 'confirm';
  responseType?: string;
  responseText?: string;
}): TicketView {
  const account = getAccount(input.accountId);
  if (!account) throw new Error('Account not found');
  const current = getTicketForAccount(input.ticketId, input.accountId);
  if (!current) throw new Error('Ticket not found');
  const ticketRow = getDB()
    .prepare('SELECT organization_id FROM it_tickets WHERE id = ?')
    .get(input.ticketId) as { organization_id: string };
  const isRecipient = Boolean(current.isRecipient);
  if (input.action === 'confirm') {
    if (!current.isCreator) throw new Error('Only ticket creator can confirm');
    if (current.status !== '待验收')
      throw new Error('Ticket is not awaiting acceptance');
    getDB()
      .prepare(
        `UPDATE it_tickets SET status = '已完成', closed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND organization_id = ?`,
      )
      .run(input.ticketId, ticketRow.organization_id);
  } else {
    if (!isRecipient)
      throw new Error('Only assigned repair workers can update');
    if (input.action === 'respond') {
      const responseType = input.responseType?.trim() || '';
      const responseText = input.responseText?.trim() || '';
      if (!responseType || !responseText)
        throw new Error('responseType and responseText required');
      if (responseType.length > 50 || responseText.length > 2000)
        throw new Error('Repair response is too long');
      const nextStatus =
        responseType === '已完成维修' ? '待验收' : current.status;
      getDB()
        .prepare(
          `UPDATE it_tickets SET response_type = ?, response_text = ?, response_at = datetime('now'),
          status = ?, completed_at = CASE WHEN ? = '待验收' THEN datetime('now') ELSE completed_at END,
          updated_at = datetime('now') WHERE id = ? AND organization_id = ?`,
        )
        .run(
          responseType,
          responseText,
          nextStatus,
          nextStatus,
          input.ticketId,
          ticketRow.organization_id,
        );
    } else if (input.action === 'accept') {
      if (!['待接单', '待派单'].includes(current.status))
        throw new Error('Ticket cannot be accepted');
      const acceptedStatus =
        current.serviceId === 'repair' ? '维修中' : '处理中';
      getDB()
        .prepare(
          `UPDATE it_tickets SET status = ?, accepted_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND organization_id = ?`,
        )
        .run(acceptedStatus, input.ticketId, ticketRow.organization_id);
    } else if (input.action === 'complete') {
      if (!['维修中', '处理中'].includes(current.status))
        throw new Error('Ticket is not being processed');
      getDB()
        .prepare(
          `UPDATE it_tickets SET status = '待验收', completed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND organization_id = ?`,
        )
        .run(input.ticketId, ticketRow.organization_id);
    }
  }
  logAudit(
    `ticket_${input.action}`,
    account.employeeId,
    `Ticket ${input.ticketId} ${input.action}`,
    ticketRow.organization_id,
  );
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
