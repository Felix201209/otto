import type { IncomingMessage, ServerResponse } from 'node:http';
import * as db from './db.js';

export type ParkServicePublicationPrincipal =
  | { kind: 'system'; organizationId: string }
  | { kind: 'account'; organizationId: string; account: db.AccountView };

export interface ParkServicePublicationRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  adminPrincipal: ParkServicePublicationPrincipal | null;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
  extractToken(req: IncomingMessage): string;
}

const PARK_SERVICE_PUSH_TEMPLATES: Record<string, { name: string; detail: string }> = {
  announcement: { name: '园区公告', detail: '请查看园区公告并确认是否需要转发给企业成员。' },
  satisfaction: { name: '满意度调查', detail: '请填写本次园区服务满意度调查，提交后由管理员汇总。' },
  renovation: { name: '装修申请', detail: '请补充装修区域、施工内容、开工时间和现场联系人。' },
  parking: { name: '停车位办理', detail: '请提交车牌号、车辆类型、申请数量和联系人。' },
  'network-phone': { name: '网络 / 电话业务', detail: '请提交安装位置、工位数量或号码数量、期望开通日期。' },
  'meeting-room': { name: '会议室预订', detail: '请确认参会人数、日期、时间段和投屏/视频会议需求。' },
  'electric-card': { name: '电卡充电', detail: '请提交电卡编号、充电度数、公司名称和联系人，按1.2元/度计费。' },
  repair: { name: '客户报修', detail: '请描述故障位置、故障现象、紧急程度和现场联系人。' },
  'vehicle-visit': { name: '来访车辆登记', detail: '请登记来访人、手机号、车牌号、来访时间和拜访事由。' },
};

function buildParkServicePushMessage(input: {
  brandName: string;
  serviceId: string;
  serviceName: string;
  note: string | null;
}): string {
  const service = PARK_SERVICE_PUSH_TEMPLATES[input.serviceId];
  const detail = service?.detail ?? `请打开${input.brandName}查看待处理事项。`;
  return [
    `【${input.brandName}】${input.serviceName}`,
    detail,
    input.note ? `管理员备注：${input.note}` : null,
    `请在 Otto 右侧“${input.brandName}”入口中继续处理。`,
  ].filter(Boolean).join('\n');
}

export async function handleParkServicePublicationRoute({
  path,
  method,
  req,
  res,
  adminPrincipal,
  readBody,
  sendJSON,
  extractToken,
}: ParkServicePublicationRouteDeps): Promise<boolean> {
  if (path === '/enterprise/park-services/push' && method === 'POST') {
    const principal = adminPrincipal!;
    if (principal.kind !== 'account') {
      sendJSON(res, 403, { error: '请使用企业管理员账号登录后推送园区服务' });
      return true;
    }
    if (!db.getOrganizationFeatures(principal.organizationId).park_service) {
      sendJSON(res, 403, { error: '园区服务功能已由管理员关闭' });
      return true;
    }
    const park = db.getParkForOrganization(principal.organizationId);
    if (!park || park.adminOrganizationId !== principal.organizationId) {
      sendJSON(res, 403, { error: '当前企业不是产业园管理方' });
      return true;
    }
    const body = await readBody(req);
    const recipientAccountId = typeof body.recipientAccountId === 'string' ? body.recipientAccountId.trim() : '';
    const serviceId = typeof body.serviceId === 'string' ? body.serviceId.trim() : '';
    const note = typeof body.note === 'string' && body.note.trim()
      ? body.note.trim().slice(0, 500)
      : null;
    if (!serviceId) {
      sendJSON(res, 400, { error: 'serviceId required' });
      return true;
    }
    if (!PARK_SERVICE_PUSH_TEMPLATES[serviceId]) {
      sendJSON(res, 400, { error: '未知的园区服务' });
      return true;
    }
    try {
      const configuredService = park
        ? db.listParkServices(park.id).find((item) => item.id === serviceId)
        : undefined;
      const brandName = park?.brandName?.trim() || '园区服务';
      const service = {
        ...PARK_SERVICE_PUSH_TEMPLATES[serviceId]!,
        name: configuredService?.name || PARK_SERVICE_PUSH_TEMPLATES[serviceId]!.name,
      };
      if (serviceId === 'announcement' || serviceId === 'satisfaction') {
        const result = db.createParkPublication({
          createdByAccountId: principal.account.id,
          kind: serviceId,
          title: service.name,
          body: note || service.detail,
          recipientAccountId: recipientAccountId && recipientAccountId !== 'all'
            ? recipientAccountId
            : null,
        });
        sendJSON(res, 201, { ...result, service });
        return true;
      }
      if (!recipientAccountId || recipientAccountId === 'all') {
        sendJSON(res, 400, { error: '请选择要接收这项办理提醒的成员' });
        return true;
      }
      const message = db.sendDirectMessage({
        organizationId: principal.organizationId,
        senderAccountId: principal.account.id,
        recipientAccountId,
        content: buildParkServicePushMessage({
          brandName,
          serviceId,
          serviceName: service.name,
          note,
        }),
      });
      sendJSON(res, 201, {
        message,
        service,
        recipient: db.getAccount(recipientAccountId, principal.organizationId),
      });
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : '园区服务推送失败' });
    }
    return true;
  }

  if (path === '/enterprise/park-services/publications' && method === 'GET') {
    const account = db.getAccountBySession(extractToken(req));
    if (!account) {
      sendJSON(res, 401, { error: '登录已失效，请重新登录' });
      return true;
    }
    if (!db.getOrganizationFeatures(account.organizationId).park_service) {
      sendJSON(res, 403, { error: '园区服务功能已由管理员关闭' });
      return true;
    }
    sendJSON(res, 200, { publications: db.listParkPublications(account.id) });
    return true;
  }

  if (path === '/enterprise/park-services/survey-results' && method === 'GET') {
    const principal = adminPrincipal!;
    if (principal.kind !== 'account') {
      sendJSON(res, 403, { error: '请使用企业管理员账号查看问卷回收结果' });
      return true;
    }
    if (!db.getOrganizationFeatures(principal.organizationId).park_service) {
      sendJSON(res, 403, { error: '园区服务功能已由管理员关闭' });
      return true;
    }
    sendJSON(res, 200, {
      announcements: db.listParkAnnouncementResults(principal.account.id),
      surveys: db.listParkSurveyResults(principal.account.id),
    });
    return true;
  }

  if (path === '/enterprise/park-services/announcement-results' && method === 'GET') {
    const principal = adminPrincipal!;
    if (principal.kind !== 'account') {
      sendJSON(res, 403, { error: '请使用产业园管理员账号查看公告确认结果' });
      return true;
    }
    if (!db.getOrganizationFeatures(principal.organizationId).park_service) {
      sendJSON(res, 403, { error: '园区服务功能已由管理员关闭' });
      return true;
    }
    sendJSON(res, 200, {
      announcements: db.listParkAnnouncementResults(principal.account.id),
    });
    return true;
  }

  const publicationAction = path.match(
    /^\/enterprise\/park-services\/publications\/([^/]+)\/(read|submit)$/,
  );
  if (publicationAction && method === 'POST') {
    const account = db.getAccountBySession(extractToken(req));
    if (!account) {
      sendJSON(res, 401, { error: '登录已失效，请重新登录' });
      return true;
    }
    if (!db.getOrganizationFeatures(account.organizationId).park_service) {
      sendJSON(res, 403, { error: '园区服务功能已由管理员关闭' });
      return true;
    }
    let publicationId = '';
    try { publicationId = decodeURIComponent(publicationAction[1]!); } catch { /* invalid id */ }
    if (!publicationId) {
      sendJSON(res, 400, { error: '园区内容编号不正确' });
      return true;
    }
    try {
      if (publicationAction[2] === 'read') {
        sendJSON(res, 200, { publication: db.markParkPublicationRead(publicationId, account.id) });
        return true;
      }
      const body = await readBody(req);
      const responseData = body.responseData && typeof body.responseData === 'object'
        && !Array.isArray(body.responseData)
        ? Object.fromEntries(Object.entries(body.responseData).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ))
        : {};
      sendJSON(res, 200, {
        publication: db.submitParkSurvey(publicationId, account.id, responseData),
      });
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}
