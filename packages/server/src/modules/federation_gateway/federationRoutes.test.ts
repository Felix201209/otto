/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import type { FederationQueueInput } from './federationContracts.js';
import {
  handleFederationRoute,
  type FederationRouteServices,
} from './federationRoutes.js';

function services(overrides: Partial<FederationRouteServices> = {}): FederationRouteServices {
  return {
    getFederationStatus: () => ({ enabled: true }),
    getFederationProvisioningManifest: () => ({ deployment: { id: 'deployment_one' } }),
    getFederationMemberIdentity: (principalId) => ({
      deploymentId: 'deployment_one',
      principalId,
    }),
    runFederationCycle: async () => ({ sent: 0 }),
    listFederationBlocks: () => [],
    blockFederationDeployment: () => undefined,
    unblockFederationDeployment: () => true,
    lookupFederationDeployment: async (id) => ({ id }),
    saveFederationChatContact: async (input) => ({ id: 'fcontact_one', ...input }),
    listFederationChatContacts: () => [],
    removeFederationChatContact: () => true,
    queueFederationChatMessage: async (input) => ({
      messageId: input.messageId || 'fmessage_one',
    }),
    listFederationChatMessages: () => [],
    markFederationChatMessageRead: () => true,
    queueFederationMessage: async (input) => ({ messageId: input.messageId || 'generated' }),
    listFederationInbox: () => [],
    consumeFederationInbox: () => true,
    createFederationA2aGrant: async () => ({ id: 'fgrant_one' }),
    revokeFederationA2aGrant: async () => undefined,
    isLicenseUsableForOrganizationFeature: () => true,
    isOrganizationFeatureEnabled: () => true,
    ...overrides,
  };
}

function request(input: {
  path: string;
  method?: string;
  body?: Record<string, unknown>;
  member?: boolean;
  admin?: boolean;
  services?: FederationRouteServices;
}) {
  const responses: Array<{ status: number; data: unknown }> = [];
  const deps = {
    path: input.path,
    method: input.method || 'GET',
    url: new URL(`https://enterprise.example.com${input.path}`),
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    memberAccount: input.member === false
      ? null
      : { id: 'account_member', organizationId: 'organization_one' },
    adminPrincipal: input.admin
      ? { organizationId: 'organization_one' }
      : null,
    services: input.services || services(),
    readBody: async () => input.body || {},
    sendJSON: (_res: ServerResponse, status: number, data: unknown) => {
      responses.push({ status, data });
    },
  };
  return {
    responses,
    execute: () => handleFederationRoute(deps),
  };
}

describe('federation enterprise routes', () => {
  it('keeps provisioning manifests behind the administrator boundary', async () => {
    const denied = request({
      path: '/enterprise/federation/admin/provisioning',
      member: false,
    });
    await expect(denied.execute()).resolves.toBe(true);
    expect(denied.responses).toEqual([
      expect.objectContaining({ status: 403 }),
    ]);

    const allowed = request({
      path: '/enterprise/federation/admin/provisioning',
      member: false,
      admin: true,
    });
    await allowed.execute();
    expect(allowed.responses).toEqual([
      expect.objectContaining({ status: 200 }),
    ]);
  });

  it('forces the authenticated account to be the sender principal', async () => {
    const queue = vi.fn(async (_input: FederationQueueInput) => ({ messageId: 'fmsg_one' }));
    const call = request({
      path: '/enterprise/federation/messages',
      method: 'POST',
      services: services({ queueFederationMessage: queue }),
      body: {
        recipientDeploymentId: 'deployment_remote',
        recipientPrincipalId: 'account_remote',
        conversationId: 'conversation_one',
        ciphertext: 'ZW5jcnlwdGVk',
        senderPrincipalId: 'account_attacker',
      },
    });
    await call.execute();
    expect(call.responses[0]?.status).toBe(202);
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({
      routing: expect.objectContaining({ senderPrincipalId: 'account_member' }),
    }));
  });

  it('fails closed when the A2A feature is disabled', async () => {
    const queue = vi.fn();
    const call = request({
      path: '/enterprise/federation/messages',
      method: 'POST',
      services: services({
        queueFederationMessage: queue,
        isOrganizationFeatureEnabled: (_organizationId, feature) => feature !== 'atoa',
      }),
      body: {
        type: 'a2a.request',
        recipientDeploymentId: 'deployment_remote',
        recipientPrincipalId: 'account_remote',
        conversationId: 'conversation_one',
        ciphertext: 'ZW5jcnlwdGVk',
        a2aGrantId: 'fgrant_one',
        a2aScope: 'worklog.read',
      },
    });
    await call.execute();
    expect(call.responses[0]).toMatchObject({ status: 403 });
    expect(queue).not.toHaveBeenCalled();
  });

  it('always scopes inbox reads to the authenticated recipient', async () => {
    const list = vi.fn(() => []);
    const pathOnly = request({
      path: '/enterprise/federation/messages',
      services: services({ listFederationInbox: list }),
    });
    pathOnly.responses.length = 0;
    await pathOnly.execute();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      recipientPrincipalId: 'account_member',
    }));
  });

  it('binds contacts and conversations to the authenticated account', async () => {
    const saveContact = vi.fn(async () => ({ id: 'fcontact_one' }));
    const listMessages = vi.fn(() => []);
    const add = request({
      path: '/enterprise/federation/contacts',
      method: 'POST',
      services: services({ saveFederationChatContact: saveContact }),
      body: {
        remoteDeploymentId: 'deployment_remote',
        remotePrincipalId: 'account_remote',
        displayName: 'Remote colleague',
        ownerAccountId: 'account_attacker',
      },
    });
    await add.execute();
    expect(add.responses[0]?.status).toBe(201);
    expect(saveContact).toHaveBeenCalledWith(expect.objectContaining({
      ownerAccountId: 'account_member',
    }));

    const list = request({
      path: '/enterprise/federation/conversations/fcontact_one/messages',
      services: services({ listFederationChatMessages: listMessages }),
    });
    await list.execute();
    expect(listMessages).toHaveBeenCalledWith(expect.objectContaining({
      ownerAccountId: 'account_member',
      contactId: 'fcontact_one',
      afterSequence: 0,
    }));
  });

  it('does not expose another account contact through delete or read state', async () => {
    const remove = vi.fn(() => false);
    const markRead = vi.fn(() => false);
    const deletion = request({
      path: '/enterprise/federation/contacts/fcontact_other',
      method: 'DELETE',
      services: services({ removeFederationChatContact: remove }),
    });
    await deletion.execute();
    expect(deletion.responses[0]?.status).toBe(404);
    expect(remove).toHaveBeenCalledWith({
      ownerAccountId: 'account_member',
      contactId: 'fcontact_other',
    });

    const read = request({
      path: '/enterprise/federation/conversations/fcontact_other/messages/fmessage_other/read',
      method: 'POST',
      services: services({ markFederationChatMessageRead: markRead }),
    });
    await read.execute();
    expect(read.responses[0]?.status).toBe(404);
    expect(markRead).toHaveBeenCalledWith(expect.objectContaining({
      ownerAccountId: 'account_member',
    }));
  });
});
