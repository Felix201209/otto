/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Server } from 'node:http';

import type { ClusteredEnterpriseServerOptions } from './clusteredServer.js';
import type { EnterpriseServerOptions } from './server.js';

/**
 * Selects the enterprise authority before importing either implementation.
 * This dynamic boundary is what prevents PostgreSQL mode from evaluating the
 * legacy SQLite singleton at module load time.
 */
export async function startConfiguredEnterpriseServer(
  options: EnterpriseServerOptions & ClusteredEnterpriseServerOptions = {},
): Promise<Server> {
  const backend =
    process.env.OTTO_ENTERPRISE_DATABASE_BACKEND?.trim().toLowerCase() ||
    'sqlite';
  if (backend === 'postgres' || backend === 'postgresql') {
    const { startClusteredEnterpriseServer } = await import(
      './clusteredServer.js'
    );
    return startClusteredEnterpriseServer(options);
  }
  if (backend !== 'sqlite') {
    throw new Error(
      'OTTO_ENTERPRISE_DATABASE_BACKEND must be sqlite or postgresql',
    );
  }
  const { startEnterpriseServer } = await import('./server.js');
  return startEnterpriseServer(options);
}
