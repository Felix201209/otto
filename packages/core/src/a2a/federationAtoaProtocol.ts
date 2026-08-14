/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  ATOA_CONTEXT_SOURCES,
  type AtoaContextSource,
} from './atoaProtocol.js';

export const FEDERATION_ATOA_DECISION_PREFIX =
  'OTTO_FEDERATION_ATOA_DECISION ';

interface FederationAtoaDecisionBase {
  v: 1;
  requestId: string;
  requestMessageId: string;
  createdAt: string;
}

export interface FederationAtoaApprovedDecision
  extends FederationAtoaDecisionBase {
  status: 'approved';
  grantId: string;
  scope: string;
  expiresAt: string;
  grantedSources: AtoaContextSource[];
}

export interface FederationAtoaDeniedDecision
  extends FederationAtoaDecisionBase {
  status: 'denied';
}

export type FederationAtoaDecision =
  | FederationAtoaApprovedDecision
  | FederationAtoaDeniedDecision;

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,200}$/u;
const SCOPE = /^[A-Za-z0-9._:-]{1,160}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value));
}

function sources(value: unknown): AtoaContextSource[] | null {
  if (
    !Array.isArray(value) ||
    value.length > ATOA_CONTEXT_SOURCES.length ||
    value.some((item) =>
      typeof item !== 'string' ||
      !ATOA_CONTEXT_SOURCES.includes(item as AtoaContextSource))
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
  const payload: FederationAtoaDecision = input.status === 'approved'
    ? {
        v: 1,
        status: 'approved',
        requestId: input.requestId,
        requestMessageId: input.requestMessageId,
        grantId: input.grantId,
        scope: input.scope,
        expiresAt: input.expiresAt,
        grantedSources: ATOA_CONTEXT_SOURCES.filter((source) =>
          input.grantedSources.includes(source)),
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
      !isRecord(raw) || raw.v !== 1 ||
      typeof raw.requestId !== 'string' || !IDENTIFIER.test(raw.requestId) ||
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
      typeof raw.grantId !== 'string' || !IDENTIFIER.test(raw.grantId) ||
      typeof raw.scope !== 'string' || !SCOPE.test(raw.scope) ||
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
    return '对方拒绝了本次 Otto 协作请求，未读取任何资料。';
  }
  return '对方已授权本次 Otto 协作，正在通过一次性授权处理。';
}
