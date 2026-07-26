import type { IncomingMessage, ServerResponse } from 'node:http';
import * as db from './db.js';

export type GeneralizedParkPrincipal =
  | { kind: 'system'; organizationId: string }
  | { kind: 'account'; organizationId: string; account: db.AccountView };

export interface GeneralizedParkRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  memberAccount: db.AccountView | null;
  adminPrincipal: GeneralizedParkPrincipal | null;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

type ParkView = NonNullable<ReturnType<typeof db.getParkForOrganization>>;

function requireParkService(
  organizationId: string,
  res: ServerResponse,
  sendJSON: GeneralizedParkRouteDeps['sendJSON'],
): boolean {
  if (db.getOrganizationFeatures(organizationId).park_service) return true;
  sendJSON(res, 403, { error: '园区服务功能已由管理员关闭' });
  return false;
}

function getParkAdmin(
  principal: GeneralizedParkPrincipal,
  res: ServerResponse,
  sendJSON: GeneralizedParkRouteDeps['sendJSON'],
  error: string,
): ParkView | null {
  const park = db.getParkForOrganization(principal.organizationId);
  if (!park || park.adminOrganizationId !== principal.organizationId) {
    sendJSON(res, 403, { error });
    return null;
  }
  return park;
}

export async function handleGeneralizedParkRoute({
  path,
  method,
  req,
  res,
  memberAccount,
  adminPrincipal,
  readBody,
  sendJSON,
}: GeneralizedParkRouteDeps): Promise<boolean> {
  if (path === '/enterprise/park/manage' && (method === 'GET' || method === 'POST')) {
    const principal = adminPrincipal!;
    if (principal.kind !== 'account') {
      sendJSON(res, 403, { error: '请使用企业管理员账号管理产业园' });
      return true;
    }
    if (!requireParkService(principal.organizationId, res, sendJSON)) return true;
    if (method === 'GET') {
      sendJSON(res, 200, { park: db.getParkForOrganization(principal.organizationId) });
      return true;
    }
    sendJSON(res, 403, {
      error: '产业园端只能由平台管理员在多企业管理页面认证创建',
    });
    return true;
  }

  if (path === '/enterprise/park/invite' && method === 'POST') {
    const principal = adminPrincipal!;
    if (principal.kind !== 'account') {
      sendJSON(res, 403, { error: '请使用产业园管理员账号生成邀请码' });
      return true;
    }
    if (!requireParkService(principal.organizationId, res, sendJSON)) return true;
    const park = getParkAdmin(principal, res, sendJSON, '当前企业不是产业园管理方');
    if (!park) return true;
    const body = await readBody(req);
    try {
      const invite = db.issueParkInvite({
        parkId: park.id,
        actorAccountId: principal.account.id,
        maxUses: typeof body.maxUses === 'number' ? body.maxUses : null,
      });
      sendJSON(res, 201, { invite });
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : '邀请码生成失败' });
    }
    return true;
  }

  if (path === '/enterprise/park/join' && method === 'POST') {
    const principal = adminPrincipal!;
    if (principal.kind !== 'account') {
      sendJSON(res, 403, { error: '请使用企业管理员账号加入产业园' });
      return true;
    }
    if (!requireParkService(principal.organizationId, res, sendJSON)) return true;
    const body = await readBody(req);
    try {
      const park = db.joinOrganizationToPark({
        organizationId: principal.organizationId,
        actorAccountId: principal.account.id,
        code: typeof body.inviteCode === 'string' ? body.inviteCode : '',
        address: typeof body.address === 'string' ? body.address : '',
        roomNumber: typeof body.roomNumber === 'string' ? body.roomNumber : '',
      });
      const profile = db.getParkTenantProfile(principal.organizationId);
      sendJSON(res, 200, {
        park: {
          ...park,
          tenantAddress: profile?.address ?? null,
          tenantRoomNumber: profile?.roomNumber ?? null,
        },
      });
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : '加入产业园失败' });
    }
    return true;
  }

  if (path === '/enterprise/park/profile' && method === 'PATCH') {
    const principal = adminPrincipal!;
    if (principal.kind !== 'account') {
      sendJSON(res, 403, { error: '请使用企业管理员账号修改入驻资料' });
      return true;
    }
    if (!requireParkService(principal.organizationId, res, sendJSON)) return true;
    const body = await readBody(req);
    try {
      const profile = db.updateParkTenantProfile({
        organizationId: principal.organizationId,
        actorAccountId: principal.account.id,
        address: typeof body.address === 'string' ? body.address : '',
        roomNumber: typeof body.roomNumber === 'string' ? body.roomNumber : '',
      });
      sendJSON(res, 200, { profile });
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : '入驻资料保存失败' });
    }
    return true;
  }

  if (path === '/enterprise/park/tenants' && method === 'GET') {
    const principal = adminPrincipal!;
    if (principal.kind !== 'account') {
      sendJSON(res, 403, { error: 'park admin account required' });
      return true;
    }
    const park = getParkAdmin(
      principal,
      res,
      sendJSON,
      'current organization is not a park admin organization',
    );
    if (!park) return true;
    sendJSON(res, 200, { organizations: db.listParkTenantOrganizations(park.id) });
    return true;
  }

  if (path === '/enterprise/park/specialists' && ['GET', 'POST', 'DELETE'].includes(method)) {
    const principal = adminPrincipal!;
    if (principal.kind !== 'account') {
      sendJSON(res, 403, { error: '请使用产业园管理员账号设置专员' });
      return true;
    }
    if (!requireParkService(principal.organizationId, res, sendJSON)) return true;
    const park = getParkAdmin(principal, res, sendJSON, '当前企业不是产业园管理方');
    if (!park) return true;
    if (method === 'GET') {
      sendJSON(res, 200, { specialists: db.listParkServiceSpecialists(park.id) });
      return true;
    }
    const body = await readBody(req);
    try {
      const serviceId = typeof body.serviceId === 'string' ? body.serviceId : '';
      const accountId = typeof body.accountId === 'string' ? body.accountId : '';
      if (method === 'DELETE') {
        db.removeParkServiceSpecialist({
          parkId: park.id,
          actorAccountId: principal.account.id,
          serviceId,
          accountId,
        });
        sendJSON(res, 200, { status: 'deleted' });
      } else {
        const specialist = db.setParkServiceSpecialist({
          parkId: park.id,
          actorAccountId: principal.account.id,
          serviceId,
          accountId,
        });
        sendJSON(res, 201, { specialist });
      }
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : '专员设置失败' });
    }
    return true;
  }

  if (path === '/enterprise/park/services' && (method === 'GET' || method === 'PATCH')) {
    const principal = adminPrincipal!;
    if (principal.kind !== 'account') {
      sendJSON(res, 403, { error: '请使用产业园管理员账号配置服务' });
      return true;
    }
    if (!requireParkService(principal.organizationId, res, sendJSON)) return true;
    const park = getParkAdmin(principal, res, sendJSON, '当前企业不是产业园管理方');
    if (!park) return true;
    if (method === 'GET') {
      sendJSON(res, 200, { services: db.listParkServices(park.id) });
      return true;
    }
    const body = await readBody(req);
    try {
      const config = body.config && typeof body.config === 'object' && !Array.isArray(body.config)
        ? Object.fromEntries(Object.entries(body.config).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ))
        : undefined;
      const service = db.updateParkService({
        parkId: park.id,
        actorAccountId: principal.account.id,
        serviceId: typeof body.serviceId === 'string' ? body.serviceId : '',
        name: typeof body.name === 'string' ? body.name : undefined,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        config,
      });
      sendJSON(res, 200, { service });
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : '园区服务配置失败' });
    }
    return true;
  }

  if (path === '/enterprise/park/view' && method === 'GET') {
    if (!requireParkService(memberAccount!.organizationId, res, sendJSON)) return true;
    const park = db.getParkForOrganization(memberAccount!.organizationId);
    const profile = park ? db.getParkTenantProfile(memberAccount!.organizationId) : null;
    sendJSON(res, 200, {
      park: park ? {
        ...park,
        isAdminOrganization: park.adminOrganizationId === memberAccount!.organizationId,
        services: db.listParkServices(park.id),
        tenantAddress: profile?.address ?? null,
        tenantRoomNumber: profile?.roomNumber ?? null,
      } : null,
    });
    return true;
  }

  return false;
}
