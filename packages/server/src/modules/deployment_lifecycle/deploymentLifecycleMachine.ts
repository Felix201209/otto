/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-10 — 部署完整生命周期状态机（纯函数）。
 *
 * 从 CONTROL-10 注册核心的终态 registered 扩展为完整生命周期：
 *   ordered → bootstrap_issued → registering → registered → installing → activating
 *   → initializing → healthy
 *   healthy ──> degraded / revoked / decommissioned
 *   degraded ─> healthy（恢复）/ revoked / decommissioned
 *
 * 规则：
 *  - 所有迁移带单调版本 + 幂等键（transitionKey）+ 审计事件名；
 *  - 终态不可逆：registered 之后的可逆路径是 deployed→healthy↔degraded，
 *    revoked / decommissioned 为终态（防克隆/防重放/防复活）；
 *  - fail closed：未注册（ordered/bootstrap_issued）不得进入可用的 deploying 之后状态。
 */

export const DEPLOYMENT_STATES = [
  'ordered',
  'bootstrap_issued',
  'registering',
  'registered',
  'installing',
  'activating',
  'initializing',
  'healthy',
  'degraded',
  'revoked',
  'decommissioned',
] as const;

export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

/** 是否「已注册且未撤销/未退役」—— 可领取 License / 处理指令的先决条件。 */
export function isDeploymentUsable(state: DeploymentState | undefined): boolean {
  if (!state) return false;
  switch (state) {
    case 'registered':
    case 'installing':
    case 'activating':
    case 'initializing':
    case 'healthy':
    case 'degraded':
      return true;
    default:
      return false; // ordered/bootstrap_issued 未注册、revoked/decommissioned 已停用
  }
}

/** 是否已进入部署可用状态（registered 及之后）。 */
export function isRegisteredOrLater(state: DeploymentState | undefined): boolean {
  if (!state) return false;
  return DEPLOYMENT_STATES.indexOf(state) >= DEPLOYMENT_STATES.indexOf('registered');
}

/** 逐状态判断后一状态是否合法（无隐式乱跳）。 */
export function deploymentCanTransition(
  from: DeploymentState | undefined,
  to: DeploymentState,
): boolean {
  if (from === undefined) return to === 'registering';
  switch (from) {
    case 'ordered':
      return to === 'registering';
    case 'bootstrap_issued':
      return to === 'registering';
    case 'registering':
      return to === 'registered';
    case 'registered':
      return to === 'installing' || to === 'revoked' || to === 'decommissioned';
    case 'installing':
      return to === 'activating' || to === 'revoked' || to === 'decommissioned';
    case 'activating':
      return to === 'initializing' || to === 'revoked' || to === 'decommissioned';
    case 'initializing':
      return to === 'healthy' || to === 'revoked' || to === 'decommissioned';
    case 'healthy':
      return to === 'degraded' || to === 'revoked' || to === 'decommissioned';
    case 'degraded':
      return to === 'healthy' || to === 'revoked' || to === 'decommissioned';
    case 'revoked':
    case 'decommissioned':
      return false; // 终态，防复活
    default:
      return false;
  }
}

/** 一次已校验的部署状态迁移（含单调版本 + 幂等键 + 审计事件名）。 */
export interface DeploymentTransition {
  deploymentId: string;
  from: DeploymentState | undefined;
  to: DeploymentState;
  /** 单调递增版本（旧版本/乱序将被仓库层拒绝）。 */
  version: number;
  /** 幂等键：同一次操作重复提交返回同一结果。 */
  transitionId: string;
  /** 审计事件名（不含密钥/业务明文）。 */
  auditEvent: string;
  atMs: number;
  /** 触发原因简述（进入审计，不含秘密）。 */
  reason?: string;
}

/** 审计事件名 —— 与 lifecycle 的核心状态对应。 */
export const DEPLOYMENT_AUDIT_EVENTS: Record<DeploymentState, string> = {
  ordered: 'deployment.ordered',
  bootstrap_issued: 'deployment.bootstrap_issued',
  registering: 'deployment.registering',
  registered: 'deployment.registered',
  installing: 'deployment.installing',
  activating: 'deployment.activating',
  initializing: 'deployment.initializing',
  healthy: 'deployment.healthy',
  degraded: 'deployment.degraded',
  revoked: 'deployment.revoked',
  decommissioned: 'deployment.decommissioned',
};

/** 校验一次迁移：终态 + 顺序 + 版本单调。纯函数，仓库层负责幂等键去重。 */
export function checkTransition(
  input: { from?: DeploymentState; to: DeploymentState; version: number; latestVersion: number },
): { ok: true } | { ok: false; reason: 'invalid_from' | 'version_stale' } {
  if (!deploymentCanTransition(input.from, input.to)) {
    return { ok: false, reason: 'invalid_from' };
  }
  // 陈旧版本（乱序/旧制品回放）拒绝
  if (input.version <= input.latestVersion) {
    return { ok: false, reason: 'version_stale' };
  }
  return { ok: true };
}

/** 依据审计事件推导目标状态（供恢复投影用）。 */
export function stateFromAuditEvent(event: string): DeploymentState | null {
  const hit = (Object.keys(DEPLOYMENT_AUDIT_EVENTS) as DeploymentState[]).find(
    (s) => DEPLOYMENT_AUDIT_EVENTS[s] === event,
  );
  return hit ?? null;
}
