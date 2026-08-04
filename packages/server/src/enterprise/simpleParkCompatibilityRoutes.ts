import type { IncomingMessage, ServerResponse } from 'node:http';
import * as db from './db.js';
import * as simplePark from './park.js';

export type SimpleParkCompatibilityPrincipal =
  | { kind: 'system'; organizationId: string }
  | { kind: 'account'; organizationId: string; account: db.AccountView };

export interface SimpleParkCompatibilityRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  adminPrincipal: SimpleParkCompatibilityPrincipal | null;
  memberAccount: db.AccountView | null;
  isPublicSimplePark: boolean;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
  extractToken(req: IncomingMessage): string;
}

export async function handleSimpleParkCompatibilityRoute({
  path,
  method,
  req,
  res,
  url,
  adminPrincipal,
  memberAccount,
  isPublicSimplePark,
  readBody,
  sendJSON,
  extractToken,
}: SimpleParkCompatibilityRouteDeps): Promise<boolean> {
  if (path === '/enterprise/park' && method === 'POST') {
    const body = await readBody(req);
    const name = typeof body.name === 'string' ? body.name : '';
    const address = typeof body.address === 'string' ? body.address : '';
    if (!name.trim()) {
      sendJSON(res, 400, { error: '园区名称不能为空' });
      return true;
    }
    const adminUserIds = Array.isArray(body.adminUserIds)
      ? body.adminUserIds.filter((id): id is string => typeof id === 'string')
      : [];
    const park = simplePark.createPark({ name, address, adminUserIds });
    sendJSON(res, 201, { park });
    return true;
  }

  if (path === '/enterprise/park/invite' && method === 'POST' && adminPrincipal?.kind !== 'account') {
    const body = await readBody(req);
    const parkId = typeof body.parkId === 'string' ? body.parkId : '';
    if (parkId) {
      const createdBy = 'platform-admin';
      if (!simplePark.getPark(parkId)) {
        sendJSON(res, 404, { error: '园区不存在' });
        return true;
      }
      const maxUses = typeof body.maxUses === 'number' ? body.maxUses : undefined;
      const invite = simplePark.createInviteCode({ parkId, createdBy, maxUses });
      sendJSON(res, 201, { invite });
      return true;
    }
  }

  if (path === '/enterprise/park/join' && method === 'POST' && isPublicSimplePark) {
    const body = await readBody(req);
    const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode : '';
    if (inviteCode) {
      const account = db.getAccountBySession(extractToken(req));
      if (!account || !account.isAdmin) {
        sendJSON(res, 403, { error: '请使用企业管理员账号加入产业园' });
        return true;
      }
      if (!db.getOrganizationFeatures(account.organizationId).park_service) {
        sendJSON(res, 403, { error: '园区服务功能已由管理员关闭' });
        return true;
      }
      try {
        const park = db.joinOrganizationToPark({
          organizationId: account.organizationId,
          actorAccountId: account.id,
          code: inviteCode,
          address: typeof body.address === 'string' ? body.address : '',
          roomNumber: typeof body.roomNumber === 'string' ? body.roomNumber : '',
        });
        const profile = db.getParkTenantProfile(account.organizationId);
        sendJSON(res, 200, {
          park: {
            ...park,
            tenantAddress: profile?.address ?? null,
            tenantRoomNumber: profile?.roomNumber ?? null,
          },
          organization: db.getEnterpriseOrganization(account.organizationId),
        });
      } catch (error) {
        sendJSON(res, 400, { error: error instanceof Error ? error.message : '加入产业园失败' });
      }
      return true;
    }
    const code = typeof body.code === 'string' ? body.code : '';
    const enterpriseId = typeof body.enterpriseId === 'string' ? body.enterpriseId : '';
    if (!code || !enterpriseId) {
      sendJSON(res, 400, { error: '邀请码和企业ID不能为空' });
      return true;
    }
    const result = simplePark.useInviteCode(code, enterpriseId);
    if (!result.success) {
      sendJSON(res, 403, { error: result.error });
      return true;
    }
    sendJSON(res, 200, { parkId: result.parkId, enterpriseId });
    return true;
  }

  if (path === '/enterprise/park/services' && method === 'GET' && url.searchParams.has('parkId')) {
    const parkId = url.searchParams.get('parkId') || '';
    if (!parkId || !simplePark.getPark(parkId)) {
      sendJSON(res, 404, { error: '园区不存在' });
      return true;
    }
    const status = url.searchParams.get('status') || undefined;
    sendJSON(res, 200, {
      requests: simplePark.getParkServiceRequests(parkId, status),
      specialists: simplePark.getSpecialists(parkId),
    });
    return true;
  }

  if (path === '/enterprise/park/services/request' && method === 'POST') {
    if (!memberAccount) {
      sendJSON(res, 401, { error: '登录已失效，请重新登录' });
      return true;
    }
    const body = await readBody(req);
    const parkId = typeof body.parkId === 'string' ? body.parkId : '';
    const type = typeof body.type === 'string' ? body.type : '';
    const description = typeof body.description === 'string' ? body.description : '';
    if (!parkId || !type || !description) {
      sendJSON(res, 400, { error: '园区ID、服务类型和描述不能为空' });
      return true;
    }
    const request = simplePark.createServiceRequest({
      parkId,
      enterpriseId: memberAccount.organizationId,
      type,
      description,
    });
    const routed = simplePark.routeServiceRequest(request.id);
    sendJSON(res, 201, { request: routed });
    return true;
  }

  if (path === '/enterprise/park/services/assign' && method === 'POST') {
    const body = await readBody(req);
    const parkId = typeof body.parkId === 'string' ? body.parkId : '';
    const userId = typeof body.userId === 'string' ? body.userId : '';
    const serviceTypes = Array.isArray(body.serviceTypes)
      ? body.serviceTypes.filter((type): type is string => typeof type === 'string')
      : [];
    if (!parkId || !userId || serviceTypes.length === 0) {
      sendJSON(res, 400, { error: '园区ID、用户ID和服务类型不能为空' });
      return true;
    }
    const specialist = simplePark.assignSpecialist({ parkId, userId, serviceTypes });
    sendJSON(res, 201, { specialist });
    return true;
  }

  return false;
}
