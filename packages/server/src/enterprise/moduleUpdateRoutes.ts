import type { IncomingMessage, ServerResponse } from 'node:http';
import * as db from './db.js';

export interface ModuleUpdateRoutePrincipal {
  kind: 'system' | 'account';
  organizationId: string;
  account?: { id: string };
}

export interface ModuleUpdateRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  principal: ModuleUpdateRoutePrincipal | null;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

export async function handleModuleUpdateRoute({
  path,
  method,
  req,
  res,
  principal,
  readBody,
  sendJSON,
}: ModuleUpdateRouteDeps): Promise<boolean> {
  if (path === '/enterprise/modules/updates' && method === 'GET') {
    sendJSON(res, 200, db.getModuleUpdateManifest());
    return true;
  }

  if (path !== '/enterprise/modules/updates' || method !== 'PATCH') {
    return false;
  }

  const body = await readBody(req);
  try {
    const moduleUpdate = db.updateModuleUpdateDescriptor({
      module: typeof body.module === 'string' ? body.module : '',
      version: typeof body.version === 'string' ? body.version : undefined,
      rollout: typeof body.rollout === 'string'
        ? body.rollout as db.ModuleUpdateRollout
        : undefined,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      minAppVersion: typeof body.minAppVersion === 'string' ? body.minAppVersion : undefined,
      manifestUrl: typeof body.manifestUrl === 'string' ? body.manifestUrl : undefined,
      sha256: typeof body.sha256 === 'string' ? body.sha256 : undefined,
      publishedAt: typeof body.publishedAt === 'string' ? body.publishedAt : undefined,
      actorAccountId: principal?.kind === 'account' ? principal.account?.id ?? null : null,
      organizationId: principal?.organizationId,
    });
    db.recordTelemetryEvent({
      organizationId: principal?.organizationId ?? null,
      eventType: 'module_update_published',
      payload: {
        module: moduleUpdate.module,
        version: moduleUpdate.version,
        rollout: moduleUpdate.rollout,
      },
    });
    sendJSON(res, 200, { moduleUpdate, manifest: db.getModuleUpdateManifest() });
  } catch (error) {
    sendJSON(res, 400, { error: error instanceof Error ? error.message : 'module update failed' });
  }
  return true;
}
