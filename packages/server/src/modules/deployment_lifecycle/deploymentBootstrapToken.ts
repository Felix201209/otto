/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-10 — 计算巢注入的一次性 bootstrap token（签发+校验，纯函数）。
 *
 * 验收要求：
 *  - 计算巢只注入"短时、一次性、限定 deploymentId 和制品摘要"的 bootstrap token；
 *  - 校验：过期/复用/错误订单/削改制品摘要/重放被拒；防跨订单替换。
 *
 * 本模块做 token 的签名信封构造与严格校验：
 *  - 绑定 deploymentId、orderId/customerId、制品 artifactsDigest、时间窗；
 *  - 限量一次性 nonce（复用由防重放层判断，这里验证其存在与随机性）；
 *  - 用 Control 信任根（Ed25519）签名，Server 内置并轮换 Control 公钥；
 *  - 校验含时间回拨防护（issuedAt 不得晚于 receiver 时钟过多）。
 */

import { canonicalJson } from '../commercial_control/signedEnvelope.js';

export interface BootstrapTokenBundled {
  /** algorithm 标识，便于未来平滑迁移。 */
  alg: 'otto-bootstrap-v1';
  payload: {
    nonce: string;
    deploymentId: string;
    orderId: string;
    customerId: string;
    issuedAtMs: number;
    /** 短时窗口，毫秒。 */
    ttlMs: number;
    /** 制品摘要（软件镜像/版本摘要），防旧制品注册。 */
    artifactsDigest: string;
    /** 部署类型（self-hosted / compute-nest）。 */
    kind?: string;
    /** 期望版本前缀。 */
    versionSatisfies?: string;
  };
  /** 由 Control 信任根签发。 */
  signatureHex: string;
  /** 签发密钥 id（轮换可追踪）。 */
  signingKeyId: string;
}

export interface BootstrapTokenSigner {
  /** 用给定 Control 私钥（PEM）对 payload 签名，返回十六进制签名。 */
  sign(payload: BootstrapTokenBundled['payload'], privateKeyPem: string): string;
  /** 用给定 Control 公钥（hex DER / PEM）验证签名。 */
  verify(publicKey: string, signed: string, message: unknown): boolean;
}

export type BootstrapTokenVerdict =
  | { ok: true; payload: BootstrapTokenBundled['payload'] }
  | { ok: false; reason: BootstrapRejectReason };

export type BootstrapRejectReason =
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'clock_skew'
  | 'artifact_mismatch'
  | 'wrong_deployment'
  | 'wrong_customer'
  | 'format';

/** 组装一次待签名的 bootstrap token 载荷。 */
export function buildBootstrapTokenPayload(input: {
  nonce: string;
  deploymentId: string;
  orderId: string;
  customerId: string;
  issuedAtMs: number;
  ttlMs: number;
  artifactsDigest: string;
  kind?: string;
  versionSatisfies?: string;
}): BootstrapTokenBundled['payload'] {
  return { ...input };
}

/** 签发一份 bootstrap token（用 Control 私钥签名）。 */
export function signBootstrapToken(
  signer: Pick<BootstrapTokenSigner, 'sign'>,
  input: {
    payload: BootstrapTokenBundled['payload'];
    privateKeyPem: string;
    signingKeyId: string;
  },
): Omit<BootstrapTokenBundled, 'alg'> & { alg: 'otto-bootstrap-v1' } {
  return {
    alg: 'otto-bootstrap-v1',
    payload: input.payload,
    signatureHex: signer.sign(input.payload, input.privateKeyPem),
    signingKeyId: input.signingKeyId,
  };
}

/**
 * 严格校验一次 bootstrap token。
 * @param receiverNowMs Server/校验方时钟。
 * @param expected 调用方期望（用于防跨订单替换/制品匹配）。
 * @param controlPublicKey Control 信任根验证公钥。
 */
export function verifyBootstrapToken(
  signer: Pick<BootstrapTokenSigner, 'verify'>,
  token: BootstrapTokenBundled,
  input: {
    receiverNowMs: number;
    expectedDeploymentId: string;
    expectedOrderId?: string;
    expectedCustomerId?: string;
    expectedArtifactsDigest: string;
    /** 允许的时钟偏差（ms），防时间回拨。 */
    maxClockSkewMs?: number;
    controlPublicKey: string;
  },
): BootstrapTokenVerdict {
  const p = token.payload;

  // 1. 格式
  if (token.alg !== 'otto-bootstrap-v1' || !p || typeof p.nonce !== 'string') {
    return { ok: false, reason: 'format' };
  }

  // 2. 签名（信任根）
  if (!signer.verify(input.controlPublicKey, token.signatureHex, p)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // 3. 时间窗：未生效 + 过期
  if (input.receiverNowMs < p.issuedAtMs) {
    const skew = p.issuedAtMs - input.receiverNowMs;
    if (skew > (input.maxClockSkewMs ?? 60_000)) {
      return { ok: false, reason: 'clock_skew' };
    }
    return { ok: false, reason: 'not_yet_valid' };
  }
  if (input.receiverNowMs > p.issuedAtMs + p.ttlMs) {
    return { ok: false, reason: 'expired' };
  }

  // 4. 防跨订单替换 / 制品摘要匹配
  if (p.deploymentId !== input.expectedDeploymentId) {
    return { ok: false, reason: 'wrong_deployment' };
  }
  if (input.expectedOrderId !== undefined && p.orderId !== input.expectedOrderId) {
    return { ok: false, reason: 'wrong_deployment' };
  }
  if (input.expectedCustomerId !== undefined && p.customerId !== input.expectedCustomerId) {
    return { ok: false, reason: 'wrong_customer' };
  }
  if (p.artifactsDigest !== input.expectedArtifactsDigest) {
    return { ok: false, reason: 'artifact_mismatch' };
  }

  return { ok: true, payload: p };
}

/** 复用校验：nonce 必须存在且随机（长度≥16/16进制），防弱随机一次性。 */
export function validateNonceStrength(nonce: string): boolean {
  return typeof nonce === 'string' && /^[0-9a-fA-F]{32,128}$/.test(nonce);
}

export { canonicalJson };
