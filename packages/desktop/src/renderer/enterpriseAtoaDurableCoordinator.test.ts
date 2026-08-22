/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  EnterpriseAtoaResponseLedgerCommand,
  EnterpriseAtoaResponseLedgerRecord,
} from '../preload/index.js';
import { buildAtoaRequest } from './atoaProtocol.js';
import { processDurableEnterpriseAtoaRequest } from './enterpriseAtoaDurableCoordinator.js';
import type { EnterpriseAtoaResponseLedgerPort } from './enterpriseAtoaDurableResponse.js';

function memoryLedger(): EnterpriseAtoaResponseLedgerPort {
  let record: EnterpriseAtoaResponseLedgerRecord | null = null;
  return {
    async execute(command: EnterpriseAtoaResponseLedgerCommand) {
      if (command.action === 'load') return record;
      if (command.action === 'stage_generated') {
        record ??= {
          answer: command.answer,
          grantedSources: command.grantedSources,
          status: 'generated',
          attempts: 0,
          error: null,
        };
      } else if (!record) {
        throw new Error('missing record');
      } else if (command.action === 'mark_submitting') {
        record = {
          ...record,
          status: 'submitting',
          attempts: record.attempts + 1,
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

const request = {
  id: 'direct-message-1',
  senderAccountId: 'peer-1',
  recipientAccountId: 'me',
  peerAccountId: 'peer-1',
  peer: {
    id: 'peer-1',
    username: 'alice',
    name: 'Alice',
    department: '产品部',
    positionTitle: '产品经理',
    role: 'member',
  },
  content: buildAtoaRequest('请给出结论', 'request-1'),
  createdAt: '2026-08-22T00:00:00.000Z',
  readAt: null,
};

describe('durable same-server A2A coordinator', () => {
  it('reuses the persisted answer after submission failure without permission, context or model rerun', async () => {
    const ledger = memoryLedger();
    const requestPermission = vi.fn(async () => ({
      kind: 'allow' as const,
      sources: ['work_logs' as const],
    }));
    const collectContext = vi.fn(async () => ({
      context: '工作日志',
      loadedSources: ['work_logs' as const],
      failedSources: [],
    }));
    const askOtto = vi.fn(async () => '同一份模型答案');
    const failedSend = vi.fn(
      async (_peerAccountId: string, _content: string) => {
        throw new Error('connection lost');
      },
    );

    await expect(
      processDurableEnterpriseAtoaRequest({
        request,
        ledger,
        requestPermission,
        collectContext,
        askOtto,
        sendMessage: failedSend,
      }),
    ).rejects.toThrow('connection lost');

    const replaySend = vi.fn(
      async (_peerAccountId: string, _content: string) => undefined,
    );
    await expect(
      processDurableEnterpriseAtoaRequest({
        request,
        ledger,
        requestPermission,
        collectContext,
        askOtto,
        sendMessage: replaySend,
      }),
    ).resolves.toBe('answered');

    expect(requestPermission).toHaveBeenCalledOnce();
    expect(collectContext).toHaveBeenCalledOnce();
    expect(askOtto).toHaveBeenCalledOnce();
    expect(replaySend).toHaveBeenCalledOnce();
    expect(replaySend.mock.calls[0]?.[1]).toContain('同一份模型答案');
  });
});
