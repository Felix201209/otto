/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-11 订单驱动 License 签发 —— 类型与状态机。
 *
 * 目标：客户确认套餐并完成支付后，Control 根据可信订单自动生成授权权益；
 * 已注册 Server 主动领取并验证签名 License，不要求人工导入文件。
 *
 * 本模块实现 Control 侧的核心：订单事件状态机 → 权益模型 → 签发签名 License。
 * （Server 侧领取/验证/激活复用 commercial_control/deploymentRepository 的
 * importDeploymentLicense + getDeploymentLicense 与签名校验。）
 */

/** 订单事件来源（仅信任阿里云/计算巢服务端签名的事件）。 */
export type OrderEventSource = 'aliyun_computenest';

/**
 * 订单事件状态机（幂等键 = (eventId, orderId, version)）。
 * pending → verified → entitlement_active / rejected(金额/套餐/跨租户篡改)
 * entitlement_active 随后续事件流转。
 */
export type OrderEventStatus =
  | 'pending'          // 已接收，未核对
  | 'verified'         // 已核对签名与金额/商品/套餐/地域/客户/状态
  | 'entitlement_active'
  | 'rejected'         // 篡改/乱序/未知（fail closed）
  | 'failed';          // 处理异常

/** 订单事件负载（来自支付/订单回调）。 */
export interface OrderEvent {
  /** 事件 ID（幂等键之一）。 */
  eventId: string;
  /** 订单 ID。 */
  orderId: string;
  /** 订单版本（乱序拒绝）。 */
  version: number;
  /** 事件类型。 */
  type: 'payment' | 'refund' | 'cancel' | 'plan_change' | 'seat_change' | 'suspend' | 'resume';
  /** 客户主体。 */
  customer: {
    id: string;
    name: string;
  };
  /** 目标部署 ID。 */
  deploymentId: string;
  /** 套餐。 */
  plan: string;
  /** 商品 / 地域 / 状态。 */
  product: string;
  region: string;
  amountCents: number;
  currency: string;
  /** 权益参数。 */
  seatLimit: number;
  modules: string[];
  /** 生效/到期（ms）。 */
  effectiveAtMs: number;
  expiresAtMs: number;
  /** 订单状态。 */
  orderState: 'paid' | 'refunded' | 'cancelled' | 'pending' | 'suspended';
  /** Order 服务端签名（外部校验，进入本模块前已验）。 */
  sourceSignature?: string;
}

/** 权益模型（用于签发 License）。 */
export interface LicenseEntitlement {
  deploymentId: string;
  customer: { id: string; name: string };
  organizationId: string;
  plan: string;
  /** 席位/容量。 */
  seatLimit: number;
  modules: string[];
  issuedAtMs: number;
  expiresAtMs: number;
  /** 离线宽限（ms）。 */
  gracePeriodMs: number;
  /** 唯一 licenseId。 */
  licenseId: string;
  /** 版本（续费/升降配递增）。 */
  revision: number;
  offlineProhibited: boolean;
  billingEnforcement: boolean;
}

/** 订单状态（按 orderId 聚合，事件有序推进）。 */
export type OrderLifecycleState =
  | 'pending_payment'
  | 'active'                    // 已支付，权益有效
  | 'suspended'                 // 暂停（只读/停用，不删数据）
  | 'refunded'                  // 退款（吊销）
  | 'cancelled'
  | 'plan_changed'
  | 'seat_changed';

export interface OrderRecord {
  orderId: string;
  state: OrderLifecycleState;
  latestVersion: number;
  deploymentId: string;
  customer: { id: string; name: string };
  plan: string;
  seatLimit: number;
  modules: string[];
  issuedAtMs: number;
  expiresAtMs: number;
  gracePeriodMs: number;
}
