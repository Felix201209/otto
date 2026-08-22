/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  hashEnterpriseAtoaRequest,
  type EnterpriseAtoaResponseLedger,
  type EnterpriseAtoaResponseRecord,
} from './enterprise-atoa-response-ledger.js';

type AtoaLedgerScope =
  'enterprise-direct-atoa-v1' | 'enterprise-federation-atoa-v1';

interface NormalizedLedgerCommand {
  action:
    | 'load'
    | 'stage_generated'
    | 'mark_submitting'
    | 'mark_submission_failed'
    | 'mark_submitted';
  scope: AtoaLedgerScope;
  contactId: string;
  requestMessageId: string;
  requestMaterial: string;
  answer?: string;
  grantedSources?: unknown;
  error?: string;
}

export interface EnterpriseAtoaLedgerIdentity {
  serverUrl: string;
  accountId: string;
}

export interface PublicEnterpriseAtoaResponseRecord {
  answer: string;
  grantedSources: EnterpriseAtoaResponseRecord['grantedSources'];
  status: EnterpriseAtoaResponseRecord['status'];
  attempts: number;
  error: string | null;
}

function requiredText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function normalizeCommand(value: unknown): NormalizedLedgerCommand {
  if (!value || typeof value !== 'object') {
    throw new Error('A2A 回复账本请求无效');
  }
  const candidate = value as Record<string, unknown>;
  const key = candidate.key as Record<string, unknown> | null;
  const actions = new Set([
    'load',
    'stage_generated',
    'mark_submitting',
    'mark_submission_failed',
    'mark_submitted',
  ]);
  const scopes = new Set<AtoaLedgerScope>([
    'enterprise-direct-atoa-v1',
    'enterprise-federation-atoa-v1',
  ]);
  const action = requiredText(candidate.action, 40);
  const scope = requiredText(key?.scope, 64) as AtoaLedgerScope | null;
  const contactId = requiredText(key?.contactId, 300);
  const requestMessageId = requiredText(key?.requestMessageId, 300);
  const requestMaterial =
    typeof key?.requestMaterial === 'string' &&
    key.requestMaterial.length > 0 &&
    key.requestMaterial.length <= 20_000
      ? key.requestMaterial
      : null;
  if (
    !action ||
    !actions.has(action) ||
    !scope ||
    !scopes.has(scope) ||
    !contactId ||
    !requestMessageId ||
    !requestMaterial
  ) {
    throw new Error('A2A 回复账本请求无效');
  }
  return {
    action: action as NormalizedLedgerCommand['action'],
    scope,
    contactId,
    requestMessageId,
    requestMaterial,
    ...(candidate.answer !== undefined
      ? { answer: candidate.answer as string }
      : {}),
    ...(candidate.grantedSources !== undefined
      ? { grantedSources: candidate.grantedSources }
      : {}),
    ...(candidate.error !== undefined
      ? { error: candidate.error as string }
      : {}),
  };
}

function publicRecord(
  record: EnterpriseAtoaResponseRecord | null,
): PublicEnterpriseAtoaResponseRecord | null {
  if (!record) return null;
  return {
    answer: record.answer,
    grantedSources: record.grantedSources,
    status: record.status,
    attempts: record.attempts,
    error: record.error,
  };
}

export function createEnterpriseAtoaResponseLedgerCommandHandler(options: {
  ledger: EnterpriseAtoaResponseLedger;
  identity(): EnterpriseAtoaLedgerIdentity | null;
  normalizeSources(
    value: unknown,
  ): EnterpriseAtoaResponseRecord['grantedSources'];
}): (value: unknown) => PublicEnterpriseAtoaResponseRecord | null {
  return (value) => {
    const command = normalizeCommand(value);
    const identity = options.identity();
    if (!identity?.serverUrl || !identity.accountId) {
      throw new Error('企业登录已失效，不能访问 A2A 回复账本');
    }
    const lookup = {
      ...identity,
      scope: command.scope,
      contactId: command.contactId,
      requestMessageId: command.requestMessageId,
      requestHash: hashEnterpriseAtoaRequest(command.requestMaterial),
    };
    if (command.action === 'load') {
      return publicRecord(options.ledger.load(lookup));
    }
    if (command.action === 'stage_generated') {
      const answer = requiredText(command.answer, 2_400);
      if (!answer) throw new Error('A2A 回复内容无效');
      return publicRecord(
        options.ledger.stageGenerated({
          ...lookup,
          answer,
          grantedSources: options.normalizeSources(command.grantedSources),
        }),
      );
    }
    if (command.action === 'mark_submitting') {
      return publicRecord(options.ledger.markSubmitting(lookup));
    }
    if (command.action === 'mark_submission_failed') {
      const error = requiredText(command.error, 1_000);
      if (!error) throw new Error('A2A 回复失败原因无效');
      return publicRecord(
        options.ledger.markSubmissionFailed({ ...lookup, error }),
      );
    }
    return publicRecord(options.ledger.markSubmitted(lookup));
  };
}
