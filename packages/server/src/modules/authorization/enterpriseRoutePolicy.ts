/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

/** 需要管理员令牌的路由（读/写全公司数据或改员工状态）。 */
const ADMIN_ROUTES = new Set([
  '/enterprise/invite',
  '/enterprise/offboard',
  '/enterprise/export',
  '/enterprise/audit',
  '/enterprise/employees',
  '/enterprise/report',
  '/enterprise/accounts',
  '/enterprise/organization/invite',
  '/enterprise/park',
  '/enterprise/park/manage',
  '/enterprise/park/invite',
  '/enterprise/park/join',
  '/enterprise/park/profile',
  '/enterprise/park/tenants',
  '/enterprise/park-statistics',
  '/enterprise/park/statistics',
  '/enterprise/park/specialists',
  '/enterprise/park/services',
  '/enterprise/park/services/assign',
  '/enterprise/park-services/push',
  '/enterprise/park-services/announcement-results',
  '/enterprise/park-services/survey-results',
  '/enterprise/park-settings',
  '/enterprise/park-meeting-rooms',
  '/enterprise/park-meeting-slots',
  '/enterprise/usage/summary',
  '/enterprise/deployment/status',
  '/enterprise/deployment/license',
  '/enterprise/deployment/license/lease',
  '/enterprise/deployment/telemetry',
  '/enterprise/deployment/telemetry/flush',
  '/enterprise/deployment/data-protection',
  '/enterprise/deployment/data-protection/backup',
  '/enterprise/deployment/diagnostics',
  '/enterprise/modules/updates',
  '/enterprise/organizations',
]);

/** 会读取或写入企业内部数据的成员路由，必须使用账号会话。 */
const MEMBER_ROUTES = new Set([
  '/enterprise/onboard',
  '/enterprise/task',
  '/enterprise/recall',
  '/enterprise/knowledge',
  '/enterprise/skills',
  '/enterprise/credits/balance',
  '/enterprise/credits/redeem',
  '/enterprise/credits/redeem-codes',
  '/enterprise/credits/topup',
  '/enterprise/credits/transactions',
  '/enterprise/organization/view',
  '/enterprise/organization/features',
  '/enterprise/presence/heartbeat',
  '/enterprise/organization/sync',
  '/enterprise/park/view',
  '/enterprise/messages/unread',
  '/enterprise/auth/join-organization',
  '/enterprise/park-resources',
  '/enterprise/park-statistics/inbox',
  '/enterprise/park/services/request',
  '/enterprise/modules/updates/client',
  '/enterprise/deployment/update-policy',
  '/enterprise/account-sync',
  '/enterprise/privacy',
  '/enterprise/privacy/accept',
  '/enterprise/privacy/export',
  '/enterprise/privacy/account',
]);

export const FEATURE_ADMIN_PREFIX = '/admin/features';

export function isAdminRoute(path: string): boolean {
  return (
    ADMIN_ROUTES.has(path) ||
    path.startsWith('/enterprise/accounts/') ||
    path.startsWith('/enterprise/organization/departments') ||
    path.startsWith('/enterprise/organization/positions') ||
    path.startsWith('/enterprise/park-meeting-rooms/') ||
    path.startsWith('/enterprise/platform/organizations/') ||
    path.startsWith('/enterprise/federation/admin/')
  );
}

export function isMemberRoute(path: string): boolean {
  return (
    MEMBER_ROUTES.has(path) ||
    path.startsWith('/enterprise/skills/') ||
    path.startsWith('/enterprise/knowledge/') ||
    path === '/enterprise/atoa/inbox' ||
    path.startsWith('/enterprise/e2ee/') ||
    path.startsWith('/enterprise/messages/') ||
    path.startsWith('/enterprise/message-attachments/') ||
    (path.startsWith('/enterprise/federation/') &&
      !path.startsWith('/enterprise/federation/admin/')) ||
    path.startsWith('/enterprise/park-statistics/') ||
    (path.startsWith('/enterprise/credits/redeem-codes/') &&
      path.endsWith('/revoke'))
  );
}

export function isPublicSimpleParkRoute(
  path: string,
  method: string,
  url: URL,
): boolean {
  return (
    (path === '/enterprise/park/join' && method === 'POST') ||
    (path === '/enterprise/park/services' &&
      method === 'GET' &&
      url.searchParams.has('parkId'))
  );
}

export function isLicenseMaintenanceRoute(path: string): boolean {
  return (
    path === '/enterprise/health' ||
    path === '/enterprise/export' ||
    path === '/enterprise/deployment/status' ||
    path === '/enterprise/deployment/license' ||
    path === '/enterprise/deployment/license/lease' ||
    path === '/enterprise/deployment/telemetry' ||
    path === '/enterprise/deployment/telemetry/flush' ||
    path === '/enterprise/deployment/data-protection' ||
    path === '/enterprise/deployment/data-protection/backup' ||
    path === '/enterprise/deployment/diagnostics' ||
    path === '/enterprise/account-sync' ||
    path === '/enterprise/privacy' ||
    path === '/enterprise/privacy/accept' ||
    path === '/enterprise/privacy/export' ||
    path === '/enterprise/privacy/account' ||
    path.startsWith('/enterprise/auth/')
  );
}
