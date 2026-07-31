/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DiagConsoleLogger, DiagLogLevel, diag } from '@opentelemetry/api';
import type { Config } from '../config/config.js';
import { SERVICE_NAME } from './constants.js';

// For troubleshooting, set the log level to DiagLogLevel.DEBUG
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

let sdk: { start: () => Promise<void> | void; shutdown: () => Promise<void> | void } | undefined;
let telemetryInitialized = false;

export function isTelemetrySdkInitialized(): boolean {
  return telemetryInitialized;
}

function parseGrpcEndpoint(
  otlpEndpointSetting: string | undefined,
): string | undefined {
  if (!otlpEndpointSetting) {
    return undefined;
  }
  // Trim leading/trailing quotes that might come from env variables
  const trimmedEndpoint = otlpEndpointSetting.replace(/^["']|["']$/g, '');

  try {
    const url = new URL(trimmedEndpoint);
    // OTLP gRPC exporters expect an endpoint in the format scheme://host:port
    // The `origin` property provides this, stripping any path, query, or hash.
    return url.origin;
  } catch (error) {
    diag.error('Invalid OTLP endpoint URL provided:', trimmedEndpoint, error);
    return undefined;
  }
}

export function initializeTelemetry(config: Config): void {
  if (telemetryInitialized) {
    return;
  }

  const telemetryEnabled = config.getTelemetryEnabled();
  const otlpEndpoint = parseGrpcEndpoint(config.getTelemetryOtlpEndpoint());

  if (telemetryEnabled && otlpEndpoint) {
    void initializeOtlpTelemetry(config, otlpEndpoint);
  }

  telemetryInitialized = true;
}

async function initializeOtlpTelemetry(
  config: Config,
  otlpEndpoint: string,
): Promise<void> {
  try {
    const [
      { OTLPTraceExporter },
      { OTLPLogExporter },
      { OTLPMetricExporter },
      { NodeSDK },
      { SemanticResourceAttributes },
      { Resource },
      { BatchLogRecordProcessor },
      { PeriodicExportingMetricReader },
      { HttpInstrumentation },
    ] = await Promise.all([
      import('@opentelemetry/exporter-trace-otlp-grpc'),
      import('@opentelemetry/exporter-logs-otlp-grpc'),
      import('@opentelemetry/exporter-metrics-otlp-grpc'),
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/semantic-conventions'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/sdk-logs'),
      import('@opentelemetry/sdk-metrics'),
      import('@opentelemetry/instrumentation-http'),
    ]);

    const metricReader = new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${otlpEndpoint}/v1/metrics`,
      }),
    });
    sdk = new NodeSDK({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
        'session.id': config.getSessionId(),
      }),
      traceExporter: new OTLPTraceExporter({
        url: `${otlpEndpoint}/v1/traces`,
      }),
      metricReader: metricReader as never,
      logRecordProcessor: new BatchLogRecordProcessor(
        new OTLPLogExporter({
          url: `${otlpEndpoint}/v1/logs`,
        }),
      ),
      instrumentations: [new HttpInstrumentation()],
    });

    sdk.start();
    console.log('OpenTelemetry SDK initialized successfully.');
  } catch (error) {
    console.error('Failed to start OpenTelemetry SDK:', error);
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (!telemetryInitialized || !sdk) {
    return;
  }
  try {
    await sdk.shutdown();
    console.log('OpenTelemetry SDK shut down successfully.');
  } catch (error) {
    console.error('Error shutting down SDK:', error);
  } finally {
    telemetryInitialized = false;
  }
}
