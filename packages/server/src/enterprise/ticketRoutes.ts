/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import * as db from './db.js';
import type { RepairNotificationSender } from './repairNotifications.js';

interface TicketRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  repairSmsSender: RepairNotificationSender | null;
  repairFeishuSender: RepairNotificationSender | null;
  extractToken(req: IncomingMessage): string;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

async function sendRepairNotifications(input: {
  ticket: db.TicketView;
  recipients: db.AccountView[];
  event: string;
  title: string;
  body: string;
  smsSender: RepairNotificationSender | null;
  feishuSender: RepairNotificationSender | null;
}): Promise<void> {
  const withTimeout = async (task: Promise<boolean>): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 8_000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  await Promise.all(input.recipients.flatMap((recipient) => {
    db.recordTicketNotification({
      ticketId: input.ticket.id,
      recipientAccountId: recipient.id,
      channel: 'otto',
      event: input.event,
      status: 'sent',
      detail: '企业工单收件箱已投递',
    });
    const sendChannel = async (
      channel: 'sms' | 'feishu',
      sender: RepairNotificationSender | null,
      recipientId: string | null,
    ): Promise<void> => {
      if (!sender || !recipientId) {
        db.recordTicketNotification({
          ticketId: input.ticket.id,
          recipientAccountId: recipient.id,
          channel,
          event: input.event,
          status: 'skipped',
          detail: sender ? '接收人未配置该通道账号' : '服务器未配置该通知通道',
        });
        return;
      }
      const sent = await withTimeout(sender.send(recipientId, input.title, input.body));
      db.recordTicketNotification({
        ticketId: input.ticket.id,
        recipientAccountId: recipient.id,
        channel,
        event: input.event,
        status: sent ? 'sent' : 'failed',
        detail: sent ? '供应商已接收' : '供应商发送失败或超时',
      });
    };
    return [
      sendChannel('sms', input.smsSender, recipient.phone),
      sendChannel('feishu', input.feishuSender, recipient.feishuOpenId),
    ];
  }));
}

export async function handleTicketRoute({
  path,
  method,
  req,
  res,
  repairSmsSender,
  repairFeishuSender,
  extractToken,
  readBody,
  sendJSON,
}: TicketRouteDeps): Promise<boolean> {
  if (path === '/enterprise/tickets' && method === 'POST') {
    const account = db.getAccountBySession(extractToken(req));
    if (!account) {
      sendJSON(res, 401, { error: '登录已失效，请重新登录' });
      return true;
    }
    const body = await readBody(req);
    const hasLegacyRepairFields = ['category', 'location', 'urgency', 'contact', 'contactPhone']
      .some((key) => typeof body[key] === 'string');
    const serviceId = typeof body.serviceId === 'string' && body.serviceId.trim()
      ? body.serviceId.trim()
      : hasLegacyRepairFields ? 'repair' : 'it';
    const title = typeof body.title === 'string' ? body.title : '';
    const description = typeof body.description === 'string' ? body.description : '';
    if (!title.trim() || !description.trim()) {
      sendJSON(res, 400, { error: 'title and description required' });
      return true;
    }
    if (title.length > 200 || description.length > 2000) {
      sendJSON(res, 400, { error: '工单标题或描述过长' });
      return true;
    }
    const parkRequestIds = new Set([
      'renovation', 'parking', 'network-phone', 'meeting-room',
      'electric-card', 'repair', 'vehicle-visit',
    ]);
    if (!parkRequestIds.has(serviceId) && serviceId !== 'it') {
      sendJSON(res, 400, { error: '园区服务类型不正确' });
      return true;
    }
    const isParkRequest = parkRequestIds.has(serviceId);
    if (isParkRequest) {
      const park = db.getParkForOrganization(account.organizationId);
      if (!park) {
        sendJSON(res, 403, { error: '企业尚未加入产业园' });
        return true;
      }
      if (
        !db.getOrganizationFeatures(account.organizationId).park_service
        || !db.getOrganizationFeatures(park.adminOrganizationId).park_service
      ) {
        sendJSON(res, 403, { error: '园区服务功能已由管理员关闭' });
        return true;
      }
    }
    const targetTags = serviceId === 'repair'
      ? ['维修工作人员']
      : isParkRequest
        ? ['客服人员']
      : Array.isArray(body.targetTags)
        ? body.targetTags.filter((tag): tag is string => typeof tag === 'string')
        : ['IT', '报修'];
    let formData = body.formData && typeof body.formData === 'object'
      && !Array.isArray(body.formData)
      ? Object.fromEntries(Object.entries(body.formData).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ).map(([key, value]) => [key.slice(0, 50), value.trim().slice(0, 2000)]))
      : {};
    const hasScheduledMeetingRoomBooking = serviceId === 'meeting-room'
      && (Boolean(formData.roomId) || Boolean(formData.slotKey));
    const meetingRoom = hasScheduledMeetingRoomBooking
      ? db.listParkMeetingRooms(account.organizationId).find(
        (room) => room.id === formData.roomId,
      )
      : undefined;
    if (hasScheduledMeetingRoomBooking) {
      if (!meetingRoom) {
        sendJSON(res, 400, { error: '请选择有效的会议室' });
        return true;
      }
      const attendees = Number(formData.attendees);
      if (!Number.isInteger(attendees) || attendees < 1) {
        sendJSON(res, 400, { error: '参会人数只能填写大于等于 1 的正整数' });
        return true;
      }
      if (attendees > meetingRoom.capacity) {
        sendJSON(res, 400, {
          error: `${meetingRoom.name}最多容纳 ${meetingRoom.capacity} 人`,
        });
        return true;
      }
      const slot = db.PARK_MEETING_TIME_SLOTS.find(
        (item) => item.key === formData.slotKey,
      );
      if (!slot) {
        sendJSON(res, 400, { error: '请选择绿色的可预约时间段' });
        return true;
      }
      formData = {
        ...formData,
        roomName: meetingRoom.name,
        roomCapacity: String(meetingRoom.capacity),
        priceHalfDay: String(meetingRoom.priceHalfDay),
        time: slot.label,
      };
    }
    let ticket: ReturnType<typeof db.createTicket>;
    try {
      const database = db.getDB();
      database.exec('BEGIN IMMEDIATE');
      try {
        ticket = db.createTicket({
          createdByAccountId: account.id,
          serviceId,
          title,
          description,
          targetTags,
          formData,
          category: typeof body.category === 'string' ? body.category : undefined,
          location: typeof body.location === 'string' ? body.location : undefined,
          urgency: typeof body.urgency === 'string' ? body.urgency : undefined,
          contact: typeof body.contact === 'string' ? body.contact : undefined,
          contactPhone: typeof body.contactPhone === 'string' ? body.contactPhone : undefined,
        });
        if (hasScheduledMeetingRoomBooking) {
          db.reserveParkMeetingSlot(account.organizationId, {
            roomId: formData.roomId || '',
            date: formData.date || '',
            slotKey: formData.slotKey || '',
            ticketId: ticket.id,
          });
        }
        database.exec('COMMIT');
      } catch (cause) {
        database.exec('ROLLBACK');
        throw cause;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '会议室预约失败';
      if (serviceId === 'meeting-room' && /已被预约|暂不可预约|请选择|只能预约/.test(message)) {
        sendJSON(res, message.includes('已被预约') ? 409 : 400, { error: message });
        return true;
      }
      throw error;
    }
    await sendRepairNotifications({
      ticket,
      recipients: db.getTicketNotificationRecipients(ticket.id),
      event: 'ticket_created',
      title: serviceId === 'repair' ? `Otto 新报修 · ${ticket.title}` : `Otto 新园区申请 · ${ticket.title}`,
      body: serviceId === 'repair'
        ? `${ticket.location || '位置未填写'} · ${ticket.description} · ${ticket.urgency || '普通'}`
        : ticket.description,
      smsSender: repairSmsSender,
      feishuSender: repairFeishuSender,
    });
    sendJSON(res, 201, { ticket: db.getTicketForAccount(ticket.id, account.id) });
    return true;
  }

  if (path === '/enterprise/tickets' && method === 'GET') {
    const account = db.getAccountBySession(extractToken(req));
    if (!account) {
      sendJSON(res, 401, { error: '登录已失效，请重新登录' });
      return true;
    }
    sendJSON(res, 200, {
      tickets: db.listTicketsForAccount(account.id)
        .filter((ticket) => db.isTicketFeatureEnabledForAccount(ticket.id, account.id)),
    });
    return true;
  }

  if (path === '/enterprise/tickets/inbox' && method === 'GET') {
    const account = db.getAccountBySession(extractToken(req));
    if (!account) {
      sendJSON(res, 401, { error: '登录已失效，请重新登录' });
      return true;
    }
    sendJSON(res, 200, {
      tickets: db.listTicketInbox(account.id)
        .filter((ticket) => db.isTicketFeatureEnabledForAccount(ticket.id, account.id)),
    });
    return true;
  }

  const ticketAction = path.match(/^\/enterprise\/tickets\/([^/]+)\/(read|action)$/);
  if (ticketAction && method === 'POST') {
    const account = db.getAccountBySession(extractToken(req));
    if (!account) {
      sendJSON(res, 401, { error: '登录已失效，请重新登录' });
      return true;
    }
    let ticketId = '';
    try { ticketId = decodeURIComponent(ticketAction[1]!); } catch { /* invalid id */ }
    const currentTicket = ticketId ? db.getTicketForAccount(ticketId, account.id) : null;
    if (!currentTicket) {
      sendJSON(res, 404, { error: '工单不存在或无权查看' });
      return true;
    }
    if (currentTicket.parkId && !db.isTicketFeatureEnabledForAccount(ticketId, account.id)) {
      sendJSON(res, 403, { error: '园区服务功能已由管理员关闭' });
      return true;
    }
    try {
      if (ticketAction[2] === 'read') {
        sendJSON(res, 200, { ticket: db.markTicketRead(ticketId, account.id) });
        return true;
      }
      const body = await readBody(req);
      const action = typeof body.action === 'string' ? body.action : '';
      if (!['respond', 'accept', 'complete', 'confirm'].includes(action)) {
        sendJSON(res, 400, { error: '工单操作不正确' });
        return true;
      }
      const ticket = db.updateTicket({
        ticketId,
        accountId: account.id,
        action: action as 'respond' | 'accept' | 'complete' | 'confirm',
        responseType: typeof body.responseType === 'string' ? body.responseType : undefined,
        responseText: typeof body.responseText === 'string' ? body.responseText : undefined,
      });
      const recipients = action === 'confirm'
        ? db.getTicketNotificationRecipients(ticket.id)
        : [db.getTicketCreatorForAccount(ticket.id, account.id)].filter(
          (item): item is db.AccountView => item !== null,
        );
      const title = action === 'respond'
        ? `Otto 办理回复 · ${ticket.title}`
        : action === 'accept'
          ? `Otto 申请已受理 · ${ticket.title}`
          : action === 'complete'
            ? `Otto 待确认 · ${ticket.title}`
            : `Otto 办理已确认 · ${ticket.title}`;
      const detail = action === 'respond'
        ? `${ticket.responseType || '处理回复'}：${ticket.responseText || ''}`
        : `工单 ${ticket.id} 当前状态：${ticket.status}`;
      await sendRepairNotifications({
        ticket,
        recipients,
        event: `ticket_${action}`,
        title,
        body: detail,
        smsSender: repairSmsSender,
        feishuSender: repairFeishuSender,
      });
      sendJSON(res, 200, { ticket: db.getTicketForAccount(ticket.id, account.id) });
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}
