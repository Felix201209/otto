import type { IncomingMessage, ServerResponse } from 'node:http';
import * as db from './db.js';
import { buildOrganizationInviteLink } from '../modules/identity_organization/index.js';

export type PlatformOrganizationPrincipal =
  | { kind: 'system'; organizationId: string }
  | { kind: 'account'; organizationId: string; account: db.AccountView };

export interface PlatformOrganizationRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  adminPrincipal: PlatformOrganizationPrincipal | null;
  publicBaseUrl: string;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

function withPublicInviteLink<T extends { code: string } | null>(
  invite: T,
  publicBaseUrl: string,
): T extends null ? null : T & { link: string } {
  return (invite
    ? { ...invite, link: buildOrganizationInviteLink(publicBaseUrl, invite.code) }
    : null) as T extends null ? null : T & { link: string };
}

function accountConflictMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message === '企业至少需要保留一名可登录管理员') return message;
  if (message === '手机号已绑定其他账号' || /accounts\.phone|idx_accounts_phone_unique/i.test(message)) {
    return '手机号已绑定其他账号';
  }
  if (/unique constraint|accounts\.username/i.test(message)) return '账号名已存在';
  return null;
}

function accountInputMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message === '手机号格式不正确' || message === '登录密码不符合安全要求') return message;
  if (message === '账号状态必须是 active 或 disabled') return message;
  if (message === 'username required') return '账号不能为空';
  if (message === 'name required') return '姓名不能为空';
  if (message === '飞书 open_id 格式不正确') return message;
  if (message.startsWith('头像')) return message;
  return null;
}

function buildPlatformParkOverview(organizationId: string) {
  const park = db.getParkForOrganization(organizationId);
  return park ? {
    ...park,
    isAdminOrganization: park.adminOrganizationId === organizationId,
    services: db.listParkServices(park.id),
    tenants: park.adminOrganizationId === organizationId
      ? db.listParkTenantOrganizations(park.id)
      : [],
  } : null;
}

export async function handlePlatformOrganizationRoute({
  path,
  method,
  req,
  res,
  adminPrincipal,
  publicBaseUrl,
  readBody,
  sendJSON,
}: PlatformOrganizationRouteDeps): Promise<boolean> {
  if (path === '/enterprise/organizations' && method === 'GET') {
    if (adminPrincipal!.kind !== 'system') {
      sendJSON(res, 403, { error: 'forbidden: platform admin token required' });
      return true;
    }
    sendJSON(res, 200, { organizations: db.listEnterpriseOrganizations() });
    return true;
  }

  if (path === '/enterprise/organizations' && method === 'POST') {
    if (adminPrincipal!.kind !== 'system') {
      sendJSON(res, 403, { error: 'forbidden: platform admin token required' });
      return true;
    }
    const body = await readBody(req);
    const admin = body.admin && typeof body.admin === 'object'
      ? body.admin as Record<string, unknown>
      : {};
    const name = typeof body.name === 'string' ? body.name : '';
    const username = typeof admin.username === 'string' ? admin.username : '';
    const password = typeof admin.password === 'string' ? admin.password : '';
    const adminName = typeof admin.name === 'string' ? admin.name : '';
    if (!name.trim() || !username.trim() || !adminName.trim() || !db.isAcceptableAccountPassword(password)) {
      sendJSON(res, 400, {
        error: '企业名称及首位管理员的用户名、姓名和符合安全要求的密码不能为空',
      });
      return true;
    }
    try {
      const provisioned = db.provisionOrganization({
        name,
        slug: typeof body.slug === 'string' ? body.slug : undefined,
        admin: {
          username,
          password,
          name: adminName,
          phone: typeof admin.phone === 'string' ? admin.phone : null,
        },
      });
      const invite = withPublicInviteLink(
        provisioned.invite,
        publicBaseUrl,
      );
      sendJSON(res, 201, {
        organization: provisioned.organization,
        admin: provisioned.admin,
        invite,
      });
    } catch (error) {
      const conflict = accountConflictMessage(error);
      if (conflict) sendJSON(res, 409, { error: conflict });
      else if (/unique constraint|organizations\.slug/i.test(String(error))) {
        sendJSON(res, 409, { error: '企业标识已存在' });
      } else throw error;
    }
    return true;
  }

  if (path.startsWith('/enterprise/platform/organizations/')) {
    if (adminPrincipal!.kind !== 'system') {
      sendJSON(res, 403, { error: 'forbidden: platform admin token required' });
      return true;
    }
    const segments = path
      .slice('/enterprise/platform/organizations/'.length)
      .split('/');
    let organizationId = '';
    let accountId = '';
    try {
      organizationId = decodeURIComponent(segments[0] || '');
      accountId = segments[2] ? decodeURIComponent(segments[2]) : '';
    } catch {
      sendJSON(res, 404, { error: 'Organization not found' });
      return true;
    }
    const organization = organizationId
      ? db.getEnterpriseOrganization(organizationId)
      : null;
    if (!organization) {
      sendJSON(res, 404, { error: 'Organization not found' });
      return true;
    }
    const resource = segments[1] || '';

    if (segments.length === 2 && resource === 'overview' && method === 'GET') {
      const usage = db.getOrganizationUsageSummary(organizationId, 30);
      const usageByAccount = new Map(
        usage.byAccount.map((row) => [row.accountId, row]),
      );
      const accounts = db.listAccounts(organizationId).map((account) => ({
        ...account,
        usage: usageByAccount.get(account.id) || {
          accountId: account.id,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          requestCount: 0,
          lastUsedAt: null,
        },
      }));
      sendJSON(res, 200, {
        organization,
        accounts,
        features: db.getOrganizationFeatures(organizationId),
        park: buildPlatformParkOverview(organizationId),
        invite: withPublicInviteLink(
          db.getOrganizationInvite(organizationId),
          publicBaseUrl,
        ),
        usage,
      });
      return true;
    }

    if (segments.length === 2 && resource === 'invite' && method === 'POST') {
      const body = await readBody(req);
      const maxUses = typeof body.maxUses === 'number' || typeof body.maxUses === 'string'
        ? Number(body.maxUses)
        : null;
      const invite = withPublicInviteLink(
        db.issueOrganizationInvite(
          organizationId,
          Date.now(),
          null,
          {
            defaultDepartment: typeof body.defaultDepartment === 'string'
              ? body.defaultDepartment
              : null,
            departmentId: typeof body.departmentId === 'string'
              ? body.departmentId
              : null,
            positionId: typeof body.positionId === 'string'
              ? body.positionId
              : null,
            positionTitle: typeof body.positionTitle === 'string'
              ? body.positionTitle
              : null,
            defaultRole: typeof body.defaultRole === 'string'
              ? body.defaultRole
              : null,
            maxUses,
          },
        ),
        publicBaseUrl,
      );
      sendJSON(res, 201, { organization, invite });
      return true;
    }

    if (segments.length === 3 && resource === 'park' && segments[2] === 'join' && method === 'POST') {
      const body = await readBody(req);
      try {
        const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode : '';
        const actor = db.listAccounts(organizationId).find(
          (account) => account.isAdmin && account.status === 'active',
        );
        if (!actor) {
          sendJSON(res, 409, { error: '该企业没有可用的企业管理员账号，无法加入产业园' });
          return true;
        }
        const park = db.joinOrganizationToPark({
          organizationId,
          actorAccountId: actor.id,
          code: inviteCode,
          address: typeof body.address === 'string' ? body.address : '',
          roomNumber: typeof body.roomNumber === 'string' ? body.roomNumber : '',
        });
        sendJSON(res, 200, {
          organization: db.getEnterpriseOrganization(organizationId),
          park: {
            ...park,
            isAdminOrganization: park.adminOrganizationId === organizationId,
            services: db.listParkServices(park.id),
            tenants: park.adminOrganizationId === organizationId
              ? db.listParkTenantOrganizations(park.id)
              : [],
          },
        });
      } catch (error) {
        sendJSON(res, 400, { error: error instanceof Error ? error.message : 'park join failed' });
      }
      return true;
    }

    if (segments.length === 2 && resource === 'park' && method === 'POST') {
      const body = await readBody(req);
      try {
        const park = db.createParkAsPlatform({
          adminOrganizationId: organizationId,
          name: typeof body.name === 'string' ? body.name : undefined,
          slug: typeof body.slug === 'string' ? body.slug : undefined,
          brandName: typeof body.brandName === 'string' ? body.brandName : undefined,
        });
        sendJSON(res, 201, {
          organization: db.getEnterpriseOrganization(organizationId),
          park,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'park provisioning failed';
        if (message === 'Organization not found') sendJSON(res, 404, { error: message });
        else sendJSON(res, 400, { error: message });
      }
      return true;
    }

    if (segments.length === 2 && resource === 'park' && method === 'PATCH') {
      const body = await readBody(req);
      const hasName = typeof body.name === 'string';
      const hasBrandName = typeof body.brandName === 'string';
      if (!hasName && !hasBrandName) {
        sendJSON(res, 400, { error: '至少提供一个需要修改的产业园字段' });
        return true;
      }
      try {
        const park = db.updateParkAsPlatform({
          adminOrganizationId: organizationId,
          name: hasName ? body.name as string : undefined,
          brandName: hasBrandName ? body.brandName as string : undefined,
        });
        sendJSON(res, 200, {
          organization: db.getEnterpriseOrganization(organizationId),
          park,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'park update failed';
        if (message === 'Park admin organization not found') {
          sendJSON(res, 404, { error: message });
        } else {
          sendJSON(res, 400, { error: message });
        }
      }
      return true;
    }

    if (
      segments.length === 3
      && resource === 'accounts'
      && accountId
      && method === 'PATCH'
    ) {
      if (!db.getAccount(accountId, organizationId)) {
        sendJSON(res, 404, { error: 'Account not found' });
        return true;
      }
      const body = await readBody(req);
      const hasRole = typeof body.role === 'string' || body.role === null;
      const hasAdminPermission = typeof body.isAdmin === 'boolean';
      const hasStatus = body.status === 'active' || body.status === 'disabled';
      if (body.isAdmin !== undefined && !hasAdminPermission) {
        sendJSON(res, 400, { error: '管理员权限必须是布尔值' });
        return true;
      }
      if (body.status !== undefined && !hasStatus) {
        sendJSON(res, 400, { error: '账号状态必须是 active 或 disabled' });
        return true;
      }
      if (body.role !== undefined && !hasRole) {
        sendJSON(res, 400, { error: '角色名称格式不正确' });
        return true;
      }
      if (typeof body.role === 'string' && body.role.trim().length > 80) {
        sendJSON(res, 400, { error: '角色名称不能超过 80 个字符' });
        return true;
      }
      if (!hasRole && !hasAdminPermission && !hasStatus) {
        sendJSON(res, 400, { error: '至少提供一个需要修改的账号权限字段' });
        return true;
      }
      try {
        const account = db.updateAccount(accountId, {
          role: hasRole ? body.role as string | null : undefined,
          isAdmin: hasAdminPermission ? body.isAdmin as boolean : undefined,
          status: hasStatus ? body.status as 'active' | 'disabled' : undefined,
        }, organizationId);
        sendJSON(res, 200, { organization, account });
      } catch (error) {
        const conflict = accountConflictMessage(error);
        const inputError = accountInputMessage(error);
        if (conflict) sendJSON(res, 409, { error: conflict });
        else if (inputError) sendJSON(res, 400, { error: inputError });
        else if (error instanceof Error && error.message === 'Account not found') {
          sendJSON(res, 404, { error: error.message });
        } else throw error;
      }
      return true;
    }

    if (
      segments.length === 3
      && resource === 'accounts'
      && accountId
      && method === 'DELETE'
    ) {
      if (!db.getAccount(accountId, organizationId)) {
        sendJSON(res, 404, { error: 'Account not found' });
        return true;
      }
      try {
        sendJSON(
          res,
          200,
          db.deleteAccount(accountId, organizationId, 'platform-admin'),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '删除账号失败';
        if (message === '企业至少需要保留一名可登录管理员') {
          sendJSON(res, 409, { error: message });
        } else if (message === 'Account not found') {
          sendJSON(res, 404, { error: message });
        } else {
          throw error;
        }
      }
      return true;
    }

    sendJSON(res, 404, { error: `Not found: ${method} ${path}` });
    return true;
  }

  return false;
}
