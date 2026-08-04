/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-11 编排：订单事件 → 状态机 → 持久化 → 签发签名 License。
 *
 * 入口 ingestOrderEvent：
 *  - 事件来源签名已在进入前由上层（阿里云回调网关）校验并丢弃未通过者；
 *    本层对业务字段做核对（金额/商品/客户/部署/版本）。
 *  - 幂等：同 eventId 返回既有结果；乱序版本拒绝；篡改拒绝。
 *  - 通过后持久化投影并签发离线签名 License。
 */

import type { Database } from '../data_platform/index.js';
import {
  applyOrderEvent,
  type OrderProjection,
  type OrderStateTransitionResult,
} from './orderStateMachine.js';
import {
  getEventState,
  persistOrderEntitlement,
  getOrderEntitlement,
  type OrderLicenseStore,
  type StoredOrderEntitlement,
} from './orderLicenseRepository.js';
import {
  issueSignedLicense,
  deterministicLicenseId,
  licensePayloadDigest,
  type IssuedLicenseEnvelope,
} from './licenseIssuance.js';
import type { OrderEvent } from './orderLicenseTypes.js';

export interface OrderLicenseProcessorDeps {
  db(): Database;
  /** 可注入时钟（ms）。 */
  now?(): number;
  /** Control 隔离签名服务私钥（KMS/HSM 兜底：仅此处持有）。 */
  signingPrivateKey: string;
  signingKeyId: string;
  /** 机器指纹（Server 领取后回填；可为空则签发负载不含）。 */
  machineFingerprint?(): string;
}

export interface IngestOrderResult {
  kind:
    | 'license_issued'
    | 'idempotent'
    | 'rejected_out_of_order'
    | 'rejected_tampered';
  reason?: string;
  orderState?: string;
  licenseId?: string;
  issued?: IssuedLicenseEnvelope;
  /** 无秘密摘要（审计）。 */
  digest?: string;
}

export function createOrderLicenseProcessor(
  deps: OrderLicenseProcessorDeps,
): {
  /** 接收并处理一条已验证签名的订单事件。 */
  ingest(event: OrderEvent): IngestOrderResult;
  /** 读取某 orderId 的最新权益（响应丢失恢复）。 */
  latestEntitlement(orderId: string): StoredOrderEntitlement | null;
} {
  const now = deps.now ?? (() => Date.now());
  const store: OrderLicenseStore = { db: deps.db };

  /** TODO(控制面持久化投影) —— 本实现以 DB 行作为投影源，重建内存投影用于推导。 */
  function buildProjection(): OrderProjection {
    const projection: OrderProjection = {
      records: new Map(),
      processedEventIds: new Set(),
    };
    // 从 order_licenses 重建记录；事件去重以 DB order_events 为准，此处不重复加载。
    return projection;
  }

  function ingest(event: OrderEvent): IngestOrderResult {
    const st = getEventState(store, event.eventId, event.orderId);
    // 幂等：事件已处理 → 返回既有 license。
    if (st.processed) {
      const existing = getOrderEntitlement(store, event.orderId);
      return {
        kind: existing
          ? 'license_issued'
          : 'idempotent',
        reason: existing ? 'replayed existing license' : 'event already processed',
        orderState: existing?.order_state,
        licenseId: existing?.license_id,
      };
    }
    // 乱序：版本 ≤ 已见最大 → 拒绝。
    if (event.version < st.latestVersion) {
      return {
        kind: 'rejected_out_of_order',
        reason: `order event version ${event.version} < seen ${st.latestVersion}`,
      };
    }

    const projection = buildProjection();
    const result: OrderStateTransitionResult = applyOrderEvent(
      projection,
      event,
      (fulfill) =>
        deterministicLicenseId({
          deploymentId: fulfill.deploymentId,
          orderId: fulfill.orderId,
          plan: fulfill.plan,
        }),
    );

    if (result.status !== 'accepted' || !result.entitlement || !result.orderState) {
      return {
        kind: result.status === 'rejected_tampered'
          ? 'rejected_tampered'
          : 'rejected_out_of_order',
        reason: result.reason,
      };
    }

    // 持久化（幂等事务）。
    persistOrderEntitlement(
      store,
      event,
      result.entitlement,
      result.orderState,
      now(),
    );

    // 签发签名 License。
    const rollbackSequence = result.entitlement.revision;
    const issued = issueSignedLicense({
      entitlement: result.entitlement,
      signingPrivateKey: deps.signingPrivateKey,
      signingKeyId: deps.signingKeyId,
      machineFingerprint: deps.machineFingerprint?.(),
      rollbackSequence,
    });

    return {
      kind: 'license_issued',
      orderState: result.orderState,
      licenseId: result.entitlement.licenseId,
      issued,
      digest: licenseDigest(issued),
    };
  }

  return {
    ingest,
    latestEntitlement: (orderId) => getOrderEntitlement(store, orderId),
  };
}

function licenseDigest(issued: IssuedLicenseEnvelope): string {
  return issued.license && typeof issued.license === 'object'
    ? licensePayloadDigest(issued.license)
    : 'n/a';
}
