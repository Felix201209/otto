import type { IncomingMessage, ServerResponse } from 'node:http';
import * as db from './db.js';

export type OrganizationRouteAdminPrincipal =
  | { kind: 'system'; organizationId: string }
  | { kind: 'account'; organizationId: string; account: db.AccountView };

export interface OrganizationRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  memberAccount: db.AccountView | null;
  adminPrincipal: OrganizationRouteAdminPrincipal | null;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

function organizationIdFromAdmin(principal: OrganizationRouteAdminPrincipal | null): string {
  return principal!.organizationId;
}

function enterpriseTreeDisabled(organizationId: string): boolean {
  return !db.getOrganizationFeatures(organizationId).enterprise_tree;
}

export async function handleOrganizationRoute({
  path,
  method,
  req,
  res,
  memberAccount,
  adminPrincipal,
  readBody,
  sendJSON,
}: OrganizationRouteDeps): Promise<boolean> {
  if (path === '/enterprise/organization/features' && method === 'GET') {
    sendJSON(res, 200, {
      features: db.getOrganizationFeatures(memberAccount!.organizationId),
    });
    return true;
  }

  if (path === '/enterprise/organization/features' && method === 'PATCH') {
    if (!memberAccount!.isAdmin) {
      sendJSON(res, 403, { error: '需要管理员权限' });
      return true;
    }
    const body = await readBody(req);
    try {
      sendJSON(res, 200, {
        features: db.updateOrganizationFeatures(
          memberAccount!.organizationId,
          body as Partial<db.OrganizationFeatures>,
        ),
      });
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : '功能开关保存失败' });
    }
    return true;
  }

  if (path === '/enterprise/organization/departments' && method === 'GET') {
    const organizationId = organizationIdFromAdmin(adminPrincipal);
    if (enterpriseTreeDisabled(organizationId)) {
      sendJSON(res, 403, { error: '企业树功能已由管理员关闭' });
      return true;
    }
    sendJSON(res, 200, { structure: db.listOrganizationStructure(organizationId) });
    return true;
  }

  if (path === '/enterprise/organization/departments' && method === 'POST') {
    const organizationId = organizationIdFromAdmin(adminPrincipal);
    if (enterpriseTreeDisabled(organizationId)) {
      sendJSON(res, 403, { error: '企业树功能已由管理员关闭' });
      return true;
    }
    const body = await readBody(req);
    try {
      const department = db.createOrganizationDepartment({
        organizationId,
        name: typeof body.name === 'string' ? body.name : '',
      });
      sendJSON(res, 201, { department });
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : '部门创建失败' });
    }
    return true;
  }

  const departmentRoute = path.match(/^\/enterprise\/organization\/departments\/([^/]+)$/);
  if (departmentRoute && (method === 'PATCH' || method === 'DELETE')) {
    const organizationId = organizationIdFromAdmin(adminPrincipal);
    if (enterpriseTreeDisabled(organizationId)) {
      sendJSON(res, 403, { error: '企业树功能已由管理员关闭' });
      return true;
    }
    const departmentId = decodeURIComponent(departmentRoute[1]!);
    try {
      if (method === 'DELETE') {
        db.deleteOrganizationDepartment({ organizationId, departmentId });
        sendJSON(res, 200, { status: 'deleted' });
      } else {
        const body = await readBody(req);
        const department = db.updateOrganizationDepartment({
          organizationId,
          departmentId,
          name: typeof body.name === 'string' ? body.name : '',
        });
        sendJSON(res, 200, { department });
      }
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : '部门更新失败' });
    }
    return true;
  }

  if (path === '/enterprise/organization/positions' && method === 'POST') {
    const organizationId = organizationIdFromAdmin(adminPrincipal);
    if (enterpriseTreeDisabled(organizationId)) {
      sendJSON(res, 403, { error: '企业树功能已由管理员关闭' });
      return true;
    }
    const body = await readBody(req);
    try {
      const position = db.createOrganizationPosition({
        organizationId,
        departmentId: typeof body.departmentId === 'string' ? body.departmentId : '',
        title: typeof body.title === 'string' ? body.title : '',
        roleMapping: typeof body.roleMapping === 'string'
          ? body.roleMapping as db.OrganizationPositionRoleMapping
          : undefined,
      });
      sendJSON(res, 201, { position });
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : '职位创建失败' });
    }
    return true;
  }

  const positionRoute = path.match(/^\/enterprise\/organization\/positions\/([^/]+)$/);
  if (positionRoute && (method === 'PATCH' || method === 'DELETE')) {
    const organizationId = organizationIdFromAdmin(adminPrincipal);
    if (enterpriseTreeDisabled(organizationId)) {
      sendJSON(res, 403, { error: '企业树功能已由管理员关闭' });
      return true;
    }
    const positionId = decodeURIComponent(positionRoute[1]!);
    try {
      if (method === 'DELETE') {
        db.deleteOrganizationPosition({ organizationId, positionId });
        sendJSON(res, 200, { status: 'deleted' });
      } else {
        const body = await readBody(req);
        const position = db.updateOrganizationPosition({
          organizationId,
          positionId,
          title: typeof body.title === 'string' ? body.title : undefined,
          roleMapping: typeof body.roleMapping === 'string'
            ? body.roleMapping as db.OrganizationPositionRoleMapping
            : undefined,
        });
        sendJSON(res, 200, { position });
      }
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : '职位更新失败' });
    }
    return true;
  }

  return false;
}
