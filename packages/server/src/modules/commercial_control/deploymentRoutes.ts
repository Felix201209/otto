import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  DeploymentLicenseView,
  DeploymentTelemetrySettings,
  PrivateDeploymentStatus,
} from './deploymentTypes.js';

export interface DeploymentRoutePrincipal {
  organizationId: string;
}

export interface DeploymentRouteServices {
  getPrivateDeploymentStatus(): PrivateDeploymentStatus;
  getDataProtectionStatus(): unknown;
  runDataProtectionBackup(
    reason?: 'scheduled' | 'manual' | 'startup',
  ): Promise<unknown>;
  importDeploymentLicense(raw: unknown): DeploymentLicenseView;
  importDeploymentLicenseLease(raw: unknown): DeploymentLicenseView;
  updateTelemetrySettings(
    patch: Partial<DeploymentTelemetrySettings>,
  ): DeploymentTelemetrySettings;
  getTelemetryQueueSummary(): {
    queued: number;
    failed: number;
    sent: number;
    lastQueuedAt: string | null;
  };
  flushTelemetryQueue(): Promise<{
    attempted: number;
    sent: number;
    discarded: number;
    failed: number;
    skippedReason: string | null;
  }>;
  ingestTelemetryBatch(
    raw: unknown,
    authorization: string | undefined,
  ): { accepted: number; duplicates: number };
  recordTelemetryEvent(input: {
    organizationId?: string | null;
    eventType: string;
    payload: Record<string, unknown>;
  }): void;
  exportDeploymentDiagnostics(input?: {
    includeRedactedSamples?: boolean;
  }): Record<string, unknown>;
}

export interface DeploymentRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  principal: DeploymentRoutePrincipal | null;
  services: DeploymentRouteServices;
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
  services,
  readBody,
  sendJSON,
}: DeploymentRouteDeps): Promise<boolean> {
  if (path === '/enterprise/deployment/status' && method === 'GET') {
    sendJSON(res, 200, {
      ...services.getPrivateDeploymentStatus(),
      dataProtection: services.getDataProtectionStatus(),
    });
    return true;
  }

  if (path === '/enterprise/deployment/data-protection' && method === 'GET') {
    sendJSON(res, 200, services.getDataProtectionStatus());
    return true;
  }

  if (path === '/enterprise/deployment/data-protection/backup' && method === 'POST') {
    const status = await services.runDataProtectionBackup('manual');
    sendJSON(res, 200, status);
    return true;
  }

  if (path === '/enterprise/deployment/license' && method === 'POST') {
    const body = await readBody(req);
    try {
      const license = services.importDeploymentLicense(body);
      services.recordTelemetryEvent({
        organizationId: principal?.organizationId ?? null,
        eventType: 'license_imported',
        payload: {
          licenseId: license.id,
          plan: license.plan,
          status: license.status,
          moduleCount: license.modules.length,
        },
      });
      sendJSON(res, 200, {
        license,
        deployment: services.getPrivateDeploymentStatus(),
      });
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : 'license import failed' });
    }
    return true;
  }

  if (path === '/enterprise/deployment/license/lease' && method === 'POST') {
    const body = await readBody(req);
    try {
      const license = services.importDeploymentLicenseLease(body);
      sendJSON(res, 200, { license });
    } catch (error) {
      sendJSON(res, 400, {
        error:
          error instanceof Error
            ? error.message
            : 'license lease import failed',
      });
    }
    return true;
  }

  if (path === '/enterprise/deployment/telemetry' && method === 'PATCH') {
    const body = await readBody(req);
    const settings = services.updateTelemetrySettings({
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      contentMode: body.contentMode === 'diagnostic_redacted'
        ? 'diagnostic_redacted'
        : body.contentMode === 'operational_only' ? 'operational_only' : undefined,
      endpoint: typeof body.endpoint === 'string' ? body.endpoint : undefined,
    });
    sendJSON(res, 200, {
      telemetry: { ...settings, ...services.getTelemetryQueueSummary() },
    });
    return true;
  }

  if (path === '/enterprise/deployment/telemetry/flush' && method === 'POST') {
    sendJSON(res, 200, { result: await services.flushTelemetryQueue() });
    return true;
  }

  if (path === '/enterprise/deployment/telemetry/ingest' && method === 'POST') {
    const body = await readBody(req);
    try {
      const receipt = services.ingestTelemetryBatch(
        body,
        typeof req.headers.authorization === 'string'
          ? req.headers.authorization
          : undefined,
      );
      sendJSON(res, 202, receipt);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const status = message.includes('not configured') ? 404 :
        message.includes('authorization') ? 401 : 400;
      sendJSON(res, status, { error: message || 'telemetry ingest failed' });
    }
    return true;
  }

  if (path === '/enterprise/deployment/diagnostics' && method === 'GET') {
    sendJSON(res, 200, services.exportDeploymentDiagnostics({
      includeRedactedSamples: url.searchParams.get('includeRedactedSamples') === 'true',
    }));
    return true;
  }

  return false;
}
