/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

export type AtoaContextSource =
  | 'current_chat'
  | 'enterprise_knowledge'
  | 'work_logs'
  | 'schedules';

export interface AtoaRequestPayload {
  v: 1;
  id: string;
  question: string;
  createdAt: string;
  mode: 'answer' | 'consult';
  requestedSources: AtoaContextSource[];
  initiatorProposal?: string;
}

export interface FederationAtoaApprovedDecision {
  v: 1;
  status: 'approved';
  requestId: string;
  requestMessageId: string;
  grantId: string;
  scope: string;
  expiresAt: string;
  grantedSources: AtoaContextSource[];
  createdAt: string;
}

type FederationAtoaDecision = FederationAtoaApprovedDecision | {
  v: 1;
  status: 'denied';
  requestId: string;
  requestMessageId: string;
  createdAt: string;
};

const REQUEST_PREFIX = 'OTTO_ATOA_REQUEST ';
const RESPONSE_PREFIX = 'OTTO_ATOA_RESPONSE ';
const DECISION_PREFIX = 'OTTO_FEDERATION_ATOA_DECISION ';
const SOURCES: readonly AtoaContextSource[] = [
  'current_chat',
  'enterprise_knowledge',
  'work_logs',
  'schedules',
];
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,200}$/u;
const SCOPE = /^[A-Za-z0-9._:-]{1,160}$/u;

export function federationAtoaScope(
  requestMessageId: string,
  content: string,
): string {
  const digest = createHash('sha256')
    .update(requestMessageId, 'utf8')
    .update('\n', 'utf8')
    .update(content, 'utf8')
    .digest('hex');
  return `otto.a2a.${digest}`;
}

export function deterministicFederationAtoaMessageId(
  kind: 'request' | 'response',
  seed: string,
): string {
  return `fa2a_${kind}_${createHash('sha256')
    .update(seed, 'utf8')
    .digest('hex')
    .slice(0, 40)}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isoDate(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value));
}

function sourceList(value: unknown): AtoaContextSource[] | null {
  if (
    !Array.isArray(value) || value.length > SOURCES.length ||
    value.some((source) =>
      typeof source !== 'string' ||
      !SOURCES.includes(source as AtoaContextSource))
  ) {
    return null;
  }
  return SOURCES.filter((source) => value.includes(source));
}

export function parseAtoaRequest(content: string): AtoaRequestPayload | null {
  if (!content.startsWith(REQUEST_PREFIX)) return null;
  try {
    const raw = JSON.parse(content.slice(REQUEST_PREFIX.length)) as unknown;
    if (!record(raw)) return null;
    const mode = raw.mode === undefined ? 'answer' : raw.mode;
    const requestedSources = raw.requestedSources === undefined
      ? []
      : sourceList(raw.requestedSources);
    if (
      raw.v !== 1 ||
      typeof raw.id !== 'string' || !IDENTIFIER.test(raw.id) ||
      typeof raw.question !== 'string' || !raw.question.trim() ||
      raw.question.length > 1200 ||
      !isoDate(raw.createdAt) ||
      (mode !== 'answer' && mode !== 'consult') ||
      !requestedSources ||
      (raw.initiatorProposal !== undefined &&
        (mode !== 'consult' ||
          typeof raw.initiatorProposal !== 'string' ||
          !raw.initiatorProposal.trim() ||
          raw.initiatorProposal.length > 4000))
    ) {
      return null;
    }
    return {
      v: 1,
      id: raw.id,
      question: raw.question,
      createdAt: raw.createdAt,
      mode,
      requestedSources,
      ...(typeof raw.initiatorProposal === 'string'
        ? { initiatorProposal: raw.initiatorProposal }
        : {}),
    };
  } catch {
    return null;
  }
}

export function buildAtoaResponse(input: {
  requestId: string;
  question: string;
  answer: string;
  mode: 'answer' | 'consult';
  grantedSources: AtoaContextSource[];
}): string {
  const fixed = {
    v: 1 as const,
    requestId: input.requestId.slice(0, 200),
    question: input.question.trim().slice(0, 1200),
    createdAt: new Date().toISOString(),
    mode: input.mode,
    grantedSources: SOURCES.filter((source) =>
      input.grantedSources.includes(source)),
  };
  let answer = input.answer.trim().slice(0, 2400);
  let content = RESPONSE_PREFIX + JSON.stringify({ ...fixed, answer });
  while (Buffer.byteLength(content, 'utf8') > 4000 && answer.length > 1) {
    answer = answer.slice(0, Math.floor(answer.length * 0.9));
    content = RESPONSE_PREFIX + JSON.stringify({ ...fixed, answer });
  }
  if (!answer || Buffer.byteLength(content, 'utf8') > 4000) {
    throw new Error('A2A 回复超过消息长度限制');
  }
  return content;
}

export function buildFederationAtoaDecision(
  input:
    | Omit<FederationAtoaApprovedDecision, 'v' | 'createdAt'>
    | {
        status: 'denied';
        requestId: string;
        requestMessageId: string;
      },
): string {
  const payload: FederationAtoaDecision = input.status === 'approved'
    ? {
        v: 1,
        ...input,
        grantedSources: SOURCES.filter((source) =>
          input.grantedSources.includes(source)),
        createdAt: new Date().toISOString(),
      }
    : {
        v: 1,
        ...input,
        createdAt: new Date().toISOString(),
      };
  return DECISION_PREFIX + JSON.stringify(payload);
}

export function parseFederationAtoaDecision(
  content: string,
): FederationAtoaDecision | null {
  if (!content.startsWith(DECISION_PREFIX)) return null;
  try {
    const raw = JSON.parse(content.slice(DECISION_PREFIX.length)) as unknown;
    if (
      !record(raw) || raw.v !== 1 ||
      typeof raw.requestId !== 'string' || !IDENTIFIER.test(raw.requestId) ||
      typeof raw.requestMessageId !== 'string' ||
      !IDENTIFIER.test(raw.requestMessageId) ||
      !isoDate(raw.createdAt)
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
    const grantedSources = sourceList(raw.grantedSources);
    if (
      raw.status !== 'approved' ||
      typeof raw.grantId !== 'string' || !IDENTIFIER.test(raw.grantId) ||
      typeof raw.scope !== 'string' || !SCOPE.test(raw.scope) ||
      !isoDate(raw.expiresAt) ||
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
