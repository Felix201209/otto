/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import type {
  EnterpriseFederatedDirectMessage,
  EnterpriseFederationContact,
} from './enterprise-client.js';
import {
  buildFederationAtoaDecision,
  deterministicFederationAtoaMessageId,
  federationAtoaScope,
} from './federation-atoa-protocol.js';
import { deriveFederationAtoaTasks } from './federation-atoa-tasks.js';

const contact: EnterpriseFederationContact = {
  id: 'contact_remote',
  identity: 'deployment_b:account_b',
  remoteDeploymentId: 'deployment_b',
  remotePrincipalId: 'account_b',
  displayName: '远程同事',
  deploymentDisplayName: '远程部署',
  createdAt: '2026-08-12T12:00:00.000Z',
  updatedAt: '2026-08-12T12:00:00.000Z',
  lastMessageAt: null,
  unreadCount: 0,
  trustState: 'verified',
  keyFingerprint: 'b'.repeat(64),
};

const requestContent = 'OTTO_ATOA_REQUEST ' + JSON.stringify({
  v: 1,
  id: 'request_one',
  question: '明天下午是否方便开会？',
  createdAt: '2026-08-12T12:00:00.000Z',
  mode: 'answer',
  requestedSources: ['schedules'],
});

function message(input: Partial<EnterpriseFederatedDirectMessage> & {
  id: string;
  direction: 'inbound' | 'outbound';
  content: string;
}): EnterpriseFederatedDirectMessage {
  return {
    senderAccountId: input.direction === 'inbound' ? contact.identity : 'account_a',
    recipientAccountId: input.direction === 'inbound' ? 'account_a' : contact.identity,
    createdAt: '2026-08-12T12:00:00.000Z',
    readAt: null,
    e2ee: true,
    e2eeProtocol: 'device-envelope-v1',
    contentType: 'message',
    federated: true,
    contactId: contact.id,
    federationMessageType: 'chat.message',
    deliveryStatus: input.direction === 'inbound' ? 'received' : 'sent',
    trustState: 'verified',
    ...input,
  };
}

describe('deriveFederationAtoaTasks', () => {
  it('surfaces an undecided proposal only for a verified contact', () => {
    const proposal = message({
      id: 'proposal_one',
      direction: 'inbound',
      content: requestContent,
      contentType: 'atoa_request',
    });
    expect(deriveFederationAtoaTasks({ contact, messages: [proposal] }))
      .toMatchObject([{ kind: 'proposal', request: { id: 'request_one' } }]);
    expect(deriveFederationAtoaTasks({
      contact: { ...contact, trustState: 'unverified' },
      messages: [proposal],
    })).toEqual([]);
  });

  it('dispatches an exact approved grant once and rejects a changed binding', () => {
    const proposal = message({
      id: 'proposal_one',
      direction: 'outbound',
      content: requestContent,
      contentType: 'atoa_request',
    });
    const scope = federationAtoaScope(proposal.id, proposal.content);
    const decision = message({
      id: 'decision_one',
      direction: 'inbound',
      content: buildFederationAtoaDecision({
        status: 'approved',
        requestId: 'request_one',
        requestMessageId: proposal.id,
        grantId: 'grant_one',
        scope,
        expiresAt: '2099-01-01T00:00:00.000Z',
        grantedSources: ['schedules'],
      }),
      inReplyToMessageId: proposal.id,
    });
    const now = Date.parse('2026-08-12T12:01:00.000Z');
    expect(deriveFederationAtoaTasks({
      contact,
      messages: [proposal, decision],
      now,
    })).toMatchObject([{ kind: 'grant', decision: { grantId: 'grant_one' } }]);

    const dispatched = message({
      id: deterministicFederationAtoaMessageId(
        'request',
        `grant_one:${proposal.id}`,
      ),
      direction: 'outbound',
      content: requestContent,
      federationMessageType: 'a2a.request',
      contentType: 'atoa_request',
      inReplyToMessageId: proposal.id,
      federationA2aGrantId: 'grant_one',
      federationA2aScope: scope,
    });
    expect(deriveFederationAtoaTasks({
      contact,
      messages: [proposal, decision, dispatched],
      now,
    })).toEqual([]);

    const tampered = {
      ...decision,
      content: buildFederationAtoaDecision({
        status: 'approved',
        requestId: 'request_one',
        requestMessageId: proposal.id,
        grantId: 'grant_one',
        scope: 'otto.a2a.changed',
        expiresAt: '2099-01-01T00:00:00.000Z',
        grantedSources: ['schedules'],
      }),
    };
    expect(deriveFederationAtoaTasks({
      contact,
      messages: [proposal, tampered],
      now,
    })).toEqual([]);
  });

  it('executes only a request matching the locally issued grant and stops after reply', () => {
    const proposal = message({
      id: 'proposal_one',
      direction: 'inbound',
      content: requestContent,
      contentType: 'atoa_request',
    });
    const scope = federationAtoaScope(proposal.id, proposal.content);
    const decision = message({
      id: 'decision_one',
      direction: 'outbound',
      content: buildFederationAtoaDecision({
        status: 'approved',
        requestId: 'request_one',
        requestMessageId: proposal.id,
        grantId: 'grant_one',
        scope,
        expiresAt: '2099-01-01T00:00:00.000Z',
        grantedSources: ['schedules'],
      }),
      inReplyToMessageId: proposal.id,
    });
    const request = message({
      id: 'actual_request_one',
      direction: 'inbound',
      content: requestContent,
      federationMessageType: 'a2a.request',
      contentType: 'atoa_request',
      inReplyToMessageId: proposal.id,
      federationA2aGrantId: 'grant_one',
      federationA2aScope: scope,
    });
    expect(deriveFederationAtoaTasks({
      contact,
      messages: [proposal, decision, request],
    })).toMatchObject([{
      kind: 'request',
      grantedSources: ['schedules'],
      needsCurrentChatSelection: false,
    }]);

    const response = message({
      id: 'response_one',
      direction: 'outbound',
      content: 'OTTO_ATOA_RESPONSE {}',
      federationMessageType: 'a2a.response',
      contentType: 'atoa_response',
      inReplyToMessageId: request.id,
    });
    expect(deriveFederationAtoaTasks({
      contact,
      messages: [proposal, decision, request, response],
    })).toEqual([]);
  });
});
