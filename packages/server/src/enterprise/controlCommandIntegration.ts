/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Enterprise composition root for the Control command boundary. HTTP route
 * assembly receives only the typed boundary and never accesses the database
 * connection directly.
 */

import * as db from './db.js';
import {
  createControlCommandBoundary,
  type ControlCommandBoundary,
  type ControlCommandEnvelope,
  type ControlCommandRunResultShim,
} from '../modules/control_commands/index.js';

export function createEnterpriseControlCommandBoundary(input: {
  deploymentId: string;
  controlPublicKeys?: string[];
  signingPrivateKey?: string;
  execute(command: ControlCommandEnvelope): ControlCommandRunResultShim;
}): ControlCommandBoundary {
  return createControlCommandBoundary({
    db: () => db.getDB(),
    deploymentId: input.deploymentId,
    now: () => Date.now(),
    controlPublicKeys: input.controlPublicKeys,
    signingPrivateKey: input.signingPrivateKey,
    execute: input.execute,
  });
}
