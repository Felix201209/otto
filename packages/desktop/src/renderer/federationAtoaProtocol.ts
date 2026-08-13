/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { AtoaContextSource } from '../../../core/src/a2a/atoaProtocol.js';

export const FEDERATION_ATOA_DECISION_PREFIX = 'OTTO_FEDERATION_ATOA_DECISION ';

const ATOA_CONTEXT_SOURCES: readonly AtoaContextSource[] = [
  'current_chat',
  'enterprise_knowledge',
  'work_logs',
  'schedules',
];

interface FederationAtoaDecisionBase {
  v: 1;
  requestId: string;
  requestMessageId: string;
  createdAt: string;
}

export interface FederationAtoaApprovedDecision extends FederationAtoaDecisionBase {
  status: 'approved';
  grantId: string;
  scope: string;
  expiresAt: string;
  grantedSources: AtoaContextSource[];
}

export interface FederationAtoaDeniedDecision extends FederationAtoaDecisionBase {
  status: 'denied';
}

export type FederationAtoaDecision =
  FederationAtoaApprovedDecision | FederationAtoaDeniedDecision;

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,200}$/u;
const SCOPE = /^[A-Za-z0-9._:-]{1,160}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function sources(value: unknown): AtoaContextSource[] | null {
  if (
    !Array.isArray(value) ||
    value.length > ATOA_CONTEXT_SOURCES.length ||
    value.some(
      (item) =>
        typeof item !== 'string' ||
        !ATOA_CONTEXT_SOURCES.includes(item as AtoaContextSource),
    )
  ) {
    return null;
  }
  return ATOA_CONTEXT_SOURCES.filter((source) => value.includes(source));
}

export function buildFederationAtoaDecision(
  input:
    | (Omit<FederationAtoaApprovedDecision, 'v' | 'createdAt'> & {
        createdAt?: string;
      })
    | (Omit<FederationAtoaDeniedDecision, 'v' | 'createdAt'> & {
        createdAt?: string;
      }),
): string {
  const payload: FederationAtoaDecision =
    input.status === 'approved'
      ? {
          v: 1,
          status: 'approved',
          requestId: input.requestId,
          requestMessageId: input.requestMessageId,
          grantId: input.grantId,
          scope: input.scope,
          expiresAt: input.expiresAt,
          grantedSources: ATOA_CONTEXT_SOURCES.filter((source) =>
            input.grantedSources.includes(source),
          ),
          createdAt: input.createdAt ?? new Date().toISOString(),
        }
      : {
          v: 1,
          status: 'denied',
          requestId: input.requestId,
          requestMessageId: input.requestMessageId,
          createdAt: input.createdAt ?? new Date().toISOString(),
        };
  return FEDERATION_ATOA_DECISION_PREFIX + JSON.stringify(payload);
}

export function parseFederationAtoaDecision(
  content: string,
): FederationAtoaDecision | null {
  if (!content.startsWith(FEDERATION_ATOA_DECISION_PREFIX)) return null;
  try {
    const raw = JSON.parse(
      content.slice(FEDERATION_ATOA_DECISION_PREFIX.length),
    ) as unknown;
    if (
      !isRecord(raw) ||
      raw.v !== 1 ||
      typeof raw.requestId !== 'string' ||
      !IDENTIFIER.test(raw.requestId) ||
      typeof raw.requestMessageId !== 'string' ||
      !IDENTIFIER.test(raw.requestMessageId) ||
      !isIsoDate(raw.createdAt)
    ) {
      return null;
    }
    if (raw.status === 'denied') {
      return {
        v: 1,
        status: 'denied',
        requestId: raw.requestId,
        requestMessageId: raw.requestMessageId,
        createdAt: raw.createdAt,
      };
    }
    const grantedSources = sources(raw.grantedSources);
    if (
      raw.status !== 'approved' ||
      typeof raw.grantId !== 'string' ||
      !IDENTIFIER.test(raw.grantId) ||
      typeof raw.scope !== 'string' ||
      !SCOPE.test(raw.scope) ||
      !isIsoDate(raw.expiresAt) ||
      Date.parse(raw.expiresAt) <= Date.parse(raw.createdAt) ||
      !grantedSources
    ) {
      return null;
    }
    return {
      v: 1,
      status: 'approved',
      requestId: raw.requestId,
      requestMessageId: raw.requestMessageId,
      grantId: raw.grantId,
      scope: raw.scope,
      expiresAt: raw.expiresAt,
      grantedSources,
      createdAt: raw.createdAt,
    };
  } catch {
    return null;
  }
}

export function displayFederationAtoaDecision(
  decision: FederationAtoaDecision,
): string {
  if (decision.status === 'denied') {
    return '\u5bf9\u65b9\u62d2\u7edd\u4e86\u672c\u6b21 Otto \u534f\u4f5c\u8bf7\u6c42\uff0c\u672a\u8bfb\u53d6\u4efb\u4f55\u8d44\u6599\u3002';
  }
  return '\u5bf9\u65b9\u5df2\u6388\u6743\u672c\u6b21 Otto \u534f\u4f5c\uff0c\u6b63\u5728\u901a\u8fc7\u4e00\u6b21\u6027\u6388\u6743\u5904\u7406\u3002';
}
