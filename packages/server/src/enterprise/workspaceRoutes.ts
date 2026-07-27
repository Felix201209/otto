import type { IncomingMessage, ServerResponse } from 'node:http';
import * as db from './db.js';
import { buildOrganizationInviteLink } from '../modules/identity_organization/index.js';

export type WorkspaceRoutePrincipal =
  | { kind: 'system'; organizationId: string }
  | { kind: 'account'; organizationId: string; account: db.AccountView };

export interface WorkspaceRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  adminPrincipal: WorkspaceRoutePrincipal | null;
  publicBaseUrl: string;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
  extractToken(req: IncomingMessage): string;
}

function withPublicInviteLink<T extends { code: string } | null>(
  invite: T,
  publicBaseUrl: string,
): T extends null ? null : T & { link: string } {
  return (invite
    ? { ...invite, link: buildOrganizationInviteLink(publicBaseUrl, invite.code) }
    : null) as T extends null ? null : T & { link: string };
}

export async function handleWorkspaceRoute({
  path,
  method,
  req,
  res,
  url,
  adminPrincipal,
  publicBaseUrl,
  readBody,
  sendJSON,
  extractToken,
}: WorkspaceRouteDeps): Promise<boolean> {
  if (path === '/enterprise/organization/invite' && method === 'GET') {
    const organization = db.getOrganization(adminPrincipal!.organizationId);
    sendJSON(res, 200, {
      organization,
      invite: withPublicInviteLink(
        db.getOrganizationInvite(adminPrincipal!.organizationId),
        publicBaseUrl,
      ),
    });
    return true;
  }

  if (path === '/enterprise/organization/invite' && method === 'POST') {
    const principal = adminPrincipal!;
    const organization = db.getOrganization(principal.organizationId);
    const body = await readBody(req);
    const defaultDepartment = typeof body.defaultDepartment === 'string'
      ? body.defaultDepartment
      : typeof body.department === 'string' ? body.department : null;
    const departmentId = typeof body.departmentId === 'string' ? body.departmentId : null;
    const positionId = typeof body.positionId === 'string' ? body.positionId : null;
    const positionTitle = typeof body.positionTitle === 'string'
      ? body.positionTitle
      : typeof body.position === 'string' ? body.position : null;
    const defaultRole = typeof body.defaultRole === 'string'
      ? body.defaultRole
      : typeof body.role === 'string' ? body.role : null;
    const maxUses = typeof body.maxUses === 'number' || typeof body.maxUses === 'string'
      ? Number(body.maxUses)
      : null;
    const invite = withPublicInviteLink(
      db.issueOrganizationInvite(
        principal.organizationId,
        Date.now(),
        principal.kind === 'account' ? principal.account.id : null,
        {
          defaultDepartment,
          departmentId,
          positionId,
          positionTitle,
          defaultRole,
          maxUses,
        },
      ),
      publicBaseUrl,
    );
    sendJSON(res, 201, { organization, invite });
    return true;
  }

  if (path === '/enterprise/usage' && method === 'POST') {
    const account = db.getAccountBySession(extractToken(req));
    if (!account) {
      sendJSON(res, 401, { error: '登录已失效，请重新登录' });
      return true;
    }
    const body = await readBody(req);
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const messageId = typeof body.messageId === 'string' ? body.messageId : '';
    if (!sessionId.trim() || !messageId.trim()) {
      sendJSON(res, 400, { error: 'sessionId and messageId required' });
      return true;
    }
    try {
      const recorded = db.recordTokenUsage({
        accountId: account.id,
        sessionId,
        messageId,
        model: typeof body.model === 'string' ? body.model : null,
        inputTokens: Number(body.inputTokens),
        outputTokens: Number(body.outputTokens),
        totalTokens: Number(body.totalTokens),
      });
      sendJSON(res, recorded ? 201 : 200, { recorded, source: 'client_reported' });
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (path === '/enterprise/usage/summary' && method === 'GET') {
    const period = parseInt(url.searchParams.get('period') || '30', 10);
    sendJSON(
      res,
      200,
      db.getOrganizationUsageSummary(adminPrincipal!.organizationId, period),
    );
    return true;
  }

  return false;
}
