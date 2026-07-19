/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Electron main 的企业认证提交闸门。中心账号只有在本机 OttoServer 同步成功后
 * 才能返回 renderer；任何失败都会清中心 token、持久化退出态并尝试清本机身份。
 */

import type {
  EnterpriseAccount,
  EnterpriseClient,
  EnterpriseSessionResult,
} from './enterprise-client.js';
import type { AuthenticatedEnterpriseAccountInput } from './enterprise-identity.js';

type EnterpriseLogoutClient = Pick<EnterpriseClient, 'logout'>;
export type EnterpriseIdentitySynchronizer = (
  account: AuthenticatedEnterpriseAccountInput | null,
) => Promise<void>;

/** 20 秒刷新、60 秒到期：允许短暂网络抖动，但远端撤权不会无限沿用。 */
export const ENTERPRISE_IDENTITY_LEASE_MS = 60_000;

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

function localAccount(account: EnterpriseAccount): AuthenticatedEnterpriseAccountInput {
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
    await synchronize(localAccount(result.account));
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
    await synchronize(session.account ? localAccount(session.account) : null);
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
    await synchronize(account ? localAccount(account) : null);
  } catch (error) {
    await rollbackFailedAuthentication(client, synchronize, persistSession);
    throw new Error(`企业账号变更未能安全应用：${errorMessage(error)}`);
  }
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

/** 用户主动退出：中心登出、退出态落盘和本机身份清理三个步骤均会执行。 */
export async function logoutAndClearEnterpriseIdentity(
  client: EnterpriseLogoutClient,
  synchronize: EnterpriseIdentitySynchronizer,
  persistSession: () => void,
): Promise<void> {
  let logoutError: unknown;
  let persistError: unknown;
  let synchronizeError: unknown;
  try {
    await client.logout();
  } catch (error) {
    logoutError = error;
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
  if (logoutError) throw logoutError;
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
