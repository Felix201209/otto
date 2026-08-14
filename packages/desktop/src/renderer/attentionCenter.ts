/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 统一提醒中心状态模型。
 *
 * 职责：
 *   1. 把企业私信未读（enterpriseUnreadCounts）、会话未读（unreadSessions）、
 *      园区/报修工单未读组合成统一的 AttentionItem 列表。
 *   2. 提供按 kind/severity 聚合的 AttentionSummary，供 UI 各入口消费。
 *   3. 不落库，纯前端派生状态。
 *
 * MVP 范围：
 *   - 企业私信（direct-message）：来自 enterpriseUnreadCounts
 *   - A2A 协作（atoa）：来自 enterpriseUnreadCounts 中 source='atoa' 的条目
 *   - 园区工单（park-ticket）：来自外部传入的工单未读摘要
 *   - 系统（system）：来自 unreadSessions 中非企业/园区的会话未读
 */

export type AttentionKind =
  | 'direct-message'
  | 'atoa'
  | 'park-ticket'
  | 'system';

export type AttentionSeverity = 'normal' | 'important' | 'urgent';

export interface AttentionItem {
  id: string;
  sessionId: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  title: string;
  preview: string;
  count: number;
  createdAt: string;
  target:
    | { type: 'inbox'; accountId?: string }
    | { type: 'organization'; accountId?: string; departmentId?: string }
    | { type: 'park-ticket'; ticketId?: string }
    | { type: 'chat'; sessionId: string };
}

export interface AttentionSummary {
  /** 所有未读项的总数（按 count 字段求和）。 */
  totalCount: number;
  /** 按 kind 分组的未读数。 */
  byKind: Record<AttentionKind, number>;
  /** 按 severity 分组的未读数。 */
  bySeverity: Record<AttentionSeverity, number>;
  /** 展开的未读项列表（按 createdAt 倒序）。 */
  items: AttentionItem[];
}

export interface ParkTicketUnreadSummary {
  /** 待处理工单数（assignedTasks 中未读的）。 */
  actionableCount: number;
  /** 创建者视角有更新的工单数。 */
  creatorUpdateCount: number;
  /** 最新一条工单的时间戳（用于排序）。 */
  latestTimestamp: string;
  /** 最新一条工单的标题摘要。 */
  latestPreview: string;
}

const EMPTY_SUMMARY: AttentionSummary = {
  totalCount: 0,
  byKind: { 'direct-message': 0, 'atoa': 0, 'park-ticket': 0, 'system': 0 },
  bySeverity: { normal: 0, important: 0, urgent: 0 },
  items: [],
};

function isEnterpriseInboxSession(sessionId: string): boolean {
  return sessionId.startsWith('enterprise:message:') ||
    sessionId.startsWith('enterprise:federation:');
}

function enterpriseInboxIdentity(sessionId: string): string {
  if (sessionId.startsWith('enterprise:federation:')) {
    return sessionId.slice('enterprise:federation:'.length);
  }
  return sessionId.slice('enterprise:message:'.length);
}

/**
 * 把企业未读计数（enterpriseUnreadCounts）和会话未读（unreadSessions）
 * 与园区工单未读摘要合并成统一提醒视图。
 *
 * @param enterpriseUnreadCounts 企业私信/A2A 未读计数（key 为 sessionId）。
 * @param unreadSessions 桌面通知服务持有的未读会话 ID 列表。
 * @param parkTicketSummary 园区工单未读摘要（可选，无数据时传 null）。
 * @param enterpriseNotifications 企业未读通知列表（可选，用于填充 preview/title）。
 */
export function computeAttentionSummary(params: {
  enterpriseUnreadCounts?: Record<string, number>;
  unreadSessions?: string[];
  parkTicketSummary?: ParkTicketUnreadSummary | null;
  enterpriseNotifications?: ReadonlyArray<{
    senderAccountId: string;
    senderName: string;
    preview: string;
    createdAt: string;
  }>;
}): AttentionSummary {
  const {
    enterpriseUnreadCounts = {},
    unreadSessions = [],
    parkTicketSummary = null,
    enterpriseNotifications = [],
  } = params;

  const items: AttentionItem[] = [];
  const byKind: Record<AttentionKind, number> = {
    'direct-message': 0,
    'atoa': 0,
    'park-ticket': 0,
    'system': 0,
  };
  const bySeverity: Record<AttentionSeverity, number> = {
    normal: 0,
    important: 0,
    urgent: 0,
  };

  // 按 senderAccountId 索引企业通知（用于填充 preview）
  const notificationBySender = new Map(
    enterpriseNotifications.map((n) => [n.senderAccountId, n]),
  );

  // 收集已由企业未读计数覆盖的 sessionId
  const coveredSessionIds = new Set<string>();

  // —— 企业私信 + A2A ——
  const ATOA_REQUEST_PREFIX = 'OTTO_ATOA_REQUEST ';
  const ATOA_RESPONSE_PREFIX = 'OTTO_ATOA_RESPONSE ';

  for (const [sessionId, count] of Object.entries(enterpriseUnreadCounts)) {
    if (count <= 0) continue;
    if (!isEnterpriseInboxSession(sessionId)) continue;
    coveredSessionIds.add(sessionId);

    const accountId = enterpriseInboxIdentity(sessionId);
    const notification = notificationBySender.get(accountId);
    const preview = notification?.preview ?? '';
    const isAtoa =
      preview.startsWith(ATOA_REQUEST_PREFIX) ||
      preview.startsWith(ATOA_RESPONSE_PREFIX);
    const kind: AttentionKind = isAtoa ? 'atoa' : 'direct-message';
    const severity: AttentionSeverity = isAtoa ? 'important' : 'normal';

    items.push({
      id: `enterprise:${accountId}`,
      sessionId,
      kind,
      severity,
      title: notification?.senderName ?? accountId,
      preview: isAtoa
        ? (preview.startsWith(ATOA_REQUEST_PREFIX)
          ? '对方正在请求你的 Otto 协作'
          : '对方 Otto 已回复你的企业协作请求')
        : preview.slice(0, 140),
      count,
      createdAt: notification?.createdAt ?? new Date().toISOString(),
      target: { type: 'inbox', accountId },
    });

    byKind[kind] += count;
    bySeverity[severity] += count;
  }

  // —— 园区工单 ——
  if (parkTicketSummary && (parkTicketSummary.actionableCount > 0 || parkTicketSummary.creatorUpdateCount > 0)) {
    const parkCount = parkTicketSummary.actionableCount + parkTicketSummary.creatorUpdateCount;
    items.push({
      id: 'park-ticket-summary',
      sessionId: 'park:service',
      kind: 'park-ticket',
      severity: parkTicketSummary.actionableCount > 0 ? 'important' : 'normal',
      title: '园区服务',
      preview: parkTicketSummary.latestPreview || '有新的工单动态',
      count: parkCount,
      createdAt: parkTicketSummary.latestTimestamp || new Date().toISOString(),
      target: { type: 'park-ticket' },
    });
    byKind['park-ticket'] += parkCount;
    bySeverity[parkTicketSummary.actionableCount > 0 ? 'important' : 'normal'] += parkCount;
  }

  // —— 系统级会话未读（未被企业/园区覆盖的） ——
  for (const sessionId of unreadSessions) {
    if (coveredSessionIds.has(sessionId)) continue;
    if (sessionId.startsWith('enterprise:') || sessionId.startsWith('park:')) continue;

    items.push({
      id: `system:${sessionId}`,
      sessionId,
      kind: 'system',
      severity: 'normal',
      title: 'Otto 对话',
      preview: '有未读的对话消息',
      count: 1,
      createdAt: new Date().toISOString(),
      target: { type: 'chat', sessionId },
    });
    byKind['system'] += 1;
    bySeverity['normal'] += 1;
  }

  // 按 createdAt 倒序排列
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const totalCount = Object.values(byKind).reduce((sum, c) => sum + c, 0);

  return { totalCount, byKind, bySeverity, items };
}

/**
 * 计算导航角标所需的精简计数：
 * - inboxUnread：我的消息（企业私信 + A2A）
 * - workUnread：我的工作（园区工单）
 * - globalUnread：全局未读总数
 */
export function computeNavBadgeCounts(
  enterpriseUnreadCounts?: Record<string, number>,
  parkTicketSummary?: ParkTicketUnreadSummary | null,
  unreadSessions?: string[],
): { inboxUnread: number; workUnread: number; globalUnread: number } {
  const inboxUnread = Object.entries(enterpriseUnreadCounts ?? {})
    .filter(([key, count]) => isEnterpriseInboxSession(key) && count > 0)
    .reduce((sum, [, count]) => sum + count, 0);

  const workUnread = parkTicketSummary
    ? parkTicketSummary.actionableCount + parkTicketSummary.creatorUpdateCount
    : 0;

  const enterpriseSessionIds = new Set(
    Object.keys(enterpriseUnreadCounts ?? {}),
  );
  const otherUnread = (unreadSessions ?? []).filter(
    (sid) => !enterpriseSessionIds.has(sid) && !sid.startsWith('park:'),
  ).length;

  const globalUnread = inboxUnread + workUnread + otherUnread;

  return { inboxUnread, workUnread, globalUnread };
}

/** 空摘要常量，避免组件中重复创建。 */
export { EMPTY_SUMMARY };
