/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  PrivateDeploymentBootstrapCoordinator,
  PrivateDeploymentReadiness,
} from '../modules/deployment_lifecycle/index.js';

export interface PrivateDeploymentBootstrapRouteServices {
  prepare(): Promise<PrivateDeploymentReadiness>;
  readiness(): PrivateDeploymentReadiness;
}

export async function handlePrivateDeploymentBootstrapRoute(input: {
  path: string;
  method: string;
  res: ServerResponse;
  req: IncomingMessage;
  readBody(req: IncomingMessage, maxLength?: number): Promise<unknown>;
  services: Pick<PrivateDeploymentBootstrapCoordinator, 'prepare' | 'readiness'>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}): Promise<boolean> {
  if (input.path !== '/enterprise/bootstrap/prepare') return false;
  if (input.method !== 'POST') {
    input.sendJSON(input.res, 405, { error: 'method not allowed' });
    return true;
  }
  input.req.resume();
  const readiness = await input.services.prepare();
  // A blocked deployment is a valid readiness result. Keep the transport
  // successful so the desktop can explain the failed steps to the user.
  input.sendJSON(input.res, 200, {
    readiness,
  });
  return true;
}
