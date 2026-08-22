/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  processEnterpriseAtoaRequest,
  type ProcessEnterpriseAtoaRequestInput,
  type EnterpriseAtoaProcessingStatus,
} from './enterpriseAtoaCoordinator.js';
import { buildAtoaResponse, parseAtoaMessage } from './atoaProtocol.js';
import {
  submitDurableEnterpriseAtoaResponse,
  type EnterpriseAtoaResponseLedgerPort,
} from './enterpriseAtoaDurableResponse.js';

export async function processDurableEnterpriseAtoaRequest(
  input: ProcessEnterpriseAtoaRequestInput & {
    ledger: EnterpriseAtoaResponseLedgerPort;
  },
): Promise<EnterpriseAtoaProcessingStatus> {
  const request = parseAtoaMessage(input.request.content);
  if (request?.kind !== 'request') {
    return processEnterpriseAtoaRequest(input);
  }
  const key = {
    scope: 'enterprise-direct-atoa-v1',
    contactId: input.request.peerAccountId,
    requestMessageId: input.request.id,
    requestMaterial: input.request.content,
  } as const;
  const existing = await input.ledger.execute({ action: 'load', key });
  if (existing) {
    const replay = await submitDurableEnterpriseAtoaResponse({
      key,
      ledger: input.ledger,
      signal: input.signal,
      generate: async () => {
        throw new Error('Persisted A2A response must not be regenerated');
      },
      submit: (response) =>
        input.sendMessage(
          input.request.peerAccountId,
          buildAtoaResponse({
            requestId: input.request.id,
            question: request.payload.question,
            answer: response.answer,
            mode: request.payload.mode,
            grantedSources: response.grantedSources,
          }),
        ),
    });
    return replay.outcome === 'aborted' ? 'aborted' : 'answered';
  }

  return processEnterpriseAtoaRequest({
    ...input,
    sendMessage: async (peerAccountId, content) => {
      const response = parseAtoaMessage(content);
      if (response?.kind !== 'response') {
        throw new Error('A2A 协调器生成了无效回复');
      }
      const submitted = await submitDurableEnterpriseAtoaResponse({
        key,
        ledger: input.ledger,
        signal: input.signal,
        generate: async () => ({
          answer: response.payload.answer,
          grantedSources: response.payload.grantedSources,
        }),
        submit: (persisted) =>
          input.sendMessage(
            peerAccountId,
            buildAtoaResponse({
              requestId: input.request.id,
              question: request.payload.question,
              answer: persisted.answer,
              mode: request.payload.mode,
              grantedSources: persisted.grantedSources,
            }),
          ),
      });
      if (submitted.outcome === 'aborted') {
        throw new DOMException('A2A response submission aborted', 'AbortError');
      }
    },
  });
}
