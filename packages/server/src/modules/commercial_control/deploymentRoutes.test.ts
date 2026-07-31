/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  handleDeploymentRoute,
  type DeploymentRouteServices,
} from './deploymentRoutes.js';

function routeInput(memberPrincipal: { organizationId: string } | null) {
  const resolveDeploymentUpdatePolicy = vi.fn(async () => ({
    status: 'not_configured' as const,
    reason: 'online_license_required' as const,
  }));
  const sendJSON = vi.fn();
  const readBody = vi.fn(async () => ({
    distributionId: 'otto-green',
    currentVersion: '1.9.10',
  }));
  return {
    resolveDeploymentUpdatePolicy,
    sendJSON,
    readBody,
    input: {
      path: '/enterprise/deployment/update-policy',
      method: 'POST',
      req: {} as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL('https://enterprise.example.test/enterprise/deployment/update-policy'),
      principal: null,
      memberPrincipal,
      services: { resolveDeploymentUpdatePolicy } as unknown as DeploymentRouteServices,
      readBody,
      sendJSON,
    },
  };
}

describe('deployment update policy route', () => {
  it('requires an authenticated enterprise member', async () => {
    const route = routeInput(null);
    await expect(handleDeploymentRoute(route.input)).resolves.toBe(true);
    expect(route.readBody).not.toHaveBeenCalled();
    expect(route.resolveDeploymentUpdatePolicy).not.toHaveBeenCalled();
    expect(route.sendJSON).toHaveBeenCalledWith(
      route.input.res,
      401,
      { error: 'member authentication required' },
    );
  });

  it('forwards only the requested distribution and current version', async () => {
    const route = routeInput({ organizationId: 'org_1' });
    await expect(handleDeploymentRoute(route.input)).resolves.toBe(true);
    expect(route.resolveDeploymentUpdatePolicy).toHaveBeenCalledWith({
      distributionId: 'otto-green',
      currentVersion: '1.9.10',
    });
    expect(route.sendJSON).toHaveBeenCalledWith(
      route.input.res,
      200,
      {
        status: 'not_configured',
        reason: 'online_license_required',
      },
    );
  });
});
