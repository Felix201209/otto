/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import { normalizeParkServiceFormData } from './parkServiceFormRules.js';
import type {
  CreateTicketInput,
  ParkTicketAccount,
  ParkTicketPark,
  ParkTicketService,
  ParkTicketSpecialist,
  RecordTicketNotificationInput,
  TicketHistoryAction,
  TicketHistoryEntry,
  TicketView,
  UpdateTicketInput,
} from './parkTicketTypes.js';

export interface ParkTicketRepositoryStore<
  TAccount extends ParkTicketAccount = ParkTicketAccount,
> {
  db(): Database;
  getAccount(accountId: string, organizationId?: string): TAccount | null;
  isOrganizationActive(organizationId: string): boolean;
  getOrganizationFeatures(organizationId: string): { park_service: boolean };
  getPark(parkId: string): ParkTicketPark | null;
  getParkForOrganization(organizationId: string): ParkTicketPark | null;
  listParkServices(parkId: string): ParkTicketService[];
  listParkServiceSpecialists(parkId: string): ParkTicketSpecialist[];
  listActiveOrganizationAdmins(organizationId: string): TAccount[];
  listActiveAccountsByDepartment(
    organizationId: string,
    department: string,
    excludeAccountId: string,
  ): TAccount[];
  listActiveAccountsByTags(organizationId: string, tags: string[]): TAccount[];
  normalizeTags(tags: string[] | undefined): string[];
  isParkServiceId(serviceId: string): boolean;
  createTicketId(): string;
  createTicketEventId(): string;
  createTicketNotificationId(): string;
  now?(): Date;
  audit(
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
}

interface TicketRow {
  id: string;
  application_number: string | null;
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
  accepted_by_account_id: string | null;
  released_at: string | null;
  release_reason: string | null;
  released_by_account_id: string | null;
  completed_at: string | null;
  closed_at: string | null;
  creator_update_at: string | null;
  creator_update_read_at: string | null;
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

function recordTicketEvent<TAccount extends ParkTicketAccount>(
  store: ParkTicketRepositoryStore<TAccount>,
  input: {
    organizationId: string;
    ticketId: string;
    actorAccountId: string | null;
    action: TicketHistoryAction;
    statusBefore: string | null;
    statusAfter: string;
    responseType?: string | null;
    responseText?: string | null;
  },
): void {
  store.db().prepare(
    `INSERT INTO ticket_events
     (id, organization_id, ticket_id, actor_account_id, action, status_before, status_after,
      response_type, response_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    store.createTicketEventId(),
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

function shanghaiApplicationDateKey(date: Date): string {
  const shanghaiTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return [
    shanghaiTime.getUTCFullYear(),
    String(shanghaiTime.getUTCMonth() + 1).padStart(2, '0'),
    String(shanghaiTime.getUTCDate()).padStart(2, '0'),
  ].join('');
}

function allocateParkApplicationNumber<TAccount extends ParkTicketAccount>(
  store: ParkTicketRepositoryStore<TAccount>,
  parkId: string,
): string {
  const dateKey = shanghaiApplicationDateKey(store.now?.() ?? new Date());
  const row = store.db().prepare(
    `INSERT INTO park_application_sequences
       (park_id, date_key, last_sequence, updated_at)
     VALUES (?, ?, 1, datetime('now'))
     ON CONFLICT(park_id, date_key) DO UPDATE SET
       last_sequence = park_application_sequences.last_sequence + 1,
       updated_at = datetime('now')
     WHERE park_application_sequences.last_sequence < 999
     RETURNING last_sequence`,
  ).get(parkId, dateKey) as { last_sequence: number } | undefined;
  if (!row) {
    throw new Error('本园区当日申请数量已达到 999 条上限');
  }
  return `${dateKey}${String(row.last_sequence).padStart(3, '0')}`;
}

function ticketView<TAccount extends ParkTicketAccount>(
  store: ParkTicketRepositoryStore<TAccount>,
  id: string,
  viewerAccountId?: string,
): TicketView {
  const row = store.db()
    .prepare('SELECT * FROM it_tickets WHERE id = ?')
    .get(id) as TicketRow | undefined;
  if (!row) throw new Error('Ticket not found');
  const activeCreator = store.getAccount(
    row.created_by_account_id,
    row.organization_id,
  );
  const creatorRow = activeCreator
    ? null
    : (store.db()
        .prepare(
          `SELECT id FROM accounts WHERE id = ? AND organization_id = ? AND deleted_at IS NOT NULL`,
        )
        .get(row.created_by_account_id, row.organization_id) as
        { id: string } | undefined);
  const creator: { id: string; name: string; username: string } | null =
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
  const deliveries = store.db()
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
    .map((delivery) => store.getAccount(delivery.account_id))
    .filter((account): account is TAccount => (
      account?.status === 'active'
      && store.isOrganizationActive(account.organizationId)
    ));
  const viewer = viewerAccountId ? store.getAccount(viewerAccountId) : null;
  const canSeeRecipients = viewer?.isAdmin || viewerAccountId === creator.id;
  const viewerDelivery = viewerAccountId
    ? deliveries.find((delivery) => delivery.account_id === viewerAccountId)
    : undefined;
  const notifications = viewer?.isAdmin
    ? (store.db()
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
  const eventRows = store.db().prepare(
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
  if (!hasAction('transfer')) {
    addLegacyEvent(
      'respond',
      row.response_at,
      row.accepted_at ? processingStatus : '待接单',
      row.response_type === '已完成维修' ? '待验收' : row.status,
      20,
      row.response_type,
      row.response_text,
    );
  }
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
  const handler = row.accepted_by_account_id
    ? store.getAccount(row.accepted_by_account_id)
    : null;
  return {
    id: row.id,
    applicationNumber: row.application_number,
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
    acceptedBy: handler
      ? { id: handler.id, name: handler.name }
      : null,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
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
    creatorUpdateAt: row.creator_update_at,
    creatorUpdateReadAt: row.creator_update_read_at,
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

export function getTicketForAccount<TAccount extends ParkTicketAccount>(
  store: ParkTicketRepositoryStore<TAccount>,
  id: string,
  accountId: string,
): TicketView | null {
  const account = store.getAccount(accountId);
  if (
    !account
    || account.status !== 'active'
    || !store.isOrganizationActive(account.organizationId)
  ) return null;
  const row = store.db()
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
  if (!store.isOrganizationActive(row.organization_id)) return null;
  const delivery = store.db()
    .prepare(
      `SELECT 1 FROM ticket_deliveries
       WHERE ticket_id = ? AND account_id = ? AND organization_id = ?`,
    )
    .get(id, accountId, row.organization_id);
  const park = row.park_id ? store.getPark(row.park_id) : null;
  if (row.park_id && (!park || park.status !== 'active')) return null;
  const isCreatorOrganizationAdmin =
    account.isAdmin && account.organizationId === row.organization_id;
  const isParkAdmin =
    account.isAdmin
    && park?.status === 'active'
    && park.adminOrganizationId === account.organizationId;
  if (
    row.created_by_account_id !== accountId &&
    !delivery &&
    !isCreatorOrganizationAdmin &&
    !isParkAdmin
  )
    return null;
  return ticketView(store, id, accountId);
}

/**
 * 仅向已经有权查看该工单的账号返回创建者联系方式。园区处理方可以据此向
 * 跨组织创建者发送进度回执，但不能把 accountId 当作跨租户任意账号查询器。
 */
export function getTicketCreatorForAccount<TAccount extends ParkTicketAccount>(
  store: ParkTicketRepositoryStore<TAccount>,
  id: string,
  accountId: string,
): TAccount | null {
  if (!getTicketForAccount(store, id, accountId)) return null;
  const row = store.db()
    .prepare(
      'SELECT organization_id, created_by_account_id FROM it_tickets WHERE id = ?',
    )
    .get(id) as
    { organization_id: string; created_by_account_id: string } | undefined;
  const creator = row
    ? store.getAccount(row.created_by_account_id, row.organization_id)
    : null;
  return creator?.status === 'active'
    && store.isOrganizationActive(creator.organizationId)
    ? creator
    : null;
}

/** 已授权账号是否仍可使用该工单所属功能；企业 IT 工单不受园区开关影响。 */
export function isTicketFeatureEnabledForAccount<
  TAccount extends ParkTicketAccount,
>(
  store: ParkTicketRepositoryStore<TAccount>,
  id: string,
  accountId: string,
): boolean {
  if (!getTicketForAccount(store, id, accountId)) return false;
  const viewer = store.getAccount(accountId);
  if (!viewer) return false;
  const row = store.db()
    .prepare('SELECT organization_id, park_id FROM it_tickets WHERE id = ?')
    .get(id) as { organization_id: string; park_id: string | null } | undefined;
  if (!row) return false;
  return (
    row.park_id === null ||
    (store.getOrganizationFeatures(row.organization_id).park_service &&
      store.getOrganizationFeatures(viewer.organizationId).park_service)
  );
}

export function createTicket<TAccount extends ParkTicketAccount>(
  store: ParkTicketRepositoryStore<TAccount>,
  input: CreateTicketInput,
): TicketView {
  const creator = store.getAccount(input.createdByAccountId);
  if (
    !creator
    || creator.status !== 'active'
    || !store.isOrganizationActive(creator.organizationId)
  ) {
    throw new Error('Account or organization is inactive');
  }
  const title = input.title.trim();
  const description = input.description.trim();
  const targetTags = store.normalizeTags(
    input.targetTags?.length ? input.targetTags : ['IT', '报修'],
  );
  if (!title || !description || targetTags.length === 0) {
    throw new Error('title, description and targetTags required');
  }
  if (title.length > 200 || description.length > 2_000) {
    throw new Error('Ticket title or description is too long');
  }

  const serviceId = input.serviceId?.trim() || 'it';
  const isParkService = store.isParkServiceId(serviceId);
  const normalizedFormData = isParkService
    ? normalizeParkServiceFormData(serviceId, input.formData ?? {})
    : input.formData ?? {};
  if (serviceId !== 'it' && !isParkService) throw new Error('服务类型不正确');

  const candidatePark = isParkService
    ? store.getParkForOrganization(creator.organizationId)
    : null;
  if (isParkService && (!candidatePark || candidatePark.status !== 'active')) {
    throw new Error('企业尚未加入产业园');
  }
  if (
    candidatePark &&
    (!store.getOrganizationFeatures(creator.organizationId).park_service ||
      !store.getOrganizationFeatures(candidatePark.adminOrganizationId).park_service)
  ) {
    throw new Error('园区服务功能已由管理员关闭');
  }
  const park = candidatePark;
  const configuredParkService = park
    ? store.listParkServices(park.id).find((item) => item.id === serviceId)
    : undefined;
  if (park && !configuredParkService) throw new Error('园区服务不存在');
  if (configuredParkService && !configuredParkService.enabled) {
    throw new Error('园区服务已停用');
  }
  const parkSpecialists = park
    ? store.listParkServiceSpecialists(park.id).filter(
        (item) => item.serviceId === serviceId,
      )
    : [];
  const specialistRecipients = park
    ? parkSpecialists
        .map((item) => store.getAccount(item.accountId, park.adminOrganizationId))
        .filter((account): account is TAccount => account?.status === 'active')
    : [];
  const parkAdminFallback =
    park && specialistRecipients.length === 0
      ? store.listActiveOrganizationAdmins(park.adminOrganizationId)
      : [];
  const recipients =
    specialistRecipients.length > 0
      ? specialistRecipients
      : parkAdminFallback.length > 0
        ? parkAdminFallback
        : store.listActiveAccountsByTags(creator.organizationId, targetTags);

  const id = store.createTicketId();
  const database = store.db();
  const ownsTransaction = !database.inTransaction;
  if (ownsTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    const applicationNumber = park
      ? allocateParkApplicationNumber(store, park.id)
      : null;
    database.prepare(
      `INSERT INTO it_tickets
       (id, organization_id, park_id, application_number, created_by_account_id, service_id, title, description, target_tags, form_data,
        category, location, urgency, contact, contact_phone, status,
        creator_update_at, creator_update_read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '待接单', NULL, datetime('now'))`,
    ).run(
      id,
      creator.organizationId,
      park?.id ?? null,
      applicationNumber,
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
    recordTicketEvent(store, {
      organizationId: creator.organizationId,
      ticketId: id,
      actorAccountId: creator.id,
      action: 'created',
      statusBefore: null,
      statusAfter: '待接单',
    });
    const deliver = database.prepare(
      `INSERT INTO ticket_deliveries (organization_id, ticket_id, account_id)
       VALUES (?, ?, ?)`,
    );
    for (const recipient of recipients) {
      deliver.run(creator.organizationId, id, recipient.id);
    }
    store.audit(
      'ticket_create',
      creator.employeeId,
      `Ticket ${id} delivered to ${recipients.length} account(s)`,
      creator.organizationId,
    );
    if (ownsTransaction) database.exec('COMMIT');
  } catch (error) {
    if (ownsTransaction && database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
  return ticketView(store, id, creator.id);
}

/** 通知只能在服务端使用完整账号资料，绝不把手机号或飞书 open_id 返回给普通客户端。 */
export function getTicketNotificationRecipients<TAccount extends ParkTicketAccount>(
  store: ParkTicketRepositoryStore<TAccount>,
  ticketId: string,
): TAccount[] {
  const row = store.db()
    .prepare('SELECT organization_id, park_id FROM it_tickets WHERE id = ?')
    .get(ticketId) as
      | { organization_id: string; park_id: string | null }
      | undefined;
  if (
    !row
    || !store.isOrganizationActive(row.organization_id)
    || (row.park_id && store.getPark(row.park_id)?.status !== 'active')
    || (row.park_id && !store.getOrganizationFeatures(row.organization_id).park_service)
  ) return [];
  const deliveries = store.db()
    .prepare(
      `SELECT account_id FROM ticket_deliveries
     WHERE ticket_id = ? AND organization_id = ? AND status <> 'transferred' ORDER BY delivered_at`,
    )
    .all(ticketId, row.organization_id) as Array<{ account_id: string }>;
  return deliveries
    .map(({ account_id: accountId }) => store.getAccount(accountId))
    .filter((account): account is TAccount => (
      account?.status === 'active'
      && store.isOrganizationActive(account.organizationId)
      && (
        !row.park_id
        || store.getOrganizationFeatures(account.organizationId).park_service
      )
    ));
}

export function getTicketTransferredNotificationRecipients<
  TAccount extends ParkTicketAccount,
>(
  store: ParkTicketRepositoryStore<TAccount>,
  ticketId: string,
): TAccount[] {
  const row = store.db()
    .prepare('SELECT organization_id, park_id FROM it_tickets WHERE id = ?')
    .get(ticketId) as
      | { organization_id: string; park_id: string | null }
      | undefined;
  if (
    !row
    || !store.isOrganizationActive(row.organization_id)
    || (row.park_id && store.getPark(row.park_id)?.status !== 'active')
    || (row.park_id && !store.getOrganizationFeatures(row.organization_id).park_service)
  ) return [];
  const deliveries = store.db().prepare(
    `SELECT account_id FROM ticket_deliveries
     WHERE ticket_id = ? AND organization_id = ? AND status = 'transferred'
     ORDER BY delivered_at`,
  ).all(ticketId, row.organization_id) as Array<{ account_id: string }>;
  return deliveries
    .map(({ account_id: accountId }) => store.getAccount(accountId))
    .filter((account): account is TAccount => (
      account?.status === 'active'
      && store.isOrganizationActive(account.organizationId)
      && (
        !row.park_id
        || store.getOrganizationFeatures(account.organizationId).park_service
      )
    ));
}

export function listTicketInbox<TAccount extends ParkTicketAccount>(
  store: ParkTicketRepositoryStore<TAccount>,
  accountId: string,
): TicketView[] {
  const account = store.getAccount(accountId);
  if (
    !account
    || account.status !== 'active'
    || !store.isOrganizationActive(account.organizationId)
  ) {
    throw new Error('Account or organization is inactive');
  }
  const ids = store.db()
    .prepare(
      `SELECT t.id FROM ticket_deliveries d
     JOIN it_tickets t ON t.id = d.ticket_id
     WHERE d.account_id = ? AND d.organization_id = t.organization_id
     ORDER BY t.updated_at DESC, t.created_at DESC`,
    )
    .all(accountId) as Array<{ id: string }>;
  return ids
    .map(({ id }) => getTicketForAccount(store, id, accountId))
    .filter((ticket): ticket is TicketView => ticket !== null);
}

export function listTicketsForAccount<TAccount extends ParkTicketAccount>(
  store: ParkTicketRepositoryStore<TAccount>,
  accountId: string,
): TicketView[] {
  const account = store.getAccount(accountId);
  if (
    !account
    || account.status !== 'active'
    || !store.isOrganizationActive(account.organizationId)
  ) {
    throw new Error('Account or organization is inactive');
  }
  const managedPark = store.db()
    .prepare(
      'SELECT id FROM parks WHERE admin_organization_id = ? AND status = ? LIMIT 1',
    )
    .get(account.organizationId, 'active') as { id: string } | undefined;
  const ids = (
    account.isAdmin
      ? managedPark
        ? store.db()
            .prepare(
              `SELECT id FROM it_tickets WHERE organization_id = ? OR park_id = ?
         ORDER BY updated_at DESC, created_at DESC`,
            )
            .all(account.organizationId, managedPark.id)
        : store.db()
            .prepare(
              `SELECT id FROM it_tickets WHERE organization_id = ? ORDER BY updated_at DESC, created_at DESC`,
            )
            .all(account.organizationId)
      : store.db()
          .prepare(
            `SELECT DISTINCT t.id FROM it_tickets t
       LEFT JOIN ticket_deliveries d ON d.ticket_id = t.id AND d.account_id = ?
       WHERE t.created_by_account_id = ? OR d.account_id = ?
       ORDER BY t.updated_at DESC, t.created_at DESC`,
          )
          .all(account.id, account.id, account.id)
  ) as Array<{ id: string }>;
  return ids
    .map(({ id }) => getTicketForAccount(store, id, account.id))
    .filter((ticket): ticket is TicketView => ticket !== null);
}

export function markTicketRead<TAccount extends ParkTicketAccount>(
  store: ParkTicketRepositoryStore<TAccount>,
  ticketId: string,
  accountId: string,
): TicketView {
  if (!getTicketForAccount(store, ticketId, accountId)) {
    throw new Error('Ticket not found');
  }
  const creatorChanged = store.db()
    .prepare(
      `UPDATE it_tickets SET creator_update_read_at = datetime('now')
       WHERE id = ? AND created_by_account_id = ?`,
    )
    .run(ticketId, accountId);
  const deliveryChanged = store.db()
    .prepare(
      `UPDATE ticket_deliveries
       SET status = CASE WHEN status = 'transferred' THEN status ELSE 'read' END,
           read_at = COALESCE(read_at, datetime('now'))
     WHERE ticket_id = ? AND account_id = ?`,
    )
    .run(ticketId, accountId);
  if (Number(creatorChanged.changes) + Number(deliveryChanged.changes) === 0) {
    throw new Error('Ticket delivery not found');
  }
  return ticketView(store, ticketId, accountId);
}

export function updateTicket<TAccount extends ParkTicketAccount>(
  store: ParkTicketRepositoryStore<TAccount>,
  input: UpdateTicketInput,
): TicketView {
  const account = store.getAccount(input.accountId);
  if (
    !account
    || account.status !== 'active'
    || !store.isOrganizationActive(account.organizationId)
  ) {
    throw new Error('Account or organization is inactive');
  }
  const database = store.db();
  const ownsTransaction = !database.inTransaction;
  if (ownsTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    const current = getTicketForAccount(store, input.ticketId, input.accountId);
    if (!current) throw new Error('Ticket not found');
    if (
      current.parkId
      && !isTicketFeatureEnabledForAccount(
        store,
        input.ticketId,
        input.accountId,
      )
    ) {
      throw new Error('园区服务功能已由管理员关闭');
    }
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
      if (input.action === 'respond_and_transfer') {
        if (current.serviceId !== 'repair' || !current.parkId) {
          throw new Error('只有物业报修可以回复并转交工程部');
        }
        if (!['待接单', '待派单', '维修中', '处理中'].includes(current.status)) {
          throw new Error('当前报修不能回复并转交工程部');
        }
        if (input.transferAccountId?.trim()) {
          throw new Error('物业报修不能指定个人，只能转交工程部');
        }
        const requestedDepartment = input.transferDepartment?.trim() || '工程部';
        if (requestedDepartment !== '工程部') {
          throw new Error('物业报修只能转交工程部');
        }
        const park = store.getPark(current.parkId);
        if (!park || park.status !== 'active') throw new Error('产业园不存在');
        const targets = store.listActiveAccountsByDepartment(
          park.adminOrganizationId,
          '工程部',
          account.id,
        );
        if (!targets.length) throw new Error('工程部暂无可接收报修的在职成员');

        responseType = input.responseType?.trim() || '';
        responseText = input.responseText?.trim() || '';
        if (!responseType || !responseText) {
          throw new Error('回复并转交工程部时必须填写回复类型和回复内容');
        }
        if (responseType.length > 80 || responseText.length > 2000) {
          throw new Error('Repair response is too long');
        }
        const transferNote = input.transferNote?.trim()
          || '请工程部接手处理该物业报修，并在完成后记录工作结果。';
        if (transferNote.length > 2000) {
          throw new Error('转交说明不能超过 2000 个字符');
        }

        statusAfter = '已转交';
        database.prepare(
          `UPDATE it_tickets SET response_type = ?, response_text = ?,
           response_at = datetime('now'), status = '已转交',
           creator_update_at = datetime('now'),
           creator_update_read_at = NULL, updated_at = datetime('now')
           WHERE id = ? AND organization_id = ?`,
        ).run(
          responseType,
          responseText,
          input.ticketId,
          ticketRow.organization_id,
        );
        recordTicketEvent(store, {
          organizationId: ticketRow.organization_id,
          ticketId: input.ticketId,
          actorAccountId: account.id,
          action: 'respond',
          statusBefore: current.status,
          statusAfter: current.status,
          responseType,
          responseText,
        });
        recordTicketEvent(store, {
          organizationId: ticketRow.organization_id,
          ticketId: input.ticketId,
          actorAccountId: account.id,
          action: 'transfer',
          statusBefore: current.status,
          statusAfter,
          responseType: '已转交至工程部',
          responseText: transferNote,
        });
        database.prepare(
          `UPDATE ticket_deliveries SET status = 'transferred'
           WHERE ticket_id = ?`,
        ).run(input.ticketId);
        const deliver = database.prepare(
          `INSERT INTO ticket_deliveries
           (organization_id, ticket_id, account_id, status, read_at)
           VALUES (?, ?, ?, 'delivered', NULL)
           ON CONFLICT(ticket_id, account_id) DO UPDATE SET
             status = 'delivered', read_at = NULL, delivered_at = datetime('now')`,
        );
        for (const target of targets) {
          deliver.run(ticketRow.organization_id, input.ticketId, target.id);
        }
      } else if (input.action === 'respond') {
        if (!['待接单', '待派单', '维修中', '处理中', '已转交'].includes(current.status)) {
          throw new Error('Completed ticket cannot be updated');
        }
        if (
          current.serviceId === 'repair'
          && current.parkId
          && current.status !== '已转交'
        ) {
          throw new Error('物业报修客服必须一次完成回复并转交工程部');
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
           creator_update_at = datetime('now'), creator_update_read_at = NULL,
           updated_at = datetime('now')
           WHERE id = ? AND organization_id = ?`,
        ).run(
          responseType,
          responseText,
          statusAfter,
          statusAfter,
          statusAfter,
          input.ticketId,
          ticketRow.organization_id,
        );
      } else if (input.action === 'accept') {
        if (!['待接单', '待派单'].includes(current.status)) {
          if (current.acceptedBy) {
            throw new Error(
              current.acceptedBy.id === account.id
                ? '工单已由您接单'
                : '工单已被他人接单',
            );
          }
          throw new Error('工单当前状态不可接单');
        }
        statusAfter = current.serviceId === 'repair' ? '维修中' : '处理中';
        // 原子抢单：条件更新 + 处理人记录，保证并发下只有一名专员获得工单。
        const claimResult = database.prepare(
          `UPDATE it_tickets
           SET status = ?, accepted_at = datetime('now'),
               accepted_by_account_id = ?, updated_at = datetime('now')
           WHERE id = ? AND organization_id = ?
             AND status IN ('待接单', '待派单') AND accepted_at IS NULL`,
        ).run(statusAfter, account.id, input.ticketId, ticketRow.organization_id);
        if (claimResult.changes !== 1) {
          throw new Error('工单已被他人接单');
        }
      } else if (input.action === 'release') {
        if (current.acceptedBy?.id !== account.id) {
          throw new Error('只有当前处理人可以退回工单');
        }
        if (!['维修中', '处理中'].includes(current.status)) {
          throw new Error('当前状态不能退回工单');
        }
        const releaseReason = input.releaseReason?.trim() || '暂时没空';
        if (releaseReason.length > 200) {
          throw new Error('退回原因不能超过 200 个字符');
        }
        statusAfter = '待接单';
        const releaseResult = database.prepare(
          `UPDATE it_tickets
           SET status = '待接单', accepted_at = NULL, accepted_by_account_id = NULL,
               released_at = datetime('now'), release_reason = ?,
               released_by_account_id = ?, updated_at = datetime('now')
           WHERE id = ? AND organization_id = ?
             AND accepted_by_account_id = ? AND status IN ('维修中', '处理中')`,
        ).run(
          releaseReason,
          account.id,
          input.ticketId,
          ticketRow.organization_id,
          account.id,
        );
        if (releaseResult.changes !== 1) {
          throw new Error('工单退回失败，请刷新后重试');
        }
        responseType = null;
        responseText = null;
      } else if (input.action === 'complete') {
        if (current.serviceId === 'repair' && current.parkId && current.status === '已转交') {
          statusAfter = '已完成';
          responseType = input.responseType?.trim() || '现场工作已完成';
          responseText = input.responseText?.trim() || '工作人员已完成转交事项。';
          database.prepare(
            `UPDATE it_tickets SET status = '已完成', response_type = ?, response_text = ?,
             response_at = datetime('now'), completed_at = datetime('now'), closed_at = datetime('now'),
             creator_update_at = datetime('now'), creator_update_read_at = NULL,
             updated_at = datetime('now')
             WHERE id = ? AND organization_id = ?`,
          ).run(responseType, responseText, input.ticketId, ticketRow.organization_id);
        } else {
          if (!['维修中', '处理中'].includes(current.status)) {
            throw new Error('Ticket is not being processed');
          }
          statusAfter = '待验收';
          database.prepare(
            `UPDATE it_tickets SET status = '待验收', completed_at = datetime('now'),
             creator_update_at = datetime('now'), creator_update_read_at = NULL,
             updated_at = datetime('now')
             WHERE id = ? AND organization_id = ?`,
          ).run(input.ticketId, ticketRow.organization_id);
        }
        database.prepare(
          `UPDATE ticket_deliveries SET read_at = NULL
           WHERE ticket_id = ? AND status = 'transferred'`,
        ).run(input.ticketId);
      } else {
        throw new Error('工单操作不正确');
      }
    }

    if (input.action !== 'respond_and_transfer') {
      recordTicketEvent(store, {
        organizationId: ticketRow.organization_id,
        ticketId: input.ticketId,
        actorAccountId: account.id,
        action: input.action,
        statusBefore: current.status,
        statusAfter,
        responseType,
        responseText,
      });
    }
    store.audit(
      `ticket_${input.action}`,
      account.employeeId,
      `Ticket ${input.ticketId} ${input.action}`,
      ticketRow.organization_id,
    );
    if (ownsTransaction) database.exec('COMMIT');
  } catch (error) {
    if (ownsTransaction && database.inTransaction) {
      try { database.exec('ROLLBACK'); } catch { /* preserve the original error */ }
    }
    throw error;
  }
  return ticketView(store, input.ticketId, input.accountId);
}

export function recordTicketNotification<TAccount extends ParkTicketAccount>(
  store: ParkTicketRepositoryStore<TAccount>,
  input: RecordTicketNotificationInput,
): void {
  const ticket = store.db()
    .prepare('SELECT organization_id FROM it_tickets WHERE id = ?')
    .get(input.ticketId) as { organization_id: string } | undefined;
  if (!ticket) throw new Error('Ticket not found');
  const recipient = store.getAccount(input.recipientAccountId);
  if (!recipient || recipient.status !== 'active') {
    throw new Error('Notification recipient is inactive');
  }
  const authorizedRecipient = store.db()
    .prepare(
      `SELECT 1 FROM it_tickets t
       WHERE t.id = ? AND t.organization_id = ?
         AND (
           t.created_by_account_id = ?
           OR EXISTS (
             SELECT 1 FROM ticket_deliveries d
             WHERE d.ticket_id = t.id
               AND d.organization_id = t.organization_id
               AND d.account_id = ?
           )
         )`,
    )
    .get(
      input.ticketId,
      ticket.organization_id,
      recipient.id,
      recipient.id,
    );
  if (!authorizedRecipient) {
    throw new Error('Notification recipient is not assigned');
  }
  store.db()
    .prepare(
      `INSERT INTO ticket_notifications
      (id, organization_id, ticket_id, recipient_account_id, channel, event, status, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      store.createTicketNotificationId(),
      ticket.organization_id,
      input.ticketId,
      input.recipientAccountId,
      input.channel,
      input.event,
      input.status,
      input.detail ?? null,
    );
}

interface ParkTicketBackupStore {
  db(): Database;
}

export function listParkTicketsForBackup(
  store: ParkTicketBackupStore,
  organizationId: string,
): Array<Record<string, unknown>> {
  return store.db()
    .prepare(
      `SELECT * FROM it_tickets
       WHERE organization_id = ?
       ORDER BY created_at DESC`,
    )
    .all(organizationId) as Array<Record<string, unknown>>;
}

export function listTicketDeliveriesForBackup(
  store: ParkTicketBackupStore,
  organizationId: string,
): Array<Record<string, unknown>> {
  return store.db()
    .prepare(
      `SELECT * FROM ticket_deliveries
       WHERE organization_id = ?
       ORDER BY delivered_at DESC`,
    )
    .all(organizationId) as Array<Record<string, unknown>>;
}
