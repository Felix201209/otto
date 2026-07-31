/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type {
  EnterpriseUpdateManifestReference,
  EnterpriseUpdatePolicyResult,
} from './enterprise-client.js';
import type { IncrementalUpdateCheckResult } from './incremental-update-service.js';
import type { UpdateCheckResult } from './update-core.js';

const DISTRIBUTION_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,63}$/u;

export function resolveDesktopDistribution(
  configured: string | undefined,
  applicationName: string,
): string {
  const explicit = configured?.trim().toLowerCase();
  if (explicit && DISTRIBUTION_ID_PATTERN.test(explicit)) return explicit;
  return /green/iu.test(applicationName) ? 'otto-green' : 'otto';
}

export interface UpdatePolicyAdapterOptions {
  distributionId: string;
  currentVersion: string;
  hasEnterpriseSession: boolean;
  resolvePolicy(): Promise<EnterpriseUpdatePolicyResult>;
  checkLegacy(): Promise<UpdateCheckResult>;
  checkManagedFull(reference: EnterpriseUpdateManifestReference): Promise<UpdateCheckResult>;
  checkIncremental(
    reference: EnterpriseUpdateManifestReference,
  ): Promise<IncrementalUpdateCheckResult>;
}

function failed(currentVersion: string, message: string): UpdateCheckResult {
  return { status: 'check-failed', currentVersion, message };
}

export async function checkForUpdateUsingPolicy(
  options: UpdatePolicyAdapterOptions,
): Promise<UpdateCheckResult> {
  const legacyAllowed = options.distributionId === 'otto';
  if (!options.hasEnterpriseSession) {
    return legacyAllowed
      ? options.checkLegacy()
      : failed(options.currentVersion, '请先登录企业账号，以验证此发行版本的更新权限。');
  }

  let result: EnterpriseUpdatePolicyResult;
  try {
    result = await options.resolvePolicy();
  } catch (error) {
    if (legacyAllowed) return options.checkLegacy();
    return failed(
      options.currentVersion,
      `企业服务器尚未支持此发行版本的更新策略：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (result.status === 'not_configured') {
    return legacyAllowed
      ? options.checkLegacy()
      : failed(options.currentVersion, '此发行版本尚未配置独立更新授权，请联系管理员。');
  }
  if (result.status === 'unavailable') {
    return failed(options.currentVersion, `暂时无法验证更新策略：${result.error}`);
  }
  const { policy } = result;
  if (policy.decision === 'none' || !policy.release) {
    return {
      status: 'up-to-date',
      currentVersion: options.currentVersion,
      latestVersion: null,
    };
  }

  const incremental = policy.release.incrementalManifest;
  let incrementalResult: IncrementalUpdateCheckResult | null = null;
  if (incremental) incrementalResult = await options.checkIncremental(incremental);

  const full = policy.release.fullManifest;
  if (full) return options.checkManagedFull(full);
  if (incrementalResult?.status === 'check-failed') {
    return failed(options.currentVersion, incrementalResult.message);
  }
  return failed(
    options.currentVersion,
    '已验证到增量组件更新；当前版本尚未提供完整安装包，请在模块更新入口继续安装。',
  );
}
