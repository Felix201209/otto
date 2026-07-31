/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { EnterpriseAtoaInboxMessage } from '../preload/index.js';
import type { AuthorizedAtoaContext } from './a2aContext.js';
import {
  buildAtoaResponse,
  parseAtoaMessage,
  type AtoaContextSource,
  type AtoaRequestPayload,
} from './atoaProtocol.js';

export interface AtoaPeerIdentity {
  id: string;
  username?: string;
  name: string;
  department?: string | null;
  positionTitle?: string | null;
  role?: string | null;
}
export type AtoaPermissionDecision =
  | { kind: 'deny' }
  | {
      kind: 'allow';
      sources: AtoaContextSource[];
      /** Exact locally decrypted private-chat messages authorized once. */
      messageIds?: string[];
    };

export type EnterpriseAtoaProcessingStatus =
  | 'ignored'
  | 'denied'
  | 'answered'
  | 'failed'
  | 'aborted';

export interface ProcessEnterpriseAtoaRequestInput {
  request: EnterpriseAtoaInboxMessage & { peer?: AtoaPeerIdentity };
  requestPermission(input: {
    peer: AtoaPeerIdentity;
    payload: AtoaRequestPayload;
  }): Promise<AtoaPermissionDecision>;
  collectContext(
    sources: AtoaContextSource[],
    authorizedMessageIds: string[],
  ): Promise<AuthorizedAtoaContext>;
  askOtto(input: {
    question: string;
    workContext: string;
    mode: 'answer' | 'consult';
    initiatorProposal?: string;
  }): Promise<string>;
  sendMessage(peerAccountId: string, content: string): Promise<unknown>;
  signal?: AbortSignal;
}

export async function processEnterpriseAtoaRequest(
  input: ProcessEnterpriseAtoaRequestInput,
): Promise<EnterpriseAtoaProcessingStatus> {
  const parsed = parseAtoaMessage(input.request.content);
  if (parsed?.kind !== 'request') return 'ignored';
  if (input.signal?.aborted) return 'aborted';

  const peer: AtoaPeerIdentity = input.request.peer ?? {
    id: input.request.peerAccountId,
    name: '企业同事',
  };
  const decision = await input.requestPermission({
    peer,
    payload: parsed.payload,
  });
  if (input.signal?.aborted) return 'aborted';

  if (decision.kind === 'deny') {
    await input.sendMessage(
      input.request.peerAccountId,
      buildAtoaResponse({
        requestId: input.request.id,
        question: parsed.payload.question,
        answer:
          '对方暂未授权其 Otto 读取资料或回答本次请求，请直接在员工私聊中联系本人。',
        mode: parsed.payload.mode,
        grantedSources: [],
      }),
    );
    return 'denied';
  }

  const context = await input.collectContext(
    decision.sources,
    decision.messageIds ?? [],
  );
  if (input.signal?.aborted) return 'aborted';

  let answer: string;
  let status: EnterpriseAtoaProcessingStatus = 'answered';
  try {
    answer = await input.askOtto({
      question: parsed.payload.question,
      workContext: context.context,
      mode: parsed.payload.mode,
      ...(parsed.payload.initiatorProposal
        ? { initiatorProposal: parsed.payload.initiatorProposal }
        : {}),
    });
  } catch {
    if (input.signal?.aborted) return 'aborted';
    answer =
      '对方 Otto 本次未能完成回答，请直接在员工私聊中联系本人或稍后重新发起。';
    status = 'failed';
  }

  await input.sendMessage(
    input.request.peerAccountId,
    buildAtoaResponse({
      requestId: input.request.id,
      question: parsed.payload.question,
      answer,
      mode: parsed.payload.mode,
      grantedSources: context.loadedSources,
    }),
  );
  return status;
}
