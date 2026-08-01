/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface PrivateDeploymentRuntimeServices {
  refreshDeploymentLicenseLease(): Promise<{
    refreshed: boolean;
    skippedReason: string | null;
    error: string | null;
  }>;
  flushTelemetryQueue(): Promise<{
    attempted: number;
    sent: number;
    discarded: number;
    failed: number;
    skippedReason: string | null;
  }>;
  flushBillingUsageQueue(): Promise<{
    attempted: number;
    sent: number;
    discarded: number;
    failed: number;
    skippedReason: string | null;
  }>;
  flushBillingAdmissionQueue(): Promise<{
    attempted: number;
    captured: number;
    released: number;
    discarded: number;
    failed: number;
    skippedReason: string | null;
  }>;
  recordTelemetryEvent(input: {
    eventType: string;
    payload: Record<string, unknown>;
  }): void;
  getPrivateDeploymentStatus(): {
    runtimeHealth: Record<string, unknown>;
    license: { status: string };
  };
}

export interface PrivateDeploymentRuntimeOptions {
  intervalMs?: number;
  healthIntervalMs?: number;
  initialDelayMs?: number;
  onError?: (error: unknown) => void;
}

/** Runs lease renewal and telemetry delivery without blocking customer traffic. */
export function startPrivateDeploymentRuntime(
  services: PrivateDeploymentRuntimeServices,
  options: PrivateDeploymentRuntimeOptions = {},
): () => void {
  const intervalMs = Math.max(10_000, options.intervalMs ?? 120_000);
  const healthIntervalMs = Math.max(
    intervalMs,
    options.healthIntervalMs ?? 15 * 60_000,
  );
  let nextHealthAt = Date.now();
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await services.refreshDeploymentLicenseLease();
      if (Date.now() >= nextHealthAt) {
        const status = services.getPrivateDeploymentStatus();
        services.recordTelemetryEvent({
          eventType: 'runtime_health',
          payload: {
            ...status.runtimeHealth,
            licenseStatus: status.license.status,
          },
        });
        nextHealthAt = Date.now() + healthIntervalMs;
      }
      await services.flushTelemetryQueue();
      await services.flushBillingAdmissionQueue();
      await services.flushBillingUsageQueue();
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };

  const initial = setTimeout(() => void tick(), options.initialDelayMs ?? 2_000);
  initial.unref();
  const interval = setInterval(() => void tick(), intervalMs);
  interval.unref();
  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
  };
}
