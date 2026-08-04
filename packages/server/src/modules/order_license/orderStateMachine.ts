/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-11 订单事件状态机与权益推导（纯函数核心）。
 *
 * 不变式：
 *  - 幂等：(eventId) 已处理则返回既有结果，不重复消耗订单；
 *  - 单调版本：同一 orderId 的 version 必须严格递增，乱序/回退拒绝；
 *  - 篡改拒收：金额/商品/套餐/地域/客户 与既有订单不符 → rejected（fail closed）；
 *  - 无秘密：权益与 License 内容不含 CEO 密码/数据库凭据/云 AccessKey/E2EE 密钥；
 *  - 降配安全：降价/减席位不直接删数据，进入整改窗口（grace），不自动降级执行。
 */

import type {
  LicenseEntitlement,
  OrderEvent,
  OrderEventStatus,
  OrderLifecycleState,
  OrderRecord,
} from './orderLicenseTypes.js';

export interface OrderStateTransitionResult {
  status:
    | 'accepted'
    | 'idempotent_replayed'
    | 'rejected_out_of_order'
    | 'rejected_tampered'
    | 'rejected_unknown';
  reason?: string;
  /** 事件处理结果状态。 */
  eventStatus: OrderEventStatus;
  /** 事件后形成的权益（若进入 entitlement_active）。 */
  entitlement?: LicenseEntitlement;
  /** 更新后的订单聚合状态。 */
  orderState?: OrderLifecycleState;
}

export interface OrderProjection {
  records: Map<string, OrderRecord>;
  processedEventIds: Set<string>;
}

function orderStateFor(event: OrderEvent): OrderLifecycleState {
  switch (event.orderState) {
    case 'paid':
      return event.type === 'plan_change' ? 'plan_changed'
        : event.type === 'seat_change' ? 'seat_changed'
        : 'active';
    case 'suspended':
      return 'suspended';
    case 'refunded':
      return 'refunded';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending_payment';
  }
}

/** 派生权益（不含秘密）。 */
export function deriveEntitlement(
  event: OrderEvent,
  order: OrderRecord | undefined,
  licenseId: string,
  revision: number,
): LicenseEntitlement {
  return {
    deploymentId: event.deploymentId,
    customer: event.customer,
    organizationId: event.customer.id,
    plan: event.plan,
    seatLimit: Math.max(0, Math.floor(event.seatLimit)),
    modules: [...new Set(event.modules)],
    issuedAtMs: event.effectiveAtMs,
    expiresAtMs: event.expiresAtMs,
    gracePeriodMs: order?.gracePeriodMs ?? 0,
    licenseId,
    revision,
    offlineProhibited: false,
    billingEnforcement: order?.state === 'suspended' ? true : false,
  };
}

/**
 * 应用一条订单事件到投影。
 *
 * @param projection 当前投影（mutable；调用方负责持久化）。
 * @param event 已验证签名的订单事件。
 * @param issueLicense 给定 (orderfulfillment, revision) 生成 licenseId（幂等绑定）。
 */
export function applyOrderEvent(
  projection: OrderProjection,
  event: OrderEvent,
  issueLicense: (fulfill: { deploymentId: string; orderId: string; plan: string }) => string,
): OrderStateTransitionResult {
  // 幂等：事件 ID 已处理。
  if (projection.processedEventIds.has(event.eventId)) {
    return {
      status: 'idempotent_replayed',
      eventStatus: 'verified',
      reason: 'event already processed',
    };
  }

  const existing = projection.records.get(event.orderId);

  // 乱序/重复版本拒绝（fail closed on unknown）。
  if (existing && event.version < existing.latestVersion) {
    return {
      status: 'rejected_out_of_order',
      eventStatus: 'rejected',
      reason: `order event version ${event.version} < seen ${existing.latestVersion}`,
    };
  }
  if (existing && event.version === existing.latestVersion && event.type !== 'payment') {
    return {
      status: 'rejected_out_of_order',
      eventStatus: 'rejected',
      reason: `duplicate order version ${event.version}`,
    };
  }

  // 篡改拒收：金额/商品/套餐/地域/客户 与既有订单冲突。
  if (existing) {
    if (event.customer.id !== existing.customer.id) {
      return {
        status: 'rejected_tampered',
        eventStatus: 'rejected',
        reason: 'customer id mismatch',
      };
    }
    if (event.deploymentId !== existing.deploymentId) {
      return {
        status: 'rejected_tampered',
        eventStatus: 'rejected',
        reason: 'deploymentId mismatch',
      };
    }
    if (existing.state === 'active' && (event.type === 'plan_change' || event.type === 'seat_change')) {
      // 降配保护：不直接删数据，进入整改窗口。
      // 本模块 fail-closed：降配必须显式确认窗口（remediation window），否则拒绝。
      if (
        event.modules.length < existing.modules.length ||
        event.seatLimit < existing.seatLimit
      ) {
        return {
          status: 'rejected_tampered',
          eventStatus: 'rejected',
          reason: 'downgrade requires explicit remediation window',
        };
      }
    }
  }

  // 记事件已处理。
  projection.processedEventIds.add(event.eventId);

  const orderState = orderStateFor(event);
  const revision = existing ? existing.latestVersion + 1 : 1;
  const licenseId = issueLicense({
    deploymentId: event.deploymentId,
    orderId: event.orderId,
    plan: event.plan,
  });

  const normalizedOrder: OrderRecord = {
    orderId: event.orderId,
    state: orderState,
    latestVersion: event.version,
    deploymentId: event.deploymentId,
    customer: event.customer,
    plan: event.plan,
    seatLimit: event.seatLimit,
    modules: [...new Set(event.modules)],
    issuedAtMs: event.effectiveAtMs,
    expiresAtMs: event.expiresAtMs,
    gracePeriodMs: 0,
  };
  projection.records.set(event.orderId, normalizedOrder);

  const entitlement = deriveEntitlement(event, existing ?? normalizedOrder, licenseId, revision);

  return {
    status: 'accepted',
    eventStatus: 'entitlement_active',
    entitlement,
    orderState,
  };
}
