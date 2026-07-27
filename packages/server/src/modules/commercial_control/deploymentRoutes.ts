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
  importDeploymentLicense(raw: unknown): DeploymentLicenseView;
  updateTelemetrySettings(
    patch: Partial<DeploymentTelemetrySettings>,
  ): DeploymentTelemetrySettings;
  getTelemetryQueueSummary(): {
    queued: number;
    failed: number;
    sent: number;
    lastQueuedAt: string | null;
  };
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
    sendJSON(res, 200, services.getPrivateDeploymentStatus());
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

  if (path === '/enterprise/deployment/diagnostics' && method === 'GET') {
    sendJSON(res, 200, services.exportDeploymentDiagnostics({
      includeRedactedSamples: url.searchParams.get('includeRedactedSamples') === 'true',
    }));
    return true;
  }

  return false;
}
