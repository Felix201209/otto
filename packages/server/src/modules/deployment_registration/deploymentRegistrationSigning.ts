/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-10 — 实例身份签名能力（Ed25519）。
 *
 * 实例身份 = 每次安全安装仅生成一次的 Ed25519 密钥对；私钥交给服务端密钥库持有，
 * 对外仅暴露验证公钥与「公钥派生指纹」（取代 getMachineFingerprint 的可变拼接）。
 *
 * 演示/测试用：私钥以内存持有。生产实现应落在 KMS/HSM 或加密密钥库，
 * 不要让私钥落普通数据库与日志（与 CONTROL-11 License 签名私钥同一安全等级）。
 */

import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type {
  DeploymentIdentity,
  RegistrationSigning,
} from './deploymentRegistrationTypes.js';
import { deriveInstanceFingerprint } from './deploymentRegistration.js';
import { canonicalJson } from '../commercial_control/signedEnvelope.js';

/** 消息签名须用稳定序列化，避免字段顺序导致签名不一致。 */
export function identitySignMessage(message: unknown): string {
  return typeof message === 'string' ? message : canonicalJson(message);
}

/** 生成一份实例密钥对，仅返回公钥与派生指纹（私钥由持有方管理）。 */
export function generateInstanceIdentity(): {
  identity: DeploymentIdentity;
  privateKey: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
  return { identity: deriveInstanceFingerprint(publicKeyHex), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

/** 内置实现：内存持有私钥的 RegistrationSigning（测试/演示；生产接 KMS）。 */
export function createInMemorySigning(keys: {
  privateKeyPem: string;
  identity: DeploymentIdentity;
}): RegistrationSigning {
  return {
    createInstanceIdentity(): DeploymentIdentity {
      // 一次性安装模型：已给定身份时不再新建
      return { ...keys.identity };
    },
    signInstance(message: string): string {
      return sign(null, Buffer.from(identitySignMessage(message), 'utf8'), keys.privateKeyPem).toString('hex');
    },
    verify(pub: string, signed: string, message: string): boolean {
      return verify(
        null,
        Buffer.from(identitySignMessage(message), 'utf8'),
        createPublicKey({ key: Buffer.from(pub, 'hex'), format: 'der', type: 'spki' }),
        Buffer.from(signed, 'hex'),
      );
    },
  };
}
