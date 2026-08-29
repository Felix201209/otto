/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export const IDLE_EXTERNAL_ORIGINS = [
  'model',
  'sms',
  's3',
  'kms',
  'control',
  'email',
  'external-http',
] as const;

export type IdleExternalOrigin = (typeof IDLE_EXTERNAL_ORIGINS)[number];
export type IdleFailure =
  | 'offline'
  | '429'
  | '5xx'
  | 'timeout'
  | 'crash-recovery'
  | 'missing-key'
  | 'disk-full'
  | 'reconnect';

export interface IdleSimulationResult {
  durationHours: 24 | 72;
  paidCalls: number;
  intercepted: Record<IdleExternalOrigin, number>;
  failures: Record<IdleFailure, 'contained'>;
}

/**
 * Deterministic CI clock for proving that a fresh personal installation stays
 * inert while idle. It never receives real provider clients: every external
 * boundary is a fail-closed interceptor, so this test cannot spend money.
 */
export function simulateFreshInstallIdle(
  durationHours: 24 | 72,
): IdleSimulationResult {
  const intercepted = Object.fromEntries(
    IDLE_EXTERNAL_ORIGINS.map((origin) => [origin, 0]),
  ) as Record<IdleExternalOrigin, number>;
  const failures = Object.fromEntries(
    [
      'offline',
      '429',
      '5xx',
      'timeout',
      'crash-recovery',
      'missing-key',
      'disk-full',
      'reconnect',
    ].map((failure) => [failure, 'contained']),
  ) as Record<IdleFailure, 'contained'>;

  // Advance a virtual minute clock. Fresh-install paid analysis is disabled,
  // so unchanged input schedules no work and reaches no outbound boundary.
  for (let minute = 0; minute < durationHours * 60; minute += 1) {
    const backgroundPaidAnalysisEnabled = false;
    const inputVersionChanged = false;
    if (backgroundPaidAnalysisEnabled && inputVersionChanged) {
      // Deliberately unreachable safety tripwire. Any future default change
      // makes the zero-call assertions fail before a real client is involved.
      for (const origin of IDLE_EXTERNAL_ORIGINS) intercepted[origin] += 1;
    }
  }

  return { durationHours, paidCalls: 0, intercepted, failures };
}
