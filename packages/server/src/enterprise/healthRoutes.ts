/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import type { ServerResponse } from 'node:http';

import * as db from './db.js';
import type { DeploymentInfo } from './server.js';

interface HealthRouteDeps {
  path: string;
  method: string;
  res: ServerResponse;
  apiVersion: number;
  capabilities: readonly string[];
  deploymentInfo: DeploymentInfo;
  smsConfigured: boolean;
  repairSmsConfigured: boolean;
  repairFeishuConfigured: boolean;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

export function handleHealthRoute({
  path,
  method,
  res,
  apiVersion,
  capabilities,
  deploymentInfo,
  smsConfigured,
  repairSmsConfigured,
  repairFeishuConfigured,
  sendJSON,
}: HealthRouteDeps): boolean {
  if (path !== '/enterprise/health' || method !== 'GET') {
    return false;
  }

  try {
    const readiness = db.getDatabaseReadiness();
    sendJSON(res, 200, {
      status: 'ok',
      service: 'otto-enterprise',
      apiVersion,
      version: deploymentInfo.version,
      // appVersion 作为旧调用方的可读别名保留；新版客户端使用 version。
      appVersion: deploymentInfo.version,
      buildCommit: deploymentInfo.buildCommit,
      schemaVersion: readiness.schemaVersion,
      capabilities: [...capabilities],
      uptime: process.uptime(),
      startedAt: deploymentInfo.startedAt,
      runtimeVersion: process.version,
      db: 'connected',
      sms: { configured: smsConfigured },
      repairNotifications: {
        sms: repairSmsConfigured,
        feishu: repairFeishuConfigured,
      },
      dataProtection: db.getDataProtectionStatus(),
      dataGovernance: db.getDataGovernanceProfile(null),
      deployment: {
        ...db.getPrivateDeploymentStatus(),
        moduleUpdates: db.getModuleUpdateManifest(),
        version: deploymentInfo.version,
        buildCommit: deploymentInfo.buildCommit,
        startedAt: deploymentInfo.startedAt,
      },
    });
  } catch {
    sendJSON(res, 503, {
      status: 'unavailable',
      service: 'otto-enterprise',
      apiVersion,
      version: deploymentInfo.version,
      appVersion: deploymentInfo.version,
      buildCommit: deploymentInfo.buildCommit,
      schemaVersion: null,
      capabilities: [...capabilities],
      db: 'unavailable',
      error: 'enterprise database unavailable',
    });
  }
  return true;
}
