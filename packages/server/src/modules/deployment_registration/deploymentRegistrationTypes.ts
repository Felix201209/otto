/**
 * CONTROL-10 — 部署一次性安全注册
 *
 * 取代"采集可变硬件序列号拼接值"（getMachineFingerprint）的实例身份模型。
 * 实例身份改为「公钥绑定的部署身份」：
 *   1. 安装时仅生成一次实例密钥对，私钥保存在服务端密钥库（不从磁盘可预测路径重建）。
 *   2. 上报给 Control/计算巢的身份是「公钥派生指纹」+ 签名能力来源的验证公钥。
 *   3. 注册过程由 bootstrap token 驱动，一次性、防重放、防克隆。
 *
 * 本文件为类型与生命周期声明。
 */

/** 注册生命周期状态机。 */
export const REG_STATES = ['ordered', 'bootstrap_issued', 'registering', 'registered'] as const;
export type RegState = (typeof REG_STATES)[number];

/** bootstrap token 封装：包含一次性凭据 + 期望部署/订单元数据。 */
export interface BootstrapTokenPayload {
  /** 一次性随机凭据，用于防重放/防克隆。 */
  nonce: string;
  /** 绑定的部署唯一 id（Control 侧生成）。 */
  deploymentId: string;
  /** 绑定的订单 id（用于领取 CONTROL-11 License）。 */
  orderId: string;
  /** 客户唯一 id（租户隔离）。 */
  customerId: string;
  /** 签发时间（ms epoch）。 */
  issuedAtMs: number;
  /** 过期时间（ms epoch），空前缀则视为永不过期（不安全，仅测试用）。 */
  expiresAtMs?: number;
  /** 期望的部署元数据，注册时用于校验是否对得上。 */
  expected?: {
    /** 期望的软件版本约束（语义化前缀，如 "3.2"）。 */
    versionSatisfies?: string;
    /** 期望的部署类型（如 self-hosted / compute-nest）。 */
    kind?: string;
  };
}

/** 注册校验上下文 —— 校验签名/token 所需的全部证据。 */
export interface RegistrationVerificationInput {
  tokenPayload: BootstrapTokenPayload;
  /** 签名者提供的公钥（本次注册新生成并持久化）。 */
  publicKeyHex: string;
  /** 部署方对 bootstrap nonce 的签名（证明持有对应私钥）。 */
  nonceSignatureHex: string;
  /** 部署上报的软件版本。 */
  claimedVersion: string;
  /** 部署上报的类型。 */
  claimedKind?: string;
  /** 现网打卡观察到的系统时钟（ms epoch），用于 token 过期判断。 */
  nowMs: number;
  /**
   * 签名验证：能否用给定公钥验证 signed 是对 message 的有效签名。
   * 未提供时视为签名不可验证（拒绝，fail closed）。
   */
  verifySignature?: (givenPublicKey: string, signed: string, message: string) => boolean;
}

/** 注册校验结果（纯函数）。 */
export type RegistrationVerdict =
  | { ok: true; deploymentId: string; orderId: string; customerId: string }
  | { ok: false; reason: RegRejectReason };

export type RegRejectReason =
  | 'token_replayed'
  | 'token_expired'
  | 'signature_invalid'
  | 'version_mismatch'
  | 'kind_mismatch'
  | 'deployment_exists'
  | 'customer_mismatch';

/** 部署身份派生指纹 —— 取代 getMachineFingerprint 的可变拼接。 */
export interface DeploymentIdentity {
  /** 派生指纹：由部署公钥派生（替换 hostname/platform/arch 拼接）。 */
  fingerprint: string;
  /** 验证公钥（十六进制），服务端持久化，用于验签与后续授权。 */
  publicKeyHex: string;
  /** 指纹派生算法版本，便于后续平滑迁移。 */
  version: 1;
}

/** 持久化的已注册部署记录。 */
export interface RegisteredDeployment {
  deploymentId: string;
  customerId: string;
  orderId: string;
  state: RegState;
  /** 注册时绑定并持久化的公钥（十六进制）。 */
  publicKeyHex: string;
  /** 派生指纹（公钥派生）。 */
  fingerprint: string;
  /** 指纹派生算法版本。 */
  identityVersion: 1;
  /** 注册时间（ms epoch）。 */
  registeredAtMs: number;
  /** 本次注册消耗的 bootstrap 凭据 nonce（用于防重放）。 */
  consumedNonce: string;
  /**
   * 传统机器指纹是否仍在使用（迁移期标识）。
   * CONTROL-10 要求新部署不再采集可变拼接；存量部署迁移时置 true 表示待整改。
   */
  legacyMachineFingerprintInUse: boolean;
}

/** 注册所需的签名能力（服务端密钥库提供）。 */
export interface RegistrationSigning {
  /** 生成并持久化一份实例密钥对，返回其验证公钥。 */
  createInstanceIdentity(): DeploymentIdentity;
  /** 使用已持久化的实例私钥对给定消息签名，返回十六进制签名。 */
  signInstance(message: string): string;
  /** 校验签名是否由对应公钥产生。 */
  verify(pub: string, signed: string, message: string): boolean;
}
