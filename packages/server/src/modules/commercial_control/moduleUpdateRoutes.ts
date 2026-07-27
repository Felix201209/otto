import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ModuleUpdateDescriptor,
  ModuleUpdateManifest,
  ModuleUpdateRollout,
} from './moduleUpdateManifest.js';

export interface ModuleUpdateRoutePrincipal {
  kind: 'system' | 'account';
  organizationId: string;
  account?: { id: string };
}

export interface ModuleUpdateRouteServices {
  getModuleUpdateManifest(): ModuleUpdateManifest;
  updateModuleUpdateDescriptor(input: {
    module: string;
    version?: string;
    rollout?: ModuleUpdateRollout;
    notes?: string;
    minAppVersion?: string | null;
    manifestUrl?: string | null;
    sha256?: string | null;
    publishedAt?: string | null;
    actorAccountId?: string | null;
    organizationId?: string;
  }): ModuleUpdateDescriptor;
  recordTelemetryEvent(input: {
    organizationId?: string | null;
    eventType: string;
    payload: Record<string, unknown>;
  }): void;
}

export interface ModuleUpdateRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  principal: ModuleUpdateRoutePrincipal | null;
  services: ModuleUpdateRouteServices;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

export async function handleModuleUpdateRoute({
  path,
  method,
  req,
  res,
  principal,
  services,
  readBody,
  sendJSON,
}: ModuleUpdateRouteDeps): Promise<boolean> {
  if ((path === '/enterprise/modules/updates' || path === '/enterprise/modules/updates/client')
    && method === 'GET') {
    sendJSON(res, 200, services.getModuleUpdateManifest());
    return true;
  }

  if (path !== '/enterprise/modules/updates' || method !== 'PATCH') {
    return false;
  }

  const body = await readBody(req);
  try {
    const moduleUpdate = services.updateModuleUpdateDescriptor({
      module: typeof body.module === 'string' ? body.module : '',
      version: typeof body.version === 'string' ? body.version : undefined,
      rollout: typeof body.rollout === 'string'
        ? body.rollout as ModuleUpdateRollout
        : undefined,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      minAppVersion: typeof body.minAppVersion === 'string' ? body.minAppVersion : undefined,
      manifestUrl: typeof body.manifestUrl === 'string' ? body.manifestUrl : undefined,
      sha256: typeof body.sha256 === 'string' ? body.sha256 : undefined,
      publishedAt: typeof body.publishedAt === 'string' ? body.publishedAt : undefined,
      actorAccountId: principal?.kind === 'account' ? principal.account?.id ?? null : null,
      organizationId: principal?.organizationId,
    });
    services.recordTelemetryEvent({
      organizationId: principal?.organizationId ?? null,
      eventType: 'module_update_published',
      payload: {
        module: moduleUpdate.module,
        version: moduleUpdate.version,
        rollout: moduleUpdate.rollout,
      },
    });
    sendJSON(res, 200, {
      moduleUpdate,
      manifest: services.getModuleUpdateManifest(),
    });
  } catch (error) {
    sendJSON(res, 400, { error: error instanceof Error ? error.message : 'module update failed' });
  }
  return true;
}
