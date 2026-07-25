/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Electron main 的企业认证提交闸门。中心账号只有在本机 OttoServer 同步成功后
 * 才能返回 renderer；任何失败都会清中心 token、持久化退出态并尝试清本机身份。
 */

import type {
  EnterpriseAccount,
  EnterpriseClient,
  EnterpriseOrganizationView,
  EnterpriseSessionResult,
} from './enterprise-client.js';
import type {
  AuthenticatedEnterpriseAccountInput,
  AuthenticatedEnterpriseOrganizationMemberInput,
} from './enterprise-identity.js';

export const ENTERPRISE_JOIN_REAUTH_REQUIRED_MESSAGE =
  '企业已成功加入，但本机身份同步失败，请重新登录以完成企业切换';

type EnterpriseLogoutClient = Pick<EnterpriseClient, 'logout'> &
  Partial<Pick<EnterpriseClient, 'getOrganizationView'>>;
export type EnterpriseIdentitySynchronizer = (
  account: AuthenticatedEnterpriseAccountInput | null,
) => Promise<void>;

/** 2 分钟刷新、10 分钟到期：允许休眠/断网后的短暂恢复窗口，但远端撤权不会无限沿用。 */
export const ENTERPRISE_IDENTITY_LEASE_MS = 10 * 60_000;

/**
 * 认证事务从“开始请求中心服务”起串行化。仅在 ServerManager 层对最终同步排队
 * 不够：旧 logout 可能在等待网络时被新 login 越过，随后再把新身份清空。
 */
export class EnterpriseAuthOperationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.tail.catch(() => undefined).then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const ENTERPRISE_DIRECTORY_MEMBER_LIMIT = 200;

function boundedDirectoryText(
  value: unknown,
  maxLength: number,
  required = false,
): string | null | undefined {
  if (value === null && !required) return null;
  if (typeof value !== 'string') return required ? undefined : null;
  const clean = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('').trim();
  if (!clean) return required ? undefined : null;
  if (clean.length > maxLength) {
    return required ? undefined : clean.slice(0, maxLength);
  }
  return clean;
}

function organizationMembersFromView(
  account: EnterpriseAccount,
  view: EnterpriseOrganizationView,
): AuthenticatedEnterpriseOrganizationMemberInput[] | undefined {
  if (
    !view.organization ||
    view.organization.id !== account.organizationId ||
    view.organization.status !== 'active'
  ) {
    return undefined;
  }
  const members: AuthenticatedEnterpriseOrganizationMemberInput[] = [];
  for (const member of view.members) {
    if (member.status !== 'active') continue;
    const id = boundedDirectoryText(member.id, 128, true);
    const username = boundedDirectoryText(member.username, 128, true);
    const name = boundedDirectoryText(member.name, 160, true);
    if (!id || !username || !name) continue;
    members.push({
      id,
      username,
      name,
      role: boundedDirectoryText(member.role, 64) ?? null,
      department: boundedDirectoryText(member.department, 160) ?? null,
      positionId: boundedDirectoryText(member.positionId, 128) ?? null,
      positionTitle: boundedDirectoryText(member.positionTitle, 160) ?? null,
      isAdmin: member.isAdmin,
      status: 'active',
    });
    if (members.length >= ENTERPRISE_DIRECTORY_MEMBER_LIMIT) break;
  }
  return members;
}

async function localAccount(
  account: EnterpriseAccount,
  client: EnterpriseLogoutClient,
): Promise<AuthenticatedEnterpriseAccountInput> {
  let organizationMembers:
    | AuthenticatedEnterpriseOrganizationMemberInput[]
    | undefined;
  if (client.getOrganizationView) {
    try {
      organizationMembers = organizationMembersFromView(
        account,
        await client.getOrganizationView(),
      );
    } catch {
      // 当前账号来自已认证会话，仍可同步；目录不可达时保持未知，绝不伪造同事。
    }
  }
  return {
    id: account.id,
    organizationId: account.organizationId,
    organizationName: account.organizationName,
    name: account.name,
    isAdmin: account.isAdmin,
    role: account.role,
    tags: account.tags,
    department: account.department,
    positionId: account.positionId,
    positionTitle: account.positionTitle,
    ...(organizationMembers ? { organizationMembers } : {}),
    leaseExpiresAt: new Date(Date.now() + ENTERPRISE_IDENTITY_LEASE_MS).toISOString(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 认证已经在中心成功、但本机提交或凭据持久化失败时的 best-effort 回滚。
 * 回滚错误不覆盖触发回滚的原始安全错误。
 */
async function rollbackFailedAuthentication(
  client: EnterpriseLogoutClient,
  synchronize: EnterpriseIdentitySynchronizer,
  persistSession: () => void,
): Promise<void> {
  try {
    await client.logout();
  } catch {
    // EnterpriseClient.logout 在请求中心服务前已经清 token；继续持久化退出态。
  }
  try {
    persistSession();
  } catch {
    // 原始同步错误更能指导用户修复；持久化错误不阻断本机身份清理。
  }
  try {
    await synchronize(null);
  } catch {
    // 旧/失效控制面可能连清理都失败；调用方抛出的原始错误已经要求重启。
  }
}

/** 登录/短信注册共用：本机身份同步成功才向 renderer 提交登录结果。 */
export async function authenticateAndSyncEnterpriseAccount<
  TResult extends { account: EnterpriseAccount },
>(
  authenticate: () => Promise<TResult>,
  client: EnterpriseLogoutClient,
  synchronize: EnterpriseIdentitySynchronizer,
  persistSession: () => void,
): Promise<TResult> {
  const result = await authenticate();
  try {
    await synchronize(await localAccount(result.account, client));
    persistSession();
    return result;
  } catch (error) {
    await rollbackFailedAuthentication(client, synchronize, persistSession);
    throw new Error(`企业登录未能安全完成：${errorMessage(error)}`);
  }
}

/**
 * 启动恢复共用：包括未登录/中心暂不可达时，也先清掉本机 server 的旧身份。
 * 同步失败不把 account 交给 renderer，并清除中心 token 保持在登录页。
 */
export async function restoreAndSyncEnterpriseSession(
  session: EnterpriseSessionResult,
  client: EnterpriseLogoutClient,
  synchronize: EnterpriseIdentitySynchronizer,
  persistSession: () => void,
): Promise<EnterpriseSessionResult> {
  try {
    await synchronize(
      session.account ? await localAccount(session.account, client) : null,
    );
    return session;
  } catch (error) {
    await rollbackFailedAuthentication(client, synchronize, persistSession);
    return {
      serverUrl: session.serverUrl,
      account: null,
      connectionError: `企业登录未能安全恢复：${errorMessage(error)}`,
    };
  }
}

/**
 * 已登录账号被中心服务更新后刷新本机授权。account=null 表示中心已同时撤销
 * 当前 session（例如自降管理员、停用账号或改密），必须清本机身份。
 */
export async function syncVerifiedEnterpriseAccount(
  account: EnterpriseAccount | null,
  client: EnterpriseLogoutClient,
  synchronize: EnterpriseIdentitySynchronizer,
  persistSession: () => void,
): Promise<void> {
  try {
    await synchronize(account ? await localAccount(account, client) : null);
  } catch (error) {
    await rollbackFailedAuthentication(client, synchronize, persistSession);
    throw new Error(`企业账号变更未能安全应用：${errorMessage(error)}`);
  }
}

/**
 * 加入企业是中心服务已经提交的不可重复阶段。后续本机身份同步失败时仍执行安全
 * 回滚，但向 renderer 返回专用错误，要求清掉旧个人身份并重新登录完成对账。
 */
export async function syncJoinedEnterpriseAccount(
  account: EnterpriseAccount,
  client: EnterpriseLogoutClient,
  synchronize: EnterpriseIdentitySynchronizer,
  persistSession: () => void,
): Promise<void> {
  try {
    await syncVerifiedEnterpriseAccount(account, client, synchronize, persistSession);
  } catch (error) {
    throw new Error(`${ENTERPRISE_JOIN_REAUTH_REQUIRED_MESSAGE}：${errorMessage(error)}`);
  }
}

/**
 * 加入企业请求的提交结果无法与中心对账时 fail closed：远端 logout 即使失败，
 * EnterpriseClient 也会先清 token；随后持久化退出态并清本机控制面身份。
 */
export async function failClosedUncertainEnterpriseJoin(
  cause: unknown,
  client: EnterpriseLogoutClient,
  synchronize: EnterpriseIdentitySynchronizer,
  persistSession: () => void,
): Promise<never> {
  try {
    await logoutAndClearEnterpriseIdentity(client, synchronize, persistSession);
  } catch {
    // 清 token、持久化退出态、清本机身份均已分别尝试；保留原始不确定状态原因。
  }
  throw new Error(`${ENTERPRISE_JOIN_REAUTH_REQUIRED_MESSAGE}：${errorMessage(cause)}`);
}

/**
 * 后台 `/auth/me` 刷新短租约。网络暂不可达时不主动清 token，让本机租约自行
 * 到期；明确 401/未登录则立即清本机身份并持久化退出态。
 */
export async function refreshEnterpriseIdentityLease(
  session: EnterpriseSessionResult,
  client: EnterpriseLogoutClient,
  synchronize: EnterpriseIdentitySynchronizer,
  persistSession: () => void,
): Promise<'refreshed' | 'signed-out' | 'deferred'> {
  if (session.connectionError) return 'deferred';
  await syncVerifiedEnterpriseAccount(
    session.account,
    client,
    synchronize,
    persistSession,
  );
  if (session.account) return 'refreshed';
  persistSession();
  return 'signed-out';
}

/**
 * 用户主动退出：先让 EnterpriseClient 同步清空内存 token，再立即落盘退出态并
 * 清理本机身份。中心 session 撤销使用旧 token 在后台 best-effort 完成，网络
 * 不可达时也不能把客户端卡在已登录界面，或让旧 token 留在本机持久化状态。
 */
export async function logoutAndClearEnterpriseIdentity(
  client: EnterpriseLogoutClient,
  synchronize: EnterpriseIdentitySynchronizer,
  persistSession: () => void,
): Promise<void> {
  let persistError: unknown;
  let synchronizeError: unknown;
  try {
    const remoteLogout = client.logout();
    void remoteLogout.catch(() => undefined);
  } catch {
    // 即使实现同步抛错，本机退出也必须继续；远端 session 会按 TTL 失效。
  }
  try {
    persistSession();
  } catch (error) {
    persistError = error;
  }
  try {
    await synchronize(null);
  } catch (error) {
    synchronizeError = error;
  }
  // 本机未清理是更高优先级的授权风险；其次是不安全的凭据落盘失败。
  if (synchronizeError) throw synchronizeError;
  if (persistError) throw persistError;
}

/** EnterpriseClient 已因 401 清 token 后调用；先落盘，再清本机授权。 */
export async function clearInvalidatedEnterpriseIdentity(
  synchronize: EnterpriseIdentitySynchronizer,
  persistSession: () => void,
): Promise<void> {
  let persistError: unknown;
  try {
    persistSession();
  } catch (error) {
    persistError = error;
  }
  await synchronize(null);
  if (persistError) throw persistError;
}
