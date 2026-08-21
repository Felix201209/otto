/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import type { ServerResponse } from 'node:http';

import * as db from './db.js';
import type { DeploymentInfo } from './server.js';
import type { PrivateDeploymentReadiness } from '../modules/deployment_lifecycle/index.js';

interface HealthRouteDeps {
  path: string;
  method: string;
  res: ServerResponse;
  apiVersion: number;
  capabilities: readonly string[];
  deploymentInfo: DeploymentInfo;
  readiness(): PrivateDeploymentReadiness;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

export function handleHealthRoute({
  path,
  method,
  res,
  apiVersion,
  capabilities,
  deploymentInfo,
  readiness,
  sendJSON,
}: HealthRouteDeps): boolean {
  if (path !== '/enterprise/health' || method !== 'GET') {
    return false;
  }

  try {
    db.getDatabaseReadiness();
    sendJSON(res, 200, {
      status: 'ok',
      service: 'otto-enterprise',
      apiVersion,
      version: deploymentInfo.version,
      // appVersion remains as a compatibility alias. Detailed build and storage
      // diagnostics are available only from authenticated deployment routes.
      appVersion: deploymentInfo.version,
      capabilities: [...capabilities],
      readiness: readiness(),
    });
  } catch {
    sendJSON(res, 503, {
      status: 'unavailable',
      service: 'otto-enterprise',
      apiVersion,
      version: deploymentInfo.version,
      appVersion: deploymentInfo.version,
      capabilities: [...capabilities],
      readiness: readiness(),
      error: 'enterprise database unavailable',
    });
  }
  return true;
}
