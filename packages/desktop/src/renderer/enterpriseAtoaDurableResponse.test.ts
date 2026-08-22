/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  EnterpriseAtoaResponseLedgerCommand,
  EnterpriseAtoaResponseLedgerRecord,
} from '../preload/index.js';
import {
  submitDurableEnterpriseAtoaResponse,
  type EnterpriseAtoaResponseLedgerPort,
} from './enterpriseAtoaDurableResponse.js';

const key = {
  scope: 'enterprise-direct-atoa-v1',
  contactId: 'peer-1',
  requestMessageId: 'message-1',
  requestMaterial: 'signed request content',
} as const;

function memoryLedger(): EnterpriseAtoaResponseLedgerPort & {
  commands: EnterpriseAtoaResponseLedgerCommand[];
} {
  let record: EnterpriseAtoaResponseLedgerRecord | null = null;
  const commands: EnterpriseAtoaResponseLedgerCommand[] = [];
  return {
    commands,
    async execute(command) {
      commands.push(command);
      if (command.action === 'load') return record;
      if (command.action === 'stage_generated') {
        record ??= {
          answer: command.answer,
          grantedSources: command.grantedSources,
          status: 'generated',
          attempts: 0,
          error: null,
        };
        return record;
      }
      if (!record) throw new Error('record missing');
      if (command.action === 'mark_submitting') {
        record = {
          ...record,
          status: 'submitting',
          attempts: record.attempts + 1,
          error: null,
        };
      } else if (command.action === 'mark_submission_failed') {
        record = { ...record, status: 'generated', error: command.error };
      } else {
        record = { ...record, status: 'submitted', error: null };
      }
      return record;
    },
  };
}

describe('durable enterprise A2A response submission', () => {
  it('persists the generated answer before the first network submission', async () => {
    const ledger = memoryLedger();
    const order: string[] = [];
    const originalExecute = ledger.execute.bind(ledger);
    ledger.execute = async (command) => {
      const result = await originalExecute(command);
      order.push(command.action);
      return result;
    };

    await submitDurableEnterpriseAtoaResponse({
      key,
      ledger,
      generate: vi.fn(async () => ({
        answer: '只生成一次的答案',
        grantedSources: ['work_logs' as const],
      })),
      submit: vi.fn(async () => {
        order.push('network_submit');
      }),
    });

    expect(order).toEqual([
      'load',
      'stage_generated',
      'mark_submitting',
      'network_submit',
      'mark_submitted',
    ]);
  });

  it('retries the exact persisted answer after a failed submit without regenerating', async () => {
    const ledger = memoryLedger();
    const generate = vi.fn(async () => ({
      answer: '原始付费模型答案',
      grantedSources: ['enterprise_knowledge' as const],
    }));
    const firstSubmit = vi.fn(async () => {
      throw new Error('response lost');
    });

    await expect(
      submitDurableEnterpriseAtoaResponse({
        key,
        ledger,
        generate,
        submit: firstSubmit,
      }),
    ).rejects.toThrow('response lost');

    const retrySubmit = vi.fn(async (response) => {
      expect(response).toEqual({
        answer: '原始付费模型答案',
        grantedSources: ['enterprise_knowledge'],
      });
    });
    const result = await submitDurableEnterpriseAtoaResponse({
      key,
      ledger,
      generate,
      submit: retrySubmit,
    });

    expect(generate).toHaveBeenCalledOnce();
    expect(firstSubmit).toHaveBeenCalledOnce();
    expect(retrySubmit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ outcome: 'submitted', reused: true });
  });

  it('does not resubmit or regenerate an already submitted answer', async () => {
    const ledger = memoryLedger();
    const generate = vi.fn(async () => ({
      answer: '答案',
      grantedSources: [],
    }));
    const submit = vi.fn(async () => undefined);
    await submitDurableEnterpriseAtoaResponse({
      key,
      ledger,
      generate,
      submit,
    });

    const result = await submitDurableEnterpriseAtoaResponse({
      key,
      ledger,
      generate,
      submit,
    });
    expect(result.outcome).toBe('already_submitted');
    expect(generate).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
  });

  it('persists a completed generation even if cancellation arrives before submit', async () => {
    const ledger = memoryLedger();
    const controller = new AbortController();
    const submit = vi.fn();
    const result = await submitDurableEnterpriseAtoaResponse({
      key,
      ledger,
      signal: controller.signal,
      generate: async () => {
        controller.abort();
        return { answer: '已付费生成的答案', grantedSources: [] };
      },
      submit,
    });

    expect(result.outcome).toBe('aborted');
    expect(submit).not.toHaveBeenCalled();
    expect(ledger.commands.map((command) => command.action)).toEqual([
      'load',
      'stage_generated',
    ]);
  });
});
