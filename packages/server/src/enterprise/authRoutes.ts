import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import * as db from './db.js';
import { isOrganizationInviteCode } from '../modules/identity_organization/index.js';
import { sendPublicInvitePage } from './publicInvitePage.js';

export interface AuthRouteSmsSender {
  sendVerificationCode(phone: string, code: string): Promise<boolean>;
}

export interface AuthRouteRateLimitKeys {
  identity: string;
  client: string;
}

export interface AuthRouteLoginRateLimiter {
  keys(req: IncomingMessage, identifier: string): AuthRouteRateLimitKeys;
  retryAfterSeconds(keys: AuthRouteRateLimitKeys): number;
  recordFailure(keys: AuthRouteRateLimitKeys): number;
  clearIdentity(key: string): void;
}

export interface AuthRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  memberAccount: db.AccountView | null;
  publicBaseUrl: string;
  smsSender: AuthRouteSmsSender | null;
  loginRateLimiter: AuthRouteLoginRateLimiter;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
  extractToken(req: IncomingMessage): string;
}

function registrationConflictMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message === '手机号已绑定其他账号' || /accounts\.phone|idx_accounts_phone_unique/i.test(message)) {
    return '手机号已绑定其他账号';
  }
  if (/unique constraint|accounts\.username/i.test(message)) return '账号名已存在';
  return null;
}

export async function handleAuthRoute({
  path,
  method,
  req,
  res,
  memberAccount,
  publicBaseUrl,
  smsSender,
  loginRateLimiter,
  readBody,
  sendJSON,
  extractToken,
}: AuthRouteDeps): Promise<boolean> {
  if (path.startsWith('/enterprise/join/') && method === 'GET') {
    const encodedCode = path.slice('/enterprise/join/'.length);
    let code = '';
    try {
      code = decodeURIComponent(encodedCode);
    } catch {
      sendPublicInvitePage(res, 404);
      return true;
    }
    if (!isOrganizationInviteCode(code)) {
      sendPublicInvitePage(res, 404);
      return true;
    }
    const invite = db.inspectOrganizationInvite(code);
    if (invite.status === 'invalid') {
      sendPublicInvitePage(res, 404);
      return true;
    }
    if (invite.status !== 'active') {
      sendPublicInvitePage(res, 410);
      return true;
    }
    sendPublicInvitePage(res, 200, code, publicBaseUrl);
    return true;
  }

  if ((path === '/enterprise/auth/login' || path === '/enterprise/auth/admin/login')
    && method === 'POST') {
    const body = await readBody(req);
    const identifier = typeof body.identifier === 'string'
      ? body.identifier
      : typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const rateLimitKeys = loginRateLimiter.keys(req, identifier);
    const existingRetryAfter = loginRateLimiter.retryAfterSeconds(rateLimitKeys);
    if (existingRetryAfter > 0) {
      res.setHeader('Retry-After', String(existingRetryAfter));
      sendJSON(res, 429, {
        error: '登录尝试过于频繁，请稍后再试',
        retryAfterSeconds: existingRetryAfter,
      });
      return true;
    }
    const account = db.authenticateAccount(identifier, password);
    if (!account) {
      const retryAfterSeconds = loginRateLimiter.recordFailure(rateLimitKeys);
      if (retryAfterSeconds > 0) {
        res.setHeader('Retry-After', String(retryAfterSeconds));
        sendJSON(res, 429, {
          error: '登录尝试过于频繁，请稍后再试',
          retryAfterSeconds,
        });
        return true;
      }
      sendJSON(res, 401, { error: '账号或密码错误' });
      return true;
    }
    loginRateLimiter.clearIdentity(rateLimitKeys.identity);
    if (path === '/enterprise/auth/admin/login' && !account.isAdmin) {
      sendJSON(res, 403, { error: '该账号没有管理员权限' });
      return true;
    }
    const session = db.createAuthSession(account.id);
    sendJSON(res, 200, { account, token: session.token, expiresAt: session.expiresAt });
    return true;
  }

  if (path === '/enterprise/auth/sms/request' && method === 'POST') {
    if (!smsSender) {
      sendJSON(res, 503, { error: '短信登录暂不可用，请稍后重试' });
      return true;
    }
    const body = await readBody(req);
    const rawPhone = typeof body.phone === 'string' ? body.phone : '';
    let phone: string;
    try {
      phone = db.normalizePhone(rawPhone);
    } catch {
      sendJSON(res, 400, { error: '请输入正确的中国大陆手机号' });
      return true;
    }
    const account = db.findActiveAccountByPhone(phone);
    if (!account) {
      sendJSON(res, 404, { error: '该手机号尚未注册或账号已停用' });
      return true;
    }
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const issued = db.createSmsLoginChallenge(account.id, code);
    if (!issued.ok) {
      res.setHeader('Retry-After', String(issued.retryAfterSeconds));
      sendJSON(res, 429, {
        error: issued.reason === 'cooldown'
          ? '验证码发送过于频繁，请稍后再试'
          : '本小时验证码发送次数已达上限',
        retryAfterSeconds: issued.retryAfterSeconds,
      });
      return true;
    }
    let sent = false;
    try {
      sent = await smsSender.sendVerificationCode(phone.slice(3), code);
    } catch {
      sent = false;
    }
    if (!sent) {
      db.discardSmsLoginChallenge(issued.challengeId);
      sendJSON(res, 502, { error: '验证码发送失败，请稍后重试' });
      return true;
    }
    sendJSON(res, 200, {
      ...issued,
      message: '验证码已发送，5 分钟内有效',
    });
    return true;
  }

  if (path === '/enterprise/auth/sms/verify' && method === 'POST') {
    const body = await readBody(req);
    const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!challengeId.startsWith('sms_') || !/^\d{6}$/.test(code)) {
      sendJSON(res, 400, { error: '请输入 6 位短信验证码' });
      return true;
    }
    const verified = db.verifySmsLoginChallenge(challengeId, code);
    if (!verified.ok) {
      sendJSON(res, 401, {
        error: verified.reason === 'locked'
          ? '验证码错误次数过多，请重新获取'
          : '验证码错误或已失效',
        attemptsRemaining: verified.attemptsRemaining,
      });
      return true;
    }
    const session = db.createAuthSession(verified.account.id);
    sendJSON(res, 200, {
      account: verified.account,
      token: session.token,
      expiresAt: session.expiresAt,
    });
    return true;
  }

  if (path === '/enterprise/auth/register/sms/request' && method === 'POST') {
    if (!smsSender) {
      sendJSON(res, 503, { error: '短信注册暂不可用，请稍后重试' });
      return true;
    }
    const body = await readBody(req);
    const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';
    const invite = inviteCode ? db.resolveOrganizationInviteWithDefaults(inviteCode) : null;
    if (inviteCode && !invite) {
      sendJSON(res, 403, { error: '企业邀请码无效或已过期，请联系管理员重新生成' });
      return true;
    }
    const organization = invite?.organization ?? db.getOrganization(db.DEFAULT_ORGANIZATION_ID)!;
    const rawPhone = typeof body.phone === 'string' ? body.phone : '';
    let phone: string;
    try {
      phone = db.normalizePhone(rawPhone);
    } catch {
      sendJSON(res, 400, { error: '请输入正确的中国大陆手机号' });
      return true;
    }

    if (db.findAccountByPhone(phone)) {
      sendJSON(res, 409, { error: '该手机号已注册，请直接登录' });
      return true;
    }
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const issued = db.createSmsRegistrationChallenge(phone, code, organization.id, {
      organizationInviteId: invite?.inviteId ?? null,
      department: invite?.defaultDepartment ?? null,
      departmentId: invite?.departmentId ?? null,
      positionId: invite?.positionId ?? null,
      positionTitle: invite?.positionTitle ?? null,
      role: invite?.defaultRole ?? null,
    });
    if (!issued.ok) {
      res.setHeader('Retry-After', String(issued.retryAfterSeconds));
      sendJSON(res, 429, {
        error: issued.reason === 'cooldown'
          ? '验证码发送过于频繁，请稍后再试'
          : '本小时验证码发送次数已达上限',
        retryAfterSeconds: issued.retryAfterSeconds,
      });
      return true;
    }

    let sent = false;
    try {
      sent = await smsSender.sendVerificationCode(phone.slice(3), code);
    } catch {
      sent = false;
    }
    if (!sent) {
      db.discardSmsRegistrationChallenge(issued.challengeId);
      sendJSON(res, 502, { error: '验证码发送失败，请稍后重试' });
      return true;
    }
    sendJSON(res, 200, {
      ...issued,
      message: '验证码已发送，5 分钟内有效',
      registrationMode: invite ? 'enterprise' : 'personal',
      organization: invite ? { id: organization.id, name: organization.name } : null,
    });
    return true;
  }

  if (path === '/enterprise/auth/register/sms/verify' && method === 'POST') {
    const body = await readBody(req);
    const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (body.legalConsent !== true) {
      sendJSON(res, 400, { error: '请先阅读并同意用户协议和隐私规则' });
      return true;
    }
    if (!challengeId.startsWith('smsreg_') || !/^\d{6}$/.test(code)) {
      sendJSON(res, 400, { error: '请输入 6 位短信验证码' });
      return true;
    }
    if (!name || name.length > 40 || !db.isAcceptableAccountPassword(password)) {
      sendJSON(res, 400, { error: '请填写姓名，并设置符合安全要求的登录密码' });
      return true;
    }
    const verified = db.verifySmsRegistrationChallenge(challengeId, code);
    if (!verified.ok) {
      sendJSON(res, 401, {
        error: verified.reason === 'locked'
          ? '验证码错误次数过多，请重新获取'
          : '验证码错误或已失效',
        attemptsRemaining: verified.attemptsRemaining,
      });
      return true;
    }
    let account: db.AccountView;
    try {
      account = verified.organizationInviteId
        ? db.createSelfRegisteredAccount({
          organizationId: verified.organizationId,
          phone: verified.phone,
          name,
          password,
          department: verified.department,
          departmentId: verified.departmentId,
          role: verified.role,
          positionId: verified.positionId,
          positionTitle: verified.positionTitle,
          organizationInviteId: verified.organizationInviteId,
        })
        : db.createPersonalRegisteredAccount({
          phone: verified.phone,
          name,
          password,
        });
    } catch (error) {
      const conflict = registrationConflictMessage(error) || (error instanceof Error ? error.message : null);
      if (conflict === '手机号已绑定其他账号' || conflict === '该手机号已注册，请直接登录') {
        sendJSON(res, 409, { error: '该手机号已注册，请直接登录' });
        return true;
      }
      throw error;
    }
    db.recordCurrentLegalConsent(account, 'registration');
    const session = db.createAuthSession(account.id);
    sendJSON(res, 200, {
      account,
      token: session.token,
      expiresAt: session.expiresAt,
      legalConsentRecorded: true,
    });
    return true;
  }

  if (path === '/enterprise/auth/me' && method === 'GET') {
    const account = db.getAccountBySession(extractToken(req));
    if (!account) {
      sendJSON(res, 401, { error: '登录已失效，请重新登录' });
      return true;
    }
    sendJSON(res, 200, { account });
    return true;
  }

  if (path === '/enterprise/auth/logout' && method === 'POST') {
    const token = extractToken(req);
    const account = db.getAccountBySession(token);
    if (!account) {
      sendJSON(res, 401, { error: '登录已失效，请重新登录' });
      return true;
    }
    db.revokeAuthSession(token);
    sendJSON(res, 200, { status: 'logged_out' });
    return true;
  }

  if (path === '/enterprise/auth/join-organization' && method === 'POST') {
    const body = await readBody(req);
    const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';
    if (!inviteCode) {
      sendJSON(res, 400, { error: '请输入企业邀请码' });
      return true;
    }
    try {
      const account = db.joinOrganizationWithInvite(memberAccount!.id, inviteCode);
      sendJSON(res, 200, { account });
    } catch (error) {
      const message = error instanceof Error ? error.message : '加入企业失败';
      if (message === '只有个人版账号可加入企业') {
        sendJSON(res, 409, { error: message });
      } else if (message === '企业邀请码无效、已过期或名额已用完') {
        sendJSON(res, 403, { error: message });
      } else {
        throw error;
      }
    }
    return true;
  }

  return false;
}
