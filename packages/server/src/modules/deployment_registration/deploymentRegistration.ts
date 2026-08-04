/**
 * CONTROL-10 — 注册核心（纯函数）
 *
 * - 公钥派生指纹：取代 getMachineFingerprint 的可变硬件拼接。
 * - 注册状态机：ordered → registering → registered（bootstrap_issued 为待激活）。
 * - bootstrap token 校验：一次性（nonce 防重放）、过期、签名、版本/类型匹配。
 */

import { createHash } from 'node:crypto';
import {
  REG_STATES,
  type BootstrapTokenPayload,
  type DeploymentIdentity,
  type RegState,
  type RegisteredDeployment,
  type RegistrationVerificationInput,
  type RegistrationVerdict,
} from './deploymentRegistrationTypes.js';

/**
 * 由部署公钥派生稳定指纹。
 * 用一个不可逆散列，绑定「公钥」而不是可变的 hostname/platform/arch 拼接。
 */
export function deriveInstanceFingerprint(publicKeyHex: string): DeploymentIdentity {
  const normalized = publicKeyHex.toLowerCase();
  return {
    fingerprint: createHash('sha256')
      .update(`otto:deployment-identity:v1:${normalized}`)
      .digest('hex'),
    publicKeyHex: normalized,
    version: 1,
  };
}

/** 构建一次性的 bootstrap token 载荷（纯数据，不含签发）。 */
export function buildBootstrapPayload(input: {
  deploymentId: string;
  orderId: string;
  customerId: string;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs?: number;
  expected?: BootstrapTokenPayload['expected'];
}): BootstrapTokenPayload {
  return { ...input };
}

/** 校验 token 是否过期（不含验证方时钟则视为不过期）。 */
export function isBootstrapExpired(payload: BootstrapTokenPayload, nowMs: number): boolean {
  if (!payload.expiresAtMs) return false;
  return nowMs > payload.expiresAtMs;
}

/** 校验 claimed 版本/类型是否满足 token 期望。 */
export function verifyExpectedMeta(
  payload: BootstrapTokenPayload,
  claimed: { version: string; kind?: string },
): { ok: true } | { ok: false; reason: 'version_mismatch' | 'kind_mismatch' } {
  const expected = payload.expected;
  if (!expected) return { ok: true };
  if (expected.versionSatisfies && !claimed.version.startsWith(expected.versionSatisfies)) {
    return { ok: false, reason: 'version_mismatch' };
  }
  if (expected.kind && claimed.kind !== expected.kind) {
    return { ok: false, reason: 'kind_mismatch' };
  }
  return { ok: true };
}

/**
 * 校验一次注册（纯函数，不含持久化）。
 * 失败原因包含防重放、过期、签名校验、元数据匹配。
 */
export function verifyRegistration(input: RegistrationVerificationInput): RegistrationVerdict {
  // 1. 过期
  if (isBootstrapExpired(input.tokenPayload, input.nowMs)) {
    return { ok: false, reason: 'token_expired' };
  }

  // 2. 签名：证明持有与 publicKeyHex 对应的私钥。签名消息 = nonce（绑定一次性）。
  if (!input.verifySignature) {
    // 无签名验证器时拒绝（fail closed），避免误放行
    return { ok: false, reason: 'signature_invalid' };
  }
  const sigOk = input.verifySignature(
    input.publicKeyHex,
    input.nonceSignatureHex,
    input.tokenPayload.nonce,
  );
  if (!sigOk) {
    return { ok: false, reason: 'signature_invalid' };
  }

  // 3. 元数据匹配
  const meta = verifyExpectedMeta(input.tokenPayload, {
    version: input.claimedVersion,
    kind: input.claimedKind,
  });
  if (!meta.ok) return meta;

  // 4. 客户一致性（deploymentId 归属某 customer，token 绑定了 customer）
  //    真实客户归属由持久层校验 deployment_exists / customer_mismatch。

  return {
    ok: true,
    deploymentId: input.tokenPayload.deploymentId,
    orderId: input.tokenPayload.orderId,
    customerId: input.tokenPayload.customerId,
  };
}

/** 注册状态机的合法转移表（无隐式乱跳）。 */
export function canTransition(from: RegState | undefined, to: RegState): boolean {
  if (from === undefined) return to === 'registering';
  switch (from) {
    case 'ordered':
      return to === 'registering';
    case 'bootstrap_issued':
      return to === 'registering';
    case 'registering':
      return to === 'registered';
    case 'registered':
      return false; // 终态，不可变（防克隆/防重放）
    default:
      return false;
  }
}

/** 从未注册 → registered 的一次性落库记录（供 repository 原子写）。 */
export function buildRegistrationRecord(input: {
  verdict: Extract<RegistrationVerdict, { ok: true }>;
  identity: DeploymentIdentity;
  consumedNonce: string;
  nowMs: number;
}): RegisteredDeployment {
  const { verdict, identity, consumedNonce, nowMs } = input;
  return {
    deploymentId: verdict.deploymentId,
    customerId: verdict.customerId,
    orderId: verdict.orderId,
    state: 'registered',
    publicKeyHex: identity.publicKeyHex,
    fingerprint: identity.fingerprint,
    identityVersion: identity.version,
    registeredAtMs: nowMs,
    consumedNonce,
    legacyMachineFingerprintInUse: false,
  };
}

/** 便于测试断言的状态机行为描述。 */
export function describeStateMachine(): { states: readonly string[] } {
  return { states: REG_STATES };
}
