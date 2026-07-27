import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FeatureFlagManager } from 'otto-core';
import * as db from './db.js';
import { handleFeatureFlagsRoute } from './featureFlagsAdmin.js';
import { adminAccountsHTML } from './adminAccountsPage.js';
import { adminCreditsHTML } from './adminCreditsPage.js';
import { adminDashboardHTML } from './adminDashboardPage.js';
import { parkAdminHTML } from './parkAdminPage.js';
import { platformAdminHTML } from './platformAdminPage.js';
import { handleAdminDataRoute } from './adminDataRoutes.js';
import { handleAdminPageRoute } from './adminPageRoutes.js';
import { handleAccountRoute } from './accountRoutes.js';
import {
  handleAuthRoute,
  type AuthRouteLoginRateLimiter,
  type AuthRouteSmsSender,
} from './authRoutes.js';
import { handleCommunicationRoute } from './communicationRoutes.js';
import { handleCreditsRoute } from './creditsRoutes.js';
import {
  handleDeploymentRoute,
  handleModuleUpdateRoute,
} from '../modules/commercial_control/index.js';
import { handleOrganizationRoute } from '../modules/identity_organization/index.js';
import { handleGeneralizedParkRoute } from './generalizedParkRoutes.js';
import { handleHealthRoute } from './healthRoutes.js';
import { handleLocalAgentRoute } from './localAgentRoutes.js';
import { handleMemberWorkflowRoute } from './memberWorkflowRoutes.js';
import { handleParkResourceRoute } from './parkResourceRoutes.js';
import { handleParkServicePublicationRoute } from './parkServicePublicationRoutes.js';
import { handleParkStatisticsRoute } from './parkStatisticsRoutes.js';
import { handlePlatformOrganizationRoute } from './platformOrganizationRoutes.js';
import { handleSimpleParkCompatibilityRoute } from './simpleParkCompatibilityRoutes.js';
import { handleTicketRoute } from './ticketRoutes.js';
import { handleWorkspaceRoute } from './workspaceRoutes.js';
import type { RepairNotificationSender } from './repairNotifications.js';

export type AdminPrincipal =
  | { kind: 'system'; organizationId: string }
  | { kind: 'account'; organizationId: string; account: db.AccountView };

export interface EnterpriseRouteDeploymentInfo {
  version: string;
  buildCommit: string;
  startedAt: string;
}

export interface EnterpriseRouteDispatcherDeps {
  path: string;
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  adminPrincipal: AdminPrincipal | null;
  memberAccount: db.AccountView | null;
  publicBaseUrl: string;
  smsSender: AuthRouteSmsSender | null;
  repairSmsSender: RepairNotificationSender | null;
  repairFeishuSender: RepairNotificationSender | null;
  loginRateLimiter: AuthRouteLoginRateLimiter;
  deploymentInfo: EnterpriseRouteDeploymentInfo;
  apiVersion: number;
  capabilities: readonly string[];
  atoaClaims: Map<string, number>;
  atoaClaimTtlMs: number;
  isPublicSimplePark: boolean;
  featureFlags?: FeatureFlagManager;
  readBody(req: IncomingMessage, maxLength?: number): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
  extractToken(req: IncomingMessage): string;
}

export async function dispatchEnterpriseRoute({
  path,
  method,
  url,
  req,
  res,
  adminPrincipal,
  memberAccount,
  publicBaseUrl,
  smsSender,
  repairSmsSender,
  repairFeishuSender,
  loginRateLimiter,
  deploymentInfo,
  apiVersion,
  capabilities,
  atoaClaims,
  atoaClaimTtlMs,
  isPublicSimplePark,
  featureFlags,
  readBody,
  sendJSON,
  extractToken,
}: EnterpriseRouteDispatcherDeps): Promise<boolean> {
  if (
    handleHealthRoute({
      path,
      method,
      res,
      apiVersion,
      capabilities,
      deploymentInfo,
      smsConfigured: smsSender !== null,
      repairSmsConfigured: repairSmsSender !== null,
      repairFeishuConfigured: repairFeishuSender !== null,
      sendJSON,
    })
  ) {
    return true;
  }

  if (
    await handleModuleUpdateRoute({
      path,
      method,
      req,
      res,
      principal: adminPrincipal,
      services: db,
      readBody,
      sendJSON,
    })
  ) {
    return true;
  }

  if (
    await handleDeploymentRoute({
      path,
      method,
      req,
      res,
      url,
      principal: adminPrincipal,
      services: db,
      readBody,
      sendJSON,
    })
  ) {
    return true;
  }

  if (
    await handleLocalAgentRoute({ path, method, req, res, readBody, sendJSON })
  ) {
    return true;
  }

  if (
    await handleAuthRoute({
      path,
      method,
      req,
      res,
      memberAccount,
      publicBaseUrl,
      smsSender,
      loginRateLimiter,
      readBody,
      sendJSON,
      extractToken,
    })
  ) {
    return true;
  }

  if (
    await handleOrganizationRoute({
      path,
      method,
      req,
      res,
      memberAccount,
      adminPrincipal,
      services: db,
      readBody,
      sendJSON,
    })
  ) {
    return true;
  }

  if (
    await handleSimpleParkCompatibilityRoute({
      path,
      method,
      req,
      res,
      url,
      adminPrincipal,
      isPublicSimplePark,
      readBody,
      sendJSON,
      extractToken,
    })
  ) {
    return true;
  }

  if (
    await handleGeneralizedParkRoute({
      path,
      method,
      req,
      res,
      memberAccount,
      adminPrincipal,
      readBody,
      sendJSON,
    })
  ) {
    return true;
  }

  if (
    await handleAccountRoute({
      path,
      method,
      req,
      res,
      adminPrincipal,
      readBody,
      sendJSON,
    })
  ) {
    return true;
  }

  if (
    await handleParkResourceRoute({
      path,
      method,
      req,
      res,
      url,
      memberAccount,
      adminPrincipal,
      readBody,
      sendJSON,
    })
  ) {
    return true;
  }

  if (
    await handleParkServicePublicationRoute({
      path,
      method,
      req,
      res,
      adminPrincipal,
      readBody,
      sendJSON,
      extractToken,
    })
  ) {
    return true;
  }

  if (
    await handleWorkspaceRoute({
      path,
      method,
      req,
      res,
      url,
      adminPrincipal,
      publicBaseUrl,
      readBody,
      sendJSON,
      extractToken,
    })
  ) {
    return true;
  }

  if (
    await handlePlatformOrganizationRoute({
      path,
      method,
      req,
      res,
      adminPrincipal,
      publicBaseUrl,
      readBody,
      sendJSON,
    })
  ) {
    return true;
  }

  if (
    await handleTicketRoute({
      path,
      method,
      req,
      res,
      repairSmsSender,
      repairFeishuSender,
      extractToken,
      readBody,
      sendJSON,
    })
  ) {
    return true;
  }

  if (
    await handleParkStatisticsRoute({
      path,
      method,
      req,
      res,
      memberAccount,
      adminPrincipal,
      readBody,
      sendJSON,
    })
  ) {
    return true;
  }

  if (
    await handleCreditsRoute({
      path,
      method,
      req,
      res,
      url,
      memberAccount,
      readBody,
      sendJSON,
    })
  ) {
    return true;
  }

  if (
    await handleMemberWorkflowRoute({
      path,
      method,
      req,
      res,
      url,
      memberAccount,
      adminPrincipal,
      readBody,
      sendJSON,
    })
  ) {
    return true;
  }

  if (
    handleAdminDataRoute({
      path,
      method,
      res,
      url,
      adminPrincipal,
      sendJSON,
    })
  ) {
    return true;
  }

  if (
    await handleCommunicationRoute({
      path,
      method,
      url,
      req,
      res,
      memberAccount: memberAccount!,
      atoaClaims,
      atoaClaimTtlMs,
      readBody,
      sendJSON,
    })
  ) {
    return true;
  }

  if (
    handleAdminPageRoute(method, path, res, {
      adminAccountsHTML,
      parkAdminHTML,
      platformAdminHTML,
      adminDashboardHTML,
      adminCreditsHTML,
    })
  ) {
    return true;
  }

  if (path.startsWith('/admin/features') && featureFlags) {
    const userId = adminPrincipal
      ? adminPrincipal.kind === 'account'
        ? adminPrincipal.account.id
        : 'platform-admin'
      : 'unknown';
    if (handleFeatureFlagsRoute(method, path, featureFlags, res, userId)) {
      return true;
    }
  }

  return false;
}
