/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { ServerResponse } from 'node:http';
import {
  FEATURE_FLAGS,
  type FeatureFlagManager,
} from 'otto-core';

type ConfigFeatureFlag = keyof typeof FEATURE_FLAGS;

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function isFeatureFlag(value: string): value is ConfigFeatureFlag {
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, value);
}

function featureList(featureFlags: FeatureFlagManager) {
  const current = featureFlags.getAll();
  return Object.entries(FEATURE_FLAGS).map(([key, label]) => ({
    key,
    label,
    enabled: current[key as ConfigFeatureFlag],
  }));
}

export function handleFeatureFlagsRoute(
  method: string,
  path: string,
  featureFlags: FeatureFlagManager,
  res: ServerResponse,
  userId: string,
): boolean {
  if (path === '/admin/features' && method === 'GET') {
    sendJSON(res, 200, {
      updatedBy: userId,
      features: featureList(featureFlags),
    });
    return true;
  }

  const match = path.match(/^\/admin\/features\/([^/]+)\/(enable|disable)$/);
  if (!match) return false;
  if (method !== 'POST') {
    sendJSON(res, 405, { error: 'method_not_allowed' });
    return true;
  }

  const [, key, action] = match;
  if (!isFeatureFlag(key)) {
    sendJSON(res, 404, { error: 'unknown_feature_flag' });
    return true;
  }

  featureFlags.setEnabled(key, action === 'enable');
  sendJSON(res, 200, {
    updatedBy: userId,
    feature: {
      key,
      label: FEATURE_FLAGS[key],
      enabled: featureFlags.isEnabled(key),
    },
  });
  return true;
}
