import type { IncomingMessage, ServerResponse } from 'node:http';
import * as db from './db.js';

export type AccountRoutePrincipal =
  | { kind: 'system'; organizationId: string }
  | { kind: 'account'; organizationId: string; account: db.AccountView };

export interface AccountRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  adminPrincipal: AccountRoutePrincipal | null;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
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

export async function handleAccountRoute({
  path,
  method,
  req,
  res,
  adminPrincipal,
  readBody,
  sendJSON,
}: AccountRouteDeps): Promise<boolean> {
  if (path === '/enterprise/accounts' && method === 'GET') {
    const organizationId = adminPrincipal!.organizationId;
    const usage = db.getOrganizationUsageSummary(organizationId, 30);
    const usageByAccount = new Map(usage.byAccount.map((row) => [row.accountId, row]));
    sendJSON(res, 200, {
      accounts: db.listAccounts(organizationId).map((account) => ({
        ...account,
        usage: usageByAccount.get(account.id) || {
          accountId: account.id,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          requestCount: 0,
          lastUsedAt: null,
        },
      })),
    });
    return true;
  }

  if (path === '/enterprise/accounts' && method === 'POST') {
    const body = await readBody(req);
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const name = typeof body.name === 'string' ? body.name : '';
    if (!username.trim() || !name.trim()) {
      sendJSON(res, 400, { error: '账号和姓名不能为空' });
      return true;
    }
    if (!db.isAcceptableAccountPassword(password)) {
      sendJSON(res, 400, { error: '登录密码不符合安全要求' });
      return true;
    }
    if (body.status !== undefined && body.status !== 'active' && body.status !== 'disabled') {
      sendJSON(res, 400, { error: '账号状态必须是 active 或 disabled' });
      return true;
    }
    try {
      const account = db.createAccount({
        organizationId: adminPrincipal!.organizationId,
        username,
        password,
        name,
        phone: typeof body.phone === 'string' ? body.phone : null,
        feishuOpenId: typeof body.feishuOpenId === 'string' ? body.feishuOpenId : null,
        role: typeof body.role === 'string' ? body.role : null,
        department: typeof body.department === 'string' ? body.department : null,
        departmentId: typeof body.departmentId === 'string' ? body.departmentId : null,
        positionId: typeof body.positionId === 'string' ? body.positionId : null,
        positionTitle: typeof body.positionTitle === 'string' ? body.positionTitle : null,
        avatarUrl: typeof body.avatarUrl === 'string' ? body.avatarUrl : null,
        tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        isAdmin: body.isAdmin === true,
        status: body.status === 'disabled' ? 'disabled' : 'active',
      });
      sendJSON(res, 201, { account });
    } catch (error) {
      const conflict = accountConflictMessage(error);
      const inputError = accountInputMessage(error);
      if (conflict) sendJSON(res, 409, { error: conflict });
      else if (inputError) sendJSON(res, 400, { error: inputError });
      else throw error;
    }
    return true;
  }

  if (path.startsWith('/enterprise/accounts/') && method === 'PATCH') {
    const accountId = decodeURIComponent(path.slice('/enterprise/accounts/'.length));
    const organizationId = adminPrincipal!.organizationId;
    if (!accountId || !db.getAccount(accountId, organizationId)) {
      sendJSON(res, 404, { error: 'Account not found' });
      return true;
    }
    const body = await readBody(req);
    if (typeof body.password === 'string' && body.password && !db.isAcceptableAccountPassword(body.password)) {
      sendJSON(res, 400, {
        error: body.password.length < 8
          ? '登录密码至少需要 8 位'
          : '登录密码需要避免纯数字、纯字母、重复字符或常见弱密码',
      });
      return true;
    }
    if (body.status !== undefined && body.status !== 'active' && body.status !== 'disabled') {
      sendJSON(res, 400, { error: '账号状态必须是 active 或 disabled' });
      return true;
    }
    const status = body.status === 'active' || body.status === 'disabled' ? body.status : undefined;
    try {
      const account = db.updateAccount(accountId, {
        username: typeof body.username === 'string' ? body.username : undefined,
        password: typeof body.password === 'string' && body.password ? body.password : undefined,
        name: typeof body.name === 'string' ? body.name : undefined,
        phone: typeof body.phone === 'string' || body.phone === null ? body.phone : undefined,
        feishuOpenId: typeof body.feishuOpenId === 'string' || body.feishuOpenId === null
          ? body.feishuOpenId
          : undefined,
        role: typeof body.role === 'string' || body.role === null ? body.role : undefined,
        department: typeof body.department === 'string' || body.department === null
          ? body.department
          : undefined,
        departmentId: typeof body.departmentId === 'string' || body.departmentId === null
          ? body.departmentId
          : undefined,
        positionId: typeof body.positionId === 'string' || body.positionId === null
          ? body.positionId
          : undefined,
        positionTitle: typeof body.positionTitle === 'string' || body.positionTitle === null
          ? body.positionTitle
          : undefined,
        avatarUrl: typeof body.avatarUrl === 'string' || body.avatarUrl === null
          ? body.avatarUrl
          : undefined,
        tags: Array.isArray(body.tags)
          ? body.tags.filter((tag): tag is string => typeof tag === 'string')
          : undefined,
        isAdmin: typeof body.isAdmin === 'boolean' ? body.isAdmin : undefined,
        status,
      }, organizationId);
      sendJSON(res, 200, { account });
    } catch (error) {
      const conflict = accountConflictMessage(error);
      const inputError = accountInputMessage(error);
      if (conflict) sendJSON(res, 409, { error: conflict });
      else if (inputError) sendJSON(res, 400, { error: inputError });
      else throw error;
    }
    return true;
  }

  if (path.startsWith('/enterprise/accounts/') && method === 'DELETE') {
    const accountId = decodeURIComponent(path.slice('/enterprise/accounts/'.length));
    const organizationId = adminPrincipal!.organizationId;
    if (!accountId || !db.getAccount(accountId, organizationId)) {
      sendJSON(res, 404, { error: 'Account not found' });
      return true;
    }
    const actorAccountId = adminPrincipal!.kind === 'account'
      ? adminPrincipal!.account.id
      : 'platform-admin';
    try {
      sendJSON(res, 200, db.deleteAccount(accountId, organizationId, actorAccountId));
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除账号失败';
      if (
        message === '不能删除当前登录账号'
        || message === '企业至少需要保留一名可登录管理员'
      ) {
        sendJSON(res, 409, { error: message });
      } else if (message === 'Account not found') {
        sendJSON(res, 404, { error: message });
      } else {
        throw error;
      }
    }
    return true;
  }

  return false;
}
