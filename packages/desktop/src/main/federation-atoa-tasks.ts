/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  EnterpriseFederatedDirectMessage,
  EnterpriseFederationAtoaTask,
  EnterpriseFederationContact,
} from './enterprise-client.js';
import {
  deterministicFederationAtoaMessageId,
  federationAtoaScope,
  parseAtoaRequest,
  parseFederationAtoaDecision,
} from './federation-atoa-protocol.js';

export function deriveFederationAtoaTasks(input: {
  contact: EnterpriseFederationContact;
  messages: EnterpriseFederatedDirectMessage[];
  now?: number;
}): EnterpriseFederationAtoaTask[] {
  if (input.contact.trustState !== 'verified') return [];
  const now = input.now ?? Date.now();
  const tasks: EnterpriseFederationAtoaTask[] = [];
  const decisions = input.messages.flatMap((message) => {
    const decision = parseFederationAtoaDecision(message.content);
    return decision ? [{ message, decision }] : [];
  });

  for (const message of input.messages) {
    const request = parseAtoaRequest(message.content);
    if (
      message.direction === 'inbound' &&
      message.federationMessageType === 'chat.message' &&
      request &&
      !decisions.some(({ message: decisionMessage, decision }) =>
        decisionMessage.direction === 'outbound' &&
        decision.requestMessageId === message.id)
    ) {
      tasks.push({
        kind: 'proposal',
        contact: input.contact,
        message,
        request,
      });
    }

    const decision = parseFederationAtoaDecision(message.content);
    if (
      message.direction === 'inbound' &&
      message.federationMessageType === 'chat.message' &&
      decision?.status === 'approved' &&
      Date.parse(decision.expiresAt) > now
    ) {
      const proposal = input.messages.find((candidate) =>
        candidate.direction === 'outbound' &&
        candidate.id === decision.requestMessageId &&
        candidate.federationMessageType === 'chat.message');
      const proposalRequest = proposal
        ? parseAtoaRequest(proposal.content)
        : null;
      const dispatchedId = deterministicFederationAtoaMessageId(
        'request',
        `${decision.grantId}:${decision.requestMessageId}`,
      );
      if (
        proposal && proposalRequest &&
        proposalRequest.id === decision.requestId &&
        decision.scope === federationAtoaScope(proposal.id, proposal.content) &&
        !input.messages.some((candidate) =>
          candidate.direction === 'outbound' &&
          candidate.federationMessageType === 'a2a.request' &&
          candidate.id === dispatchedId)
      ) {
        tasks.push({ kind: 'grant', contact: input.contact, message, decision });
      }
    }

    if (
      message.direction === 'inbound' &&
      message.federationMessageType === 'a2a.request' &&
      request &&
      !input.messages.some((candidate) =>
        candidate.direction === 'outbound' &&
        candidate.federationMessageType === 'a2a.response' &&
        candidate.inReplyToMessageId === message.id)
    ) {
      const approval = decisions.find(({ message: decisionMessage, decision }) =>
        decisionMessage.direction === 'outbound' &&
        decision.status === 'approved' &&
        decision.requestMessageId === message.inReplyToMessageId &&
        decision.requestId === request.id &&
        decision.grantId === message.federationA2aGrantId &&
        decision.scope === message.federationA2aScope);
      const proposal = approval?.decision.status === 'approved'
        ? input.messages.find((candidate) =>
            candidate.id === approval.decision.requestMessageId &&
            candidate.direction === 'inbound')
        : null;
      if (
        approval?.decision.status === 'approved' && proposal &&
        approval.decision.scope === federationAtoaScope(
          proposal.id,
          proposal.content,
        )
      ) {
        tasks.push({
          kind: 'request',
          contact: input.contact,
          message,
          request,
          grantedSources: approval.decision.grantedSources,
          needsCurrentChatSelection:
            approval.decision.grantedSources.includes('current_chat'),
        });
      }
    }
  }
  return tasks;
}
