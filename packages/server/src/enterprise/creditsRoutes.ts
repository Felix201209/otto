import type { IncomingMessage, ServerResponse } from 'node:http';
import type * as db from './db.js';
import {
  CreditsRequestError,
  createRedeemCodes,
  redeemCode as redeemCreditCode,
  getCreditBalance,
  topUpCredits,
  listRedeemCodes,
  revokeRedeemCode,
  listCreditTransactions,
} from './credits.js';

export interface CreditsRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  memberAccount: db.AccountView | null;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

export async function handleCreditsRoute({
  path,
  method,
  req,
  res,
  url,
  memberAccount,
  readBody,
  sendJSON,
}: CreditsRouteDeps): Promise<boolean> {
  if (path === '/enterprise/credits/balance' && method === 'GET') {
    if (!memberAccount) {
      sendJSON(res, 401, { error: 'Not authenticated' });
      return true;
    }
    const balance = getCreditBalance(memberAccount.organizationId);
    sendJSON(res, 200, balance);
    return true;
  }

  if (path === '/enterprise/credits/redeem' && method === 'POST') {
    if (!memberAccount) {
      sendJSON(res, 401, { error: 'Not authenticated' });
      return true;
    }
    const body = await readBody(req);
    const code = typeof body.code === 'string' ? body.code : '';
    if (!code) {
      sendJSON(res, 400, { error: '兑换码不能为空' });
      return true;
    }
    try {
      const result = redeemCreditCode(code, memberAccount.id);
      sendJSON(res, 200, result);
    } catch (err) {
      if (!(err instanceof CreditsRequestError)) throw err;
      sendJSON(res, 400, { error: err.message });
    }
    return true;
  }

  if (path === '/enterprise/credits/redeem-codes' && method === 'POST') {
    if (!memberAccount || !memberAccount.isAdmin) {
      sendJSON(res, 403, { error: '需要管理员权限' });
      return true;
    }
    const body = await readBody(req);
    const creditAmount = typeof body.creditAmount === 'number' ? body.creditAmount : 0;
    const count = typeof body.count === 'number' ? body.count : 1;
    if (creditAmount <= 0) {
      sendJSON(res, 400, { error: '面额必须大于0' });
      return true;
    }
    try {
      const codes = createRedeemCodes(
        memberAccount.organizationId,
        memberAccount.id,
        creditAmount,
        count,
      );
      sendJSON(res, 201, { codes });
    } catch (err) {
      if (!(err instanceof CreditsRequestError)) throw err;
      sendJSON(res, 400, { error: err.message });
    }
    return true;
  }

  if (path === '/enterprise/credits/redeem-codes' && method === 'GET') {
    if (!memberAccount?.isAdmin) {
      sendJSON(res, 403, { error: '需要管理员权限' });
      return true;
    }
    const status = url.searchParams.get('status');
    if (status !== null && !['active', 'redeemed', 'revoked'].includes(status)) {
      sendJSON(res, 400, { error: '兑换码状态无效' });
      return true;
    }
    const codes = listRedeemCodes(
      memberAccount.organizationId,
      status === null
        ? undefined
        : status as 'active' | 'redeemed' | 'revoked',
    );
    sendJSON(res, 200, { codes });
    return true;
  }

  if (
    path.startsWith('/enterprise/credits/redeem-codes/')
    && path.endsWith('/revoke')
    && method === 'POST'
  ) {
    if (!memberAccount || !memberAccount.isAdmin) {
      sendJSON(res, 403, { error: '需要管理员权限' });
      return true;
    }
    const codeId = path.split('/')[4];
    const ok = revokeRedeemCode(codeId, memberAccount.organizationId);
    sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: '兑换码不存在或已处理' });
    return true;
  }

  if (path === '/enterprise/credits/topup' && method === 'POST') {
    if (!memberAccount || !memberAccount.isAdmin) {
      sendJSON(res, 403, { error: '需要管理员权限' });
      return true;
    }
    const body = await readBody(req);
    const amount = typeof body.amount === 'number' ? body.amount : 0;
    if (amount <= 0) {
      sendJSON(res, 400, { error: '充值金额必须大于0' });
      return true;
    }
    try {
      const result = topUpCredits(
        memberAccount.organizationId,
        memberAccount.id,
        amount,
        typeof body.note === 'string' ? body.note : undefined,
      );
      sendJSON(res, 200, result);
    } catch (err) {
      if (!(err instanceof CreditsRequestError)) throw err;
      sendJSON(res, 400, { error: err.message });
    }
    return true;
  }

  if (path === '/enterprise/credits/transactions' && method === 'GET') {
    if (!memberAccount?.isAdmin) {
      sendJSON(res, 403, { error: '需要管理员权限' });
      return true;
    }
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      sendJSON(res, 400, { error: 'limit 必须是 1 到 200 的整数' });
      return true;
    }
    const txns = listCreditTransactions(memberAccount.organizationId, limit);
    sendJSON(res, 200, { transactions: txns });
    return true;
  }

  return false;
}
