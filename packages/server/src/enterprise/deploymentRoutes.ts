import type { IncomingMessage, ServerResponse } from 'node:http';
import * as db from './db.js';

export interface DeploymentRoutePrincipal {
  organizationId: string;
}

export interface DeploymentRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  principal: DeploymentRoutePrincipal | null;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

export async function handleDeploymentRoute({
  path,
  method,
  req,
  res,
  url,
  principal,
  readBody,
  sendJSON,
}: DeploymentRouteDeps): Promise<boolean> {
  if (path === '/enterprise/deployment/status' && method === 'GET') {
    sendJSON(res, 200, db.getPrivateDeploymentStatus());
    return true;
  }

  if (path === '/enterprise/deployment/license' && method === 'POST') {
    const body = await readBody(req);
    try {
      const license = db.importDeploymentLicense(body);
      db.recordTelemetryEvent({
        organizationId: principal?.organizationId ?? null,
        eventType: 'license_imported',
        payload: {
          licenseId: license.id,
          plan: license.plan,
          status: license.status,
          moduleCount: license.modules.length,
        },
      });
      sendJSON(res, 200, { license, deployment: db.getPrivateDeploymentStatus() });
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : 'license import failed' });
    }
    return true;
  }

  if (path === '/enterprise/deployment/telemetry' && method === 'PATCH') {
    const body = await readBody(req);
    const settings = db.updateTelemetrySettings({
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      contentMode: body.contentMode === 'diagnostic_redacted'
        ? 'diagnostic_redacted'
        : body.contentMode === 'operational_only' ? 'operational_only' : undefined,
      endpoint: typeof body.endpoint === 'string' ? body.endpoint : undefined,
    });
    sendJSON(res, 200, { telemetry: { ...settings, ...db.getTelemetryQueueSummary() } });
    return true;
  }

  if (path === '/enterprise/deployment/diagnostics' && method === 'GET') {
    sendJSON(res, 200, db.exportDeploymentDiagnostics({
      includeRedactedSamples: url.searchParams.get('includeRedactedSamples') === 'true',
    }));
    return true;
  }

  return false;
}
