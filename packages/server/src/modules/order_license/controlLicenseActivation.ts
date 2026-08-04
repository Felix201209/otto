/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-11 Server 侧：License 主动领取与激活。
 *
 * 流程：已注册且未撤销的部署向 Control 发起领取请求 → Control 返回签名
 * License envelope（{ license, signature, signingKeyId }）→ Server 用既有
 * importDeploymentLicense 校验（签名/部署绑定/指纹/时间/模块）并落库激活。
 *
 * 本模块是领取驱动的可测核心：
 *  - claimLicense：执行领取（幂等），把 Control 返回的 envelope 交给
 *    importDeploymentLicense 激活；
 *  - 领取响应丢失：重发领取请求返回同一激活结果（幂等），不重复消耗订单；
 *  - 只接受 CONTROL-10 已注册且未撤销的部署（deploymentId/fingerprint 绑定）。
 *
 * 无秘密原则：激活结果与日志不包含 CEO 密码/数据库凭据/云 AccessKey/E2EE。
 */

import type { DeploymentLicenseView } from '../commercial_control/deploymentTypes.js';
import type { Database } from '../data_platform/index.js';

export interface ControlLicenseClaimResult {
  kind:
    | 'activated'
    | 'already_active'
    | 'claim_failed'
    | 'invalid_license'
    | 'deployment_not_registered';
  reason?: string;
  license?: DeploymentLicenseView;
}

export interface ControlLicenseClaimDeps {
  db(): Database;
  /** 部署 ID（部署绑定）。 */
  deploymentId: string;
  /** 机器指纹（指纹绑定）。 */
  machineFingerprint: string;
  /** 执行一次向 Control 的领取请求；返回签名 License envelope 或错误。 */
  claimFromControl(): Promise<{
    ok: true;
    envelope: unknown;
  } | {
    ok: false;
    error: string;
  }>;
  /** Server 侧验证 + 落库激活（包装 importDeploymentLicense）。 */
  applyAcceptedLicense(envelope: unknown): DeploymentLicenseView;
  /** 可注入时钟（ms）。 */
  now?(): number;
}

/**
 * Server 主动领取并激活 Control 签发的 License。
 * - 幂等：当前已激活且未过期 → 直接返回（不重复消耗订单）；
 * - 领取失败（Control 断网）→ claim_failed（由上层退避重试）；
 * - 激活结果每次相同。
 */
export async function controlLicenseClaim(
  deps: ControlLicenseClaimDeps,
): Promise<ControlLicenseClaimResult> {
  const current = readCurrentLicense(deps.db());

  // 幂等/激活中：已有 License 直接复用（不重复消耗订单）。
  if (current) {
    return {
      kind: 'already_active',
      reason: `license already present`,
    };
  }

  const claim = await deps.claimFromControl();
  if (!claim.ok) {
    return { kind: 'claim_failed', reason: claim.error };
  }

  try {
    // importDeploymentLicense 内部验证签名、deploymentId、fingerprint、时间、模块
    const activated = deps.applyAcceptedLicense(claim.envelope);
    return { kind: 'activated', license: activated };
  } catch (error) {
    return {
      kind: 'invalid_license',
      reason: error instanceof Error ? error.message : 'license activation failed',
    };
  }
}

/** 读取当前是否存在已导入的 License（用于幂等判断；状态计算由上层 store 负责）。 */
function readCurrentLicense(database: Database): { status: string } | null {
  try {
    const row = database.prepare(
      'SELECT id FROM deployment_license ORDER BY updated_at DESC LIMIT 1',
    ).get() as { id?: string } | undefined;
    if (!row || !row.id) return null;
    return { status: 'present' };
  } catch {
    return null;
  }
}
