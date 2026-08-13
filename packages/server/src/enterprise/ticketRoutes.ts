/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import * as db from './db.js';
import type { RepairNotificationSender } from '../modules/integration_adapters/index.js';
import { isParkRequestServiceId } from '../modules/park_services/index.js';

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

  // 通知升级顺序：
  //  1) Otto 站内提醒立即投递（收件箱已读回执作为短信升级的取消依据）。
  //  2) 飞书立即发送；失败进入持久化重试队列。
  //  3) 短信不立即发送：调度 5 分钟后的升级任务，若期间已读则取消，未读才发送。
  await Promise.all(input.recipients.map(async (recipient) => {
    db.recordTicketNotification({
      ticketId: input.ticket.id,
      recipientAccountId: recipient.id,
      channel: 'otto',
      event: input.event,
      status: 'sent',
      detail: '企业工单收件箱已投递',
    });
    db.scheduleTicketNotificationTask({
      ticketId: input.ticket.id,
      recipientAccountId: recipient.id,
      channel: 'sms',
      event: input.event,
      title: input.title,
      body: input.body,
    });
    if (!input.feishuSender || !recipient.feishuOpenId) {
      db.recordTicketNotification({
        ticketId: input.ticket.id,
        recipientAccountId: recipient.id,
        channel: 'feishu',
        event: input.event,
        status: 'skipped',
        detail: input.feishuSender ? '接收人未配置该通道账号' : '服务器未配置该通知通道',
      });
      return;
    }
    let sent = false;
    try {
      sent = await withTimeout(
        input.feishuSender.send(recipient.feishuOpenId, input.title, input.body),
      );
    } catch {
      sent = false;
    }
    if (sent) {
      db.recordTicketNotification({
        ticketId: input.ticket.id,
        recipientAccountId: recipient.id,
        channel: 'feishu',
        event: input.event,
        status: 'sent',
        detail: '供应商已接收',
      });
      return;
    }
    // 飞书失败进入可重试队列（不影响工单创建）。
    db.scheduleTicketNotificationTask({
      ticketId: input.ticket.id,
      recipientAccountId: recipient.id,
      channel: 'feishu',
      event: input.event,
      title: input.title,
      body: input.body,
    });
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
    if (!isParkRequestServiceId(serviceId) && serviceId !== 'it') {
      sendJSON(res, 400, { error: '园区服务类型不正确' });
      return true;
    }
    const isParkRequest = isParkRequestServiceId(serviceId);
    if (
      isParkRequest &&
      !db.isLicenseUsableForOrganizationFeature('park_service')
    ) {
      sendJSON(res, 402, {
        error: 'commercial module is not entitled',
        code: 'commercial_module_not_entitled',
        feature: 'park_service',
      });
      return true;
    }
    const ticketPark = isParkRequest
      ? db.getParkForOrganization(account.organizationId)
      : null;
    if (isParkRequest) {
      if (!ticketPark) {
        sendJSON(res, 403, { error: '企业尚未加入产业园' });
        return true;
      }
      if (
        !db.getOrganizationFeatures(account.organizationId).park_service
        || !db.getOrganizationFeatures(ticketPark.adminOrganizationId).park_service
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
    if (serviceId === 'repair' && Object.keys(formData).length === 0) {
      const organization = db.getOrganization(account.organizationId);
      const profile = db.getParkTenantProfile(account.organizationId);
      formData = {
        company: organization?.name || '',
        roomNumber: profile?.roomNumber
          || (typeof body.location === 'string' ? body.location.trim() : ''),
        contact: typeof body.contact === 'string' && body.contact.trim()
          ? body.contact.trim()
          : account.name,
        phone: typeof body.contactPhone === 'string' && body.contactPhone.trim()
          ? body.contactPhone.trim()
          : account.phone?.replace(/^\+86/, '') || '',
        category: typeof body.category === 'string' && body.category.trim()
          ? body.category.trim()
          : title.trim(),
        issue: description.trim(),
        urgency: typeof body.urgency === 'string' && body.urgency.trim()
          ? body.urgency.trim()
          : '普通',
      };
    }
    const hasScheduledMeetingRoomBooking = serviceId === 'meeting-room'
      && Boolean(formData.roomId)
      && Boolean(formData.date)
      && Boolean(formData.startTime || formData.slotKey);
    const meetingResourceOrganizationId = ticketPark?.adminOrganizationId
      || account.organizationId;
    const meetingRoom = hasScheduledMeetingRoomBooking
      ? db.listParkMeetingRooms(meetingResourceOrganizationId).find(
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
      if (formData.slotKey && !formData.startTime) {
        const legacy = formData.slotKey === 'morning'
          ? { startTime: '09:00', endTime: '12:00' }
          : formData.slotKey === 'afternoon'
            ? { startTime: '14:00', endTime: '18:00' }
            : null;
        if (!legacy) {
          sendJSON(res, 400, { error: '请选择绿色的可预约时间段' });
          return true;
        }
        formData.startTime = legacy.startTime;
        formData.endTime = legacy.endTime;
      }
      const validStart = db.PARK_MEETING_TIME_SLOTS.some(
        (item) => item.key === formData.startTime,
      );
      const validEnd = formData.endTime === '23:00' || db.PARK_MEETING_TIME_SLOTS.some(
        (item) => item.key === formData.endTime,
      );
      if (!validStart || !validEnd || formData.startTime >= formData.endTime) {
        sendJSON(res, 400, { error: `请在 09:00-23:00 之间按 ${db.PARK_MEETING_SLOT_MINUTES} 分钟选择连续时段` });
        return true;
      }
      formData.slotKey = formData.startTime;
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
        time: `${formData.startTime}-${formData.endTime}`,
      };
    }
    let ticket: ReturnType<typeof db.createTicket>;
    try {
      ticket = db.createTicketWithMeetingReservation({
        ticket: {
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
        },
        meetingReservation: hasScheduledMeetingRoomBooking
          ? {
              organizationId: meetingResourceOrganizationId,
              input: {
                roomId: formData.roomId || '',
                date: formData.date || '',
                startTime: formData.startTime || '',
                endTime: formData.endTime || '',
              },
            }
          : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '会议室预约失败';
      if (
        serviceId === 'meeting-room'
        && /已被预约|未开放|暂不可预约|请选择|请填写|只能预约/.test(message)
      ) {
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
        .filter((ticket) => !ticket.parkId || db.isLicenseUsableForOrganizationFeature('park_service'))
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
        .filter((ticket) => !ticket.parkId || db.isLicenseUsableForOrganizationFeature('park_service'))
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
    if (
      currentTicket.parkId &&
      !db.isLicenseUsableForOrganizationFeature('park_service')
    ) {
      sendJSON(res, 402, {
        error: 'commercial module is not entitled',
        code: 'commercial_module_not_entitled',
        feature: 'park_service',
      });
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
      if (
        ![
          'respond',
          'accept',
          'release',
          'complete',
          'confirm',
          'respond_and_transfer',
        ].includes(action)
      ) {
        sendJSON(res, 400, { error: '工单操作不正确' });
        return true;
      }
      const ticket = db.updateTicket({
        ticketId,
        accountId: account.id,
        action: action as
          | 'respond'
          | 'accept'
          | 'release'
          | 'complete'
          | 'confirm'
          | 'respond_and_transfer',
        responseType: typeof body.responseType === 'string' ? body.responseType : undefined,
        responseText: typeof body.responseText === 'string' ? body.responseText : undefined,
        transferAccountId: typeof body.transferAccountId === 'string' ? body.transferAccountId : undefined,
        transferDepartment: typeof body.transferDepartment === 'string' ? body.transferDepartment : undefined,
        transferNote: typeof body.transferNote === 'string' ? body.transferNote : undefined,
        releaseReason: typeof body.releaseReason === 'string' ? body.releaseReason : undefined,
      });
      const creatorRecipients = [db.getTicketCreatorForAccount(ticket.id, account.id)].filter(
        (item): item is db.AccountView => item !== null,
      );
      if (action === 'respond_and_transfer') {
        await sendRepairNotifications({
          ticket,
          recipients: creatorRecipients,
          event: 'ticket_respond',
          title: `Otto 办理回复 · ${ticket.title}`,
          body: `${ticket.responseType || '处理回复'}：${ticket.responseText || ''}`,
          smsSender: repairSmsSender,
          feishuSender: repairFeishuSender,
        });
        const transferEvent = ticket.history.at(-1);
        await sendRepairNotifications({
          ticket,
          recipients: db.getTicketNotificationRecipients(ticket.id),
          event: 'ticket_transfer',
          title: `Otto 转交任务 · ${ticket.title}`,
          body: transferEvent?.responseText
            || '请工程部接手处理该物业报修，并在完成后记录工作结果。',
          smsSender: repairSmsSender,
          feishuSender: repairFeishuSender,
        });
        sendJSON(res, 200, {
          ticket: db.getTicketForAccount(ticket.id, account.id),
        });
        return true;
      }
      const recipientCandidates = action === 'confirm'
        ? db.getTicketNotificationRecipients(ticket.id)
        : action === 'complete' && currentTicket.status === '已转交'
          ? [...creatorRecipients, ...db.getTicketTransferredNotificationRecipients(ticket.id)]
          : creatorRecipients;
      const recipients = [
        ...new Map(recipientCandidates.map((item) => [item.id, item])).values(),
      ];
       const title = action === 'respond'
         ? `Otto 办理回复 · ${ticket.title}`
         : action === 'accept'
           ? `Otto 申请已受理 · ${ticket.title}`
           : action === 'complete'
             ? currentTicket.status === '已转交'
               ? `Otto 工作已完成 · ${ticket.title}`
               : `Otto 待确认 · ${ticket.title}`
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
