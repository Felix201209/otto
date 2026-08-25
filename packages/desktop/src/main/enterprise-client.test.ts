/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  EnterpriseClient,
  EnterpriseJoinStateUncertainError,
  logoutAndPersistEnterpriseSession,
  type EnterpriseLegalDocumentReference,
} from './enterprise-client.js';
import {
  ENTERPRISE_MLS_CIPHERSUITE,
  enterpriseMlsDirectConversationId,
  parseEnterpriseMlsKeyPackageInventory,
} from './enterprise-mls.js';
import type {
  EnterpriseE2eeCrypto,
  EnterpriseE2eeDeviceBundle,
  EnterpriseE2eeKeyTransparencyView,
  EnterpriseE2eeWireMessage,
} from './enterprise-e2ee.js';

const E2EE_DEVICE = {
  accountId: 'acc_1',
  deviceId: 'device-1',
  deviceName: 'test device',
  identitySigningPublicKey: 'test signing key',
  deviceExchangePublicKey: 'test exchange key',
  keyFingerprint: '1'.repeat(64),
  approvalState: 'approved' as const,
  approvedByDeviceId: null,
  approvedAt: '2026-07-31T00:00:00.000Z',
  createdAt: '2026-07-31T00:00:00.000Z',
  lastSeenAt: '2026-07-31T00:00:00.000Z',
  revokedAt: null,
};

const LEGAL_DOCUMENTS = [
  { id: 'terms', version: '2026-08-03', hash: 'a'.repeat(64) },
  { id: 'privacy', version: '2026-08-03', hash: 'b'.repeat(64) },
] satisfies EnterpriseLegalDocumentReference[];

describe('parseEnterpriseMlsKeyPackageInventory', () => {
  const entry = (reference: string, expiresAt = '2026-08-10T00:00:00.000Z') => ({
    reference,
    expiresAt,
  });

  it.each([
    {
      name: 'wrong device binding',
      value: { deviceId: 'device-2', keyPackages: [] },
    },
    {
      name: 'duplicate reference',
      value: {
        deviceId: 'device-1',
        keyPackages: [entry('a'.repeat(64)), entry('a'.repeat(64))],
      },
    },
    {
      name: 'non-monotonic reference order',
      value: {
        deviceId: 'device-1',
        keyPackages: [entry('b'.repeat(64)), entry('a'.repeat(64))],
      },
    },
    {
      name: 'expired reference',
      value: {
        deviceId: 'device-1',
        keyPackages: [entry('a'.repeat(64), '2026-08-02T00:00:00.000Z')],
      },
    },
  ])('rejects $name', ({ value }) => {
    expect(() =>
      parseEnterpriseMlsKeyPackageInventory(
        value,
        'device-1',
        Date.parse('2026-08-03T00:00:00.000Z'),
      ),
    ).toThrow('KeyPackage inventory is invalid');
  });
});

function mockE2eeCrypto(input: {
  decryptContent?: string;
  decryptedAttachments?: Array<{ id: string; fileName: string; mimeType: string; size: number }>;
  encryptedAttachments?: Array<{ id: string; ciphertext: string; nonce: string }>;
} = {}): EnterpriseE2eeCrypto {
  return {
    localDevice: vi.fn(() => E2EE_DEVICE),
    verifyLocalDeviceRegistration: vi.fn(
      (
        _local: EnterpriseE2eeDeviceBundle,
        registered: EnterpriseE2eeDeviceBundle,
      ) => registered,
    ),
    verifyAndPinKeyTransparency: vi.fn(
      ({ view }: { view: EnterpriseE2eeKeyTransparencyView }) => view,
    ),
    verifyDeviceDirectory: vi.fn(
      ({ devices }: { devices: EnterpriseE2eeDeviceBundle[] }) => devices,
    ),
    encryptMessage: vi.fn(() => ({
      messageId: 'message-1',
      senderDeviceId: 'device-1',
      protocolVersion: 1,
      contentType: 'message',
      inReplyToMessageId: null,
      ciphertext: 'Y2lwaGVydGV4dCBwbHVzIGF1dGggdGFn',
      nonce: 'AAAAAAAAAAAAAAAA',
      signature: 'c2lnbmF0dXJl',
      envelopes: [],
      attachments: input.encryptedAttachments ?? [],
    })),
    decryptMessage: vi.fn(({ message }: { message: EnterpriseE2eeWireMessage }) => ({
      id: message.id,
      senderAccountId: message.senderAccountId,
      recipientAccountId: message.recipientAccountId,
      content: input.decryptContent ?? 'decrypted message',
      contentType: message.contentType,
      inReplyToMessageId: message.inReplyToMessageId,
      createdAt: message.createdAt,
      readAt: message.readAt,
      attachments: input.decryptedAttachments ?? [],
    })),
    decryptAttachment: vi.fn(() => ({
      id: 'attachment-1',
      fileName: '方案.pdf',
      mimeType: 'application/pdf',
      size: 4,
      data: 'JVBERg==',
    })),
  } as unknown as EnterpriseE2eeCrypto;
}

function emptyTransparency(accountId: string) {
  return {
    transparency: {
      accountId,
      headSequence: 0,
      headHash: '0'.repeat(64),
      entries: [],
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const ACCOUNT = {
  id: 'acc_1', organizationId: 'org_acme', organizationName: '星河科技',
  employeeId: null, username: 'staff01', phone: '+8613800138000', name: '员工一号',
  role: null, department: null, isAdmin: false, status: 'active' as const,
  positionId: null, positionTitle: null,
  tags: ['普通员工'], createdAt: '2026-07-13', updatedAt: '2026-07-13',
};

const API_V2_HEALTH = {
  status: 'ok',
  apiVersion: 2,
  capabilities: [
    'password_auth',
    'sms_login',
    'sms_registration',
    'personal_registration',
    'organization_invites',
    'usage_summary',
    'admin_console',
    'account_deletion',
    'multi_organization',
    'direct_messages',
    'e2ee_private_messages_v1',
    'e2ee_device_trust_v1',
    'direct_message_attachments_v1',
    'atoa',
    'position_invites',
    'personal_enterprise_upgrade',
    'park_service_push',
    'account_presence_v1',
    'modular_update_push_v1',
    'signed_update_policy_v1',
  ],
};

function mockFederationCrypto(): EnterpriseE2eeCrypto {
  const trusts = new Map<string, {
    card: Record<string, unknown>;
    verifiedAt: string | null;
    pinnedAt: string;
  }>();
  let lastPlaintext = '';
  const localDevice = {
    ...E2EE_DEVICE,
    accountId: 'deployment-a:acc_1',
    identitySigningPublicKey: 'local federation signing key',
    deviceExchangePublicKey: 'local federation exchange key',
    keyFingerprint: 'a'.repeat(64),
  };
  const localCard = {
    v: 2 as const,
    deploymentId: 'deployment-a',
    principalId: 'acc_1',
    displayName: ACCOUNT.name,
    device: localDevice,
    devices: [
      localDevice,
      {
        ...localDevice,
        deviceId: 'local-federation-phone',
        keyFingerprint: 'c'.repeat(64),
      },
    ],
    identityDevice: localDevice,
    identityKeyFingerprint: localDevice.keyFingerprint,
    directorySequence: 2,
    directoryHash: 'd'.repeat(64),
    issuedAt: '2026-08-12T00:00:00.000Z',
    signature: 'local-card-signature',
  };
  return {
    verifyLocalDeviceRegistration: vi.fn((_, registered) => registered),
    verifyAndPinKeyTransparency: vi.fn(({ view }) => view),
    verifyDeviceDirectory: vi.fn(({ devices }) => devices),
    verifyFederationIdentityCard: vi.fn((card) => card),
    createFederationIdentityCard: vi.fn(() => localCard),
    pinFederationContact: vi.fn((input: {
      contactId: string;
      card: typeof localCard;
    }) => {
      const current = trusts.get(input.contactId);
      if (
        current &&
        (current.card as typeof localCard).device.keyFingerprint !==
          input.card.device.keyFingerprint
      ) {
        throw new Error('federation contact device key changed');
      }
      const trust = {
        card: input.card,
        verifiedAt: current?.verifiedAt ?? null,
        pinnedAt: current?.pinnedAt ?? '2026-08-12T00:00:00.000Z',
      };
      trusts.set(input.contactId, trust);
      return trust;
    }),
    federationContactTrust: vi.fn((input: { contactId: string }) =>
      trusts.get(input.contactId) ?? null),
    verifyFederationContact: vi.fn((input: { contactId: string }) => {
      const trust = trusts.get(input.contactId);
      if (!trust) throw new Error('federation contact trust was not found');
      const verified = { ...trust, verifiedAt: '2026-08-12T00:01:00.000Z' };
      trusts.set(input.contactId, verified);
      return verified;
    }),
    removeFederationContact: vi.fn((input: { contactId: string }) => {
      trusts.delete(input.contactId);
    }),
    localDevice: vi.fn(() => localDevice),
    encryptMessage: vi.fn((input: { content: string }) => {
      lastPlaintext = input.content;
      return {
        messageId: 'federation-message-1',
        senderDeviceId: localDevice.deviceId,
        protocolVersion: 1 as const,
        contentType: 'message' as const,
        inReplyToMessageId: null,
        ciphertext: 'encrypted-federation-content',
        nonce: 'encrypted-federation-nonce',
        signature: 'encrypted-federation-signature',
        envelopes: [],
        attachments: [],
      };
    }),
    decryptMessage: vi.fn(({ message }: { message: EnterpriseE2eeWireMessage }) => ({
      id: message.id,
      senderAccountId: message.senderAccountId,
      recipientAccountId: message.recipientAccountId,
      content: lastPlaintext,
      contentType: message.contentType,
      inReplyToMessageId: message.inReplyToMessageId,
      createdAt: message.createdAt,
      readAt: message.readAt,
      attachments: [],
    })),
  } as unknown as EnterpriseE2eeCrypto;
}

describe('EnterpriseClient', () => {
  it('imports a signed federation contact and sends only an opaque E2EE envelope', async () => {
    const remoteCard = {
      v: 1 as const,
      deploymentId: 'deployment-b',
      principalId: 'remote-account',
      displayName: '远程同事',
      device: {
        ...E2EE_DEVICE,
        accountId: 'deployment-b:remote-account',
        deviceId: 'remote-device',
        identitySigningPublicKey: 'remote federation signing key',
        deviceExchangePublicKey: 'remote federation exchange key',
        keyFingerprint: 'b'.repeat(64),
      },
      issuedAt: '2026-08-12T00:00:00.000Z',
      signature: 'remote-card-signature',
    };
    const contacts: Array<Record<string, unknown>> = [];
    const messageBodies: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/enterprise/health')) {
        return jsonResponse(200, {
          ...API_V2_HEALTH,
          capabilities: [...API_V2_HEALTH.capabilities, 'federation_chat_v1'],
        });
      }
      if (url.endsWith('/enterprise/auth/login')) {
        return jsonResponse(200, {
          account: ACCOUNT,
          token: 'session-token',
          expiresAt: '2099-01-01',
        });
      }
      if (url.endsWith('/enterprise/federation/identity')) {
        return jsonResponse(200, {
          identity: {
            deploymentId: 'deployment-a',
            principalId: ACCOUNT.id,
            capabilities: ['chat.e2ee'],
          },
        });
      }
      if (url.endsWith('/enterprise/e2ee/devices') && method === 'POST') {
        return jsonResponse(201, {
          device: {
            ...E2EE_DEVICE,
            accountId: ACCOUNT.id,
            approvalState: 'approved',
            revokedAt: null,
          },
        });
      }
      if (url.includes('/enterprise/e2ee/key-transparency?')) {
        return jsonResponse(200, {
          transparency: {
            accountId: ACCOUNT.id,
            headSequence: 1,
            headHash: 'a'.repeat(64),
            entries: [{
              sequence: 1,
              organizationId: ACCOUNT.organizationId,
              accountId: ACCOUNT.id,
              deviceId: E2EE_DEVICE.deviceId,
              event: 'bootstrap_approved',
              keyFingerprint: E2EE_DEVICE.keyFingerprint,
              actorDeviceId: null,
              previousHash: '0'.repeat(64),
              entryHash: 'a'.repeat(64),
              createdAt: '2026-08-12T00:00:00.000Z',
            }],
          },
        });
      }
      if (url.includes('/enterprise/e2ee/devices?') && method === 'GET') {
        return jsonResponse(200, {
          devices: [{
            ...E2EE_DEVICE,
            accountId: ACCOUNT.id,
            approvalState: 'approved',
            revokedAt: null,
          }],
        });
      }
      if (url.endsWith('/enterprise/federation/contacts') && method === 'GET') {
        return jsonResponse(200, { contacts });
      }
      if (url.endsWith('/enterprise/federation/contacts') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        const contact = {
          id: 'contact-remote',
          identity: 'deployment-b:remote-account',
          remoteDeploymentId: body.remoteDeploymentId,
          remotePrincipalId: body.remotePrincipalId,
          displayName: body.displayName,
          deploymentDisplayName: '远程私有部署',
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
          lastMessageAt: null,
          unreadCount: 0,
        };
        contacts.splice(0, contacts.length, contact);
        return jsonResponse(201, { contact });
      }
      if (url.includes('/enterprise/federation/conversations/') && method === 'POST') {
        messageBodies.push(String(init?.body));
        return jsonResponse(202, { queued: true });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    const crypto = mockFederationCrypto();
    const client = new EnterpriseClient(
      fetchMock as typeof fetch,
      () => undefined,
      crypto,
    );
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );
    const contactCode = `OTTO_FEDERATION_CONTACT_V1:${Buffer.from(
      JSON.stringify(remoteCard),
      'utf8',
    ).toString('base64url')}`;

    await expect(client.saveFederationContactCode(contactCode)).resolves.toMatchObject({
      id: 'contact-remote',
      trustState: 'unverified',
      keyFingerprint: 'b'.repeat(64),
    });
    await expect(client.sendFederationMessage(
      'contact-remote',
      '仅收件人可见的联邦消息',
    )).resolves.toMatchObject({
      federated: true,
      direction: 'outbound',
      deliveryStatus: 'queued',
      content: '仅收件人可见的联邦消息',
    });
    expect(messageBodies).toHaveLength(1);
    expect(messageBodies[0]).not.toContain('仅收件人可见的联邦消息');
    expect(JSON.parse(messageBodies[0]!) as Record<string, unknown>).toMatchObject({
      messageId: 'federation-message-1',
      inReplyTo: null,
    });
    const encryptionInput = vi.mocked(crypto.encryptMessage).mock.calls[0]?.[0];
    expect(encryptionInput?.devices).toHaveLength(3);
    expect(encryptionInput?.keyring).toEqual({
      serverScope: 'https://enterprise.otto.test',
      accountId: ACCOUNT.id,
    });
  });

  it('refuses to import the current account as a federation contact', async () => {
    const ownCard = {
      v: 1 as const,
      deploymentId: 'deployment-a',
      principalId: ACCOUNT.id,
      displayName: ACCOUNT.name,
      device: { ...E2EE_DEVICE, accountId: `deployment-a:${ACCOUNT.id}` },
      issuedAt: '2026-08-12T00:00:00.000Z',
      signature: 'self-signature',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        ...API_V2_HEALTH,
        capabilities: [...API_V2_HEALTH.capabilities, 'federation_chat_v1'],
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT,
        token: 'session-token',
        expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        identity: {
          deploymentId: 'deployment-a',
          principalId: ACCOUNT.id,
          capabilities: ['chat.e2ee'],
        },
      }));
    const client = new EnterpriseClient(
      fetchMock as typeof fetch,
      () => undefined,
      mockFederationCrypto(),
    );
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );
    const code = Buffer.from(JSON.stringify(ownCard), 'utf8').toString('base64url');

    await expect(client.saveFederationContactCode(code)).rejects.toThrow(
      '不能把自己的联邦联系码添加为联系人',
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails closed instead of downgrading when the server advertises MLS private chat', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...API_V2_HEALTH,
          capabilities: [...API_V2_HEALTH.capabilities, 'e2ee_mls_v1'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          account: ACCOUNT,
          token: 'session-token',
          expiresAt: '2099-01-01',
        }),
      );
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );

    expect(client.supportsMlsPrivateMessages()).toBe(true);
    await expect(
      client.sendDirectMessage('acc_peer', 'must not downgrade'),
    ).rejects.toThrow('MLS private-message transport is not active');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('wires the inactive MLS ciphertext transport without enabling MLS chat', async () => {
    const keyPackageBytes = Buffer.from('local-key-package').toString('base64');
    const keyPackageReference = 'a'.repeat(64);
    const peerKeyPackageBytes =
      Buffer.from('peer-key-package').toString('base64');
    const peerKeyPackageReference = 'b'.repeat(64);
    const conversationId = enterpriseMlsDirectConversationId({
      organizationId: ACCOUNT.organizationId,
      accountId: ACCOUNT.id,
      peerAccountId: 'acc_peer',
    });
    const published = {
      reference: keyPackageReference,
      accountId: ACCOUNT.id,
      deviceId: 'device-1',
      ciphersuite: ENTERPRISE_MLS_CIPHERSUITE,
      keyPackage: keyPackageBytes,
      createdAt: '2026-08-02T00:00:00.000Z',
      claimedAt: null,
      expiresAt: '2026-08-09T00:00:00.000Z',
    };
    const claimed = {
      ...published,
      reference: peerKeyPackageReference,
      accountId: 'acc_peer',
      deviceId: 'peer-device',
      keyPackage: peerKeyPackageBytes,
      claimedAt: '2026-08-02T00:01:00.000Z',
    };
    const event = {
      sequence: 1,
      eventId: 'event-1',
      conversationId,
      sessionGeneration: 1,
      senderAccountId: ACCOUNT.id,
      senderDeviceId: 'device-1',
      recipientAccountId: null,
      recipientDeviceId: null,
      eventType: 'commit' as const,
      epoch: 1,
      groupId: Buffer.from('group-1').toString('base64'),
      payload: Buffer.from('commit-1').toString('base64'),
      keyPackageReference: null,
      createdAt: '2026-08-02T00:02:00.000Z',
      expiresAt: '2026-10-31T00:02:00.000Z',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...API_V2_HEALTH,
          capabilities: [
            ...API_V2_HEALTH.capabilities,
            'e2ee_mls_transport_v1',
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          account: ACCOUNT,
          token: 'session-token',
          expiresAt: '2099-01-01',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          deviceId: 'device-1',
          keyPackages: [
            {
              reference: keyPackageReference,
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          deviceId: 'device-1',
          reference: keyPackageReference,
          retired: true,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(201, { keyPackage: published }))
      .mockResolvedValueOnce(jsonResponse(200, { keyPackage: claimed }))
      .mockResolvedValueOnce(jsonResponse(201, { event }))
      .mockResolvedValueOnce(jsonResponse(200, { events: [event] }))
      .mockResolvedValueOnce(
        jsonResponse(200, { peerAccountIds: ['acc_other', 'acc_peer'] }),
      );
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );

    expect(client.supportsMlsTransportFoundation()).toBe(true);
    expect(client.supportsMlsPrivateMessages()).toBe(false);
    await expect(
      client.listMlsKeyPackageInventory('device-1'),
    ).resolves.toEqual({
      deviceId: 'device-1',
      keyPackages: [
        {
          reference: keyPackageReference,
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      ],
    });
    await expect(
      client.retireMlsKeyPackage('device-1', keyPackageReference),
    ).resolves.toBeUndefined();
    await expect(
      client.publishMlsKeyPackage('device-1', {
        protocol: 'mls10-openmls-0.8',
        ciphersuite: ENTERPRISE_MLS_CIPHERSUITE,
        reference: keyPackageReference,
        key_package: keyPackageBytes,
      }),
    ).resolves.toEqual(published);
    await expect(
      client.claimMlsKeyPackage('device-1', 'acc_peer'),
    ).resolves.toEqual(claimed);
    await expect(
      client.appendMlsTransportEvent('acc_peer', {
        senderDeviceId: 'device-1',
        eventId: event.eventId,
        eventType: event.eventType,
        epoch: event.epoch,
        groupId: event.groupId,
        payload: event.payload,
      }),
    ).resolves.toEqual(event);
    await expect(
      client.listMlsTransportEvents('acc_peer', 0, 25),
    ).resolves.toEqual([event]);
    await expect(
      client.listMlsInboundConversationPeers('device-1'),
    ).resolves.toEqual(['acc_other', 'acc_peer']);

    expect(fetchMock.mock.calls.slice(2).map(([url]) => url)).toEqual([
      'https://enterprise.otto.test/enterprise/e2ee/mls/key-packages/inventory?deviceId=device-1',
      `https://enterprise.otto.test/enterprise/e2ee/mls/key-packages/${keyPackageReference}?deviceId=device-1`,
      'https://enterprise.otto.test/enterprise/e2ee/mls/key-packages',
      'https://enterprise.otto.test/enterprise/e2ee/mls/key-packages/claim',
      'https://enterprise.otto.test/enterprise/e2ee/mls/conversations/acc_peer/events',
      'https://enterprise.otto.test/enterprise/e2ee/mls/conversations/acc_peer/events?afterSequence=0&limit=25',
      'https://enterprise.otto.test/enterprise/e2ee/mls/inbound-conversations?deviceId=device-1&limit=500',
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toMatchObject({
      keyPackageReference,
    });
  });

  it('rejects MLS transport responses whose cursor or account-pair binding is invalid', async () => {
    const conversationId = enterpriseMlsDirectConversationId({
      organizationId: ACCOUNT.organizationId,
      accountId: ACCOUNT.id,
      peerAccountId: 'acc_peer',
    });
    const event = {
      sequence: 4,
      eventId: 'event-4',
      conversationId,
      sessionGeneration: 1,
      senderAccountId: 'unrelated-account',
      senderDeviceId: 'unrelated-device',
      recipientAccountId: null,
      recipientDeviceId: null,
      eventType: 'application',
      epoch: 1,
      groupId: Buffer.from('group-1').toString('base64'),
      payload: Buffer.from('ciphertext').toString('base64'),
      keyPackageReference: null,
      createdAt: '2026-08-02T00:02:00.000Z',
      expiresAt: '2026-10-31T00:02:00.000Z',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...API_V2_HEALTH,
          capabilities: [
            ...API_V2_HEALTH.capabilities,
            'e2ee_mls_transport_v1',
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          account: ACCOUNT,
          token: 'session-token',
          expiresAt: '2099-01-01',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { events: [event] }))
      .mockResolvedValueOnce(
        jsonResponse(200, { peerAccountIds: ['acc_peer', 'acc_peer'] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          deviceId: 'device-1',
          keyPackages: [
            {
              reference: 'a'.repeat(64),
              expiresAt: '2020-01-01T00:00:00.000Z',
            },
          ],
        }),
      );
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );

    await expect(
      client.listMlsTransportEvents('acc_peer', 3, 100),
    ).rejects.toThrow('binding is invalid');
    await expect(
      client.listMlsInboundConversationPeers('device-1'),
    ).rejects.toThrow('inbound conversation list is invalid');
    await expect(
      client.listMlsKeyPackageInventory('device-1'),
    ).rejects.toThrow('KeyPackage inventory is invalid');
  });

  it('paginates sorted inbound MLS peers with an opaque account cursor', async () => {
    const firstPage = Array.from(
      { length: 500 },
      (_, index) => `peer-${String(index).padStart(4, '0')}`,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...API_V2_HEALTH,
          capabilities: [
            ...API_V2_HEALTH.capabilities,
            'e2ee_mls_transport_v1',
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          account: ACCOUNT,
          token: 'session-token',
          expiresAt: '2099-01-01',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { peerAccountIds: firstPage }))
      .mockResolvedValueOnce(
        jsonResponse(200, { peerAccountIds: ['peer-0500'] }),
      );
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );

    await expect(
      client.listMlsInboundConversationPeers('device-1'),
    ).resolves.toEqual([...firstPage, 'peer-0500']);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      'https://enterprise.otto.test/enterprise/e2ee/mls/inbound-conversations?deviceId=device-1&limit=500&afterPeerAccountId=peer-0499',
    );
  });
  it('falls back safely when an older server ignores the conversation-head request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...API_V2_HEALTH,
          capabilities: [
            ...API_V2_HEALTH.capabilities,
            'e2ee_mls_transport_v1',
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          account: ACCOUNT,
          token: 'session-token',
          expiresAt: '2099-01-01',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { peerAccountIds: ['acc_other', 'acc_peer'] }),
      );
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );

    await expect(
      client.listMlsInboundConversationHeads('device-1'),
    ).resolves.toBeNull();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      'https://enterprise.otto.test/enterprise/e2ee/mls/inbound-conversations?deviceId=device-1&limit=500&includeHeads=1',
    );
  });

  it('treats an empty peer KeyPackage inventory as a recoverable transport state', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...API_V2_HEALTH,
          capabilities: [
            ...API_V2_HEALTH.capabilities,
            'e2ee_mls_transport_v1',
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          account: ACCOUNT,
          token: 'session-token',
          expiresAt: '2099-01-01',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(404, {
          error: 'no unclaimed MLS KeyPackage is available',
        }),
      );
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );

    await expect(
      client.claimMlsKeyPackage('device-1', 'acc_peer'),
    ).resolves.toBeNull();
  });
  it('密码登录规范化服务器地址并保存会话，后续请求自动携带 Bearer token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, { account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01' }))
      .mockResolvedValueOnce(jsonResponse(200, { account: ACCOUNT }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    const loggedIn = await client.loginWithPassword('https://59-110-154-44.sslip.io/', 'staff01', 'password');
    expect(loggedIn.account.username).toBe('staff01');
    expect(client.snapshot()).toEqual({ serverUrl: 'https://59-110-154-44.sslip.io', token: 'session-token' });

    await client.getSession();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://59-110-154-44.sslip.io/enterprise/health',
      'https://59-110-154-44.sslip.io/enterprise/auth/login',
      'https://59-110-154-44.sslip.io/enterprise/auth/me',
    ]);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty('authorization');
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer session-token',
    });
  });

  it('只向本机可信层返回账号绑定的短期模型网关凭据', async () => {
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...API_V2_HEALTH,
          capabilities: [
            ...API_V2_HEALTH.capabilities,
            'managed_model_gateway_v1',
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          account: ACCOUNT,
          token: 'session-token',
          expiresAt: '2099-01-01',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          gateway: {
            baseUrl: 'https://edge.otto.test/v1/',
            accessToken: 'edge-short-token-at-least-thirty-two-characters',
            expiresAt,
            allowedModels: ['otto:deepseek', 'otto:qwen'],
          },
        }),
      );
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );

    await expect(client.getManagedModelGatewayAccess()).resolves.toEqual({
      baseUrl: 'https://edge.otto.test/v1',
      accessToken: 'edge-short-token-at-least-thirty-two-characters',
      expiresAt,
      allowedModels: ['otto:deepseek', 'otto:qwen'],
    });
    const request = fetchMock.mock.calls[2];
    expect(request?.[0]).toBe(
      'https://enterprise.otto.test/enterprise/model-gateway/access-token',
    );
    expect((request?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer session-token',
    });
    expect((request?.[1] as RequestInit).body).toBe('{}');
  });

  it('拒绝企业服务器返回的非 HTTPS 网关或失效短令牌', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...API_V2_HEALTH,
          capabilities: [
            ...API_V2_HEALTH.capabilities,
            'managed_model_gateway_v1',
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          account: ACCOUNT,
          token: 'session-token',
          expiresAt: '2099-01-01',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          gateway: {
            baseUrl: 'http://edge.otto.test/v1',
            accessToken: 'edge-short-token-at-least-thirty-two-characters',
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            allowedModels: ['otto:deepseek'],
          },
        }),
      );
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );

    await expect(client.getManagedModelGatewayAccess()).rejects.toThrow(
      /安全要求/,
    );
  });

  it('保留 HTTPS 部署路径前缀，并在前缀下请求全部企业接口', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    await client.loginWithPassword(
      'https://enterprise.otto.test/company/',
      'staff01',
      'password',
    );

    expect(client.snapshot().serverUrl).toBe('https://enterprise.otto.test/company');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://enterprise.otto.test/company/enterprise/health',
      'https://enterprise.otto.test/company/enterprise/auth/login',
    ]);
  });

  it('首次注册先请求挑战，再提交姓名、密码和验证码并保存会话', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        challengeId: 'sms_1', expiresAt: '2099-01-01', retryAfterSeconds: 60, message: '已发送',
        organization: { id: 'org_acme', name: '星河科技' },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'sms-session', expiresAt: '2099-01-02',
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    const challenge = await client.requestRegistrationCode(
      'https://enterprise.otto.test',
      '13800138000',
      'Ab3D-k9Pq-Z7xY',
    );
    expect(challenge.challengeId).toBe('sms_1');
    expect(challenge.organization).toEqual({ id: 'org_acme', name: '星河科技' });
    const loggedIn = await client.registerWithSms({
      challengeId: 'sms_1', code: '042731', name: '员工一号', password: 'registered-password', legalConsent: true,
      legalDocuments: LEGAL_DOCUMENTS,
    });
    expect(loggedIn.account.id).toBe(ACCOUNT.id);
    expect(client.snapshot().token).toBe('sms-session');
    expect(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method])).toEqual([
      ['https://enterprise.otto.test/enterprise/health', 'GET'],
      ['https://enterprise.otto.test/enterprise/auth/register/sms/request', 'POST'],
      ['https://enterprise.otto.test/enterprise/auth/register/sms/verify', 'POST'],
    ]);
    expect(JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({
      phone: '13800138000', inviteCode: 'Ab3D-k9Pq-Z7xY',
    });
    expect(JSON.parse((fetchMock.mock.calls[2]?.[1] as RequestInit).body as string)).toEqual({
      challengeId: 'sms_1', code: '042731', name: '员工一号', password: 'registered-password', legalConsent: true,
      legalDocuments: LEGAL_DOCUMENTS,
    });
  });

  it('普通注册不发送邀请码，且只要求个人注册能力', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        status: 'ok',
        apiVersion: 3,
        capabilities: ['sms_registration', 'personal_registration'],
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        challengeId: 'sms_personal',
        expiresAt: '2099-01-01',
        retryAfterSeconds: 60,
        message: '已发送',
        registrationMode: 'personal',
        organization: null,
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    const challenge = await client.requestRegistrationCode(
      'https://enterprise.otto.test',
      '13800138000',
    );

    expect(challenge.registrationMode).toBe('personal');
    expect(JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string))
      .toEqual({ phone: '13800138000' });
  });

  it('个人账号登录后用 Bearer 会话提交邀请码，并用服务端返回值刷新当前身份', async () => {
    const personalAccount = {
      ...ACCOUNT,
      organizationId: 'personal_acc_1',
      organizationName: '员工一号的个人空间',
      accountType: 'personal' as const,
    };
    const upgradedAccount = {
      ...ACCOUNT,
      accountType: 'enterprise' as const,
      department: '产品部',
      positionTitle: '产品经理',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: personalAccount, token: 'personal-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: upgradedAccount,
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );

    await expect(client.joinOrganization('Ab3D-k9Pq-Z7xY')).resolves.toEqual({
      account: upgradedAccount,
    });
    expect(client.authenticatedAccountSnapshot()).toEqual(upgradedAccount);
    expect(fetchMock.mock.calls[2]?.[0])
      .toBe('https://enterprise.otto.test/enterprise/auth/join-organization');
    const request = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(request.method).toBe('POST');
    expect(request.headers).toMatchObject({ authorization: 'Bearer personal-token' });
    expect(JSON.parse(request.body as string)).toEqual({ inviteCode: 'Ab3D-k9Pq-Z7xY' });
  });

  it('uses the member session to read enterprise module update manifests', async () => {
    const manifest = {
      format: 'otto-module-updates-v1',
      deploymentId: 'dep_1',
      generatedAt: '2026-07-26T00:00:00.000Z',
      modules: [{
        module: 'park_service',
        version: '1.9.5-park.2',
        rollout: 'stable',
        notes: 'park update',
        minAppVersion: '1.9.5',
        manifestUrl: 'https://updates.example.com/otto-incremental.json',
        sha256: 'a'.repeat(64),
        publishedAt: '2026-07-26T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:00.000Z',
      }],
      catalog: [{ module: 'park_service', features: ['park_service'] }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, manifest));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(client.getModuleUpdates()).resolves.toEqual(manifest);
    expect(fetchMock.mock.calls[2]?.[0])
      .toBe('https://enterprise.otto.test/enterprise/modules/updates/client');
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers)
      .toMatchObject({ authorization: 'Bearer session-token' });
  });

  it('uses the member session to resolve a distribution-bound update policy', async () => {
    const result = {
      status: 'not_configured' as const,
      reason: 'online_license_required' as const,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, result));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(client.getDeploymentUpdatePolicy({
      distributionId: 'otto-green',
      currentVersion: '1.9.10',
    })).resolves.toEqual(result);
    expect(fetchMock.mock.calls[2]?.[0])
      .toBe('https://enterprise.otto.test/enterprise/deployment/update-policy');
    const request = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({ authorization: 'Bearer session-token' });
    expect(JSON.parse(String(request.body))).toEqual({
      distributionId: 'otto-green',
      currentVersion: '1.9.10',
    });
  });

  it('加入企业已提交但响应断线时，用原 Bearer 会话对账并提交企业身份', async () => {
    const personalAccount = {
      ...ACCOUNT,
      organizationId: 'personal_acc_1',
      organizationName: '员工一号的个人空间',
      accountType: 'personal' as const,
    };
    const upgradedAccount = {
      ...ACCOUNT,
      organizationId: 'org_product',
      organizationName: '产品企业',
      accountType: 'enterprise' as const,
      department: '产品部',
      positionId: 'position_pm',
      positionTitle: '产品经理',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: personalAccount, token: 'personal-token', expiresAt: '2099-01-01',
      }))
      .mockRejectedValueOnce(new Error('socket disconnected after commit'))
      .mockResolvedValueOnce(jsonResponse(200, { account: upgradedAccount }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );

    await expect(client.joinOrganization('Ab3D-k9Pq-Z7xY')).resolves.toEqual({
      account: upgradedAccount,
    });
    expect(client.authenticatedAccountSnapshot()).toEqual(upgradedAccount);
    expect(fetchMock.mock.calls[3]?.[0])
      .toBe('https://enterprise.otto.test/enterprise/auth/me');
    expect((fetchMock.mock.calls[3]?.[1] as RequestInit).headers)
      .toMatchObject({ authorization: 'Bearer personal-token' });
  });

  it('加入企业请求断线但服务端确认仍为个人账号时，保留个人会话供安全重试', async () => {
    const personalAccount = {
      ...ACCOUNT,
      organizationId: 'personal_acc_1',
      organizationName: '员工一号的个人空间',
      accountType: 'personal' as const,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: personalAccount, token: 'personal-token', expiresAt: '2099-01-01',
      }))
      .mockRejectedValueOnce(new Error('socket disconnected before commit'))
      .mockResolvedValueOnce(jsonResponse(200, { account: personalAccount }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );

    await expect(client.joinOrganization('Ab3D-k9Pq-Z7xY'))
      .rejects.toThrow('无法连接企业服务器：socket disconnected before commit');
    expect(client.authenticatedAccountSnapshot()).toEqual(personalAccount);
  });

  it('加入企业响应断线且无法读取当前身份时，返回可识别的不确定状态错误', async () => {
    const personalAccount = {
      ...ACCOUNT,
      organizationId: 'personal_acc_1',
      organizationName: '员工一号的个人空间',
      accountType: 'personal' as const,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: personalAccount, token: 'personal-token', expiresAt: '2099-01-01',
      }))
      .mockRejectedValueOnce(new Error('join response lost'))
      .mockRejectedValueOnce(new Error('auth me unavailable'));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );

    await expect(client.joinOrganization('Ab3D-k9Pq-Z7xY'))
      .rejects.toBeInstanceOf(EnterpriseJoinStateUncertainError);
    expect(client.authenticatedAccountSnapshot()).toEqual(personalAccount);
  });

  it('企业账号不能从客户端重复加入另一企业', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: { ...ACCOUNT, accountType: 'enterprise' },
        token: 'member-token',
        expiresAt: '2099-01-01',
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );

    await expect(client.joinOrganization('Ab3D-k9Pq-Z7xY'))
      .rejects.toThrow('当前账号已经属于企业');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('支持手机号验证码登录并保存会话', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        challengeId: 'sms_login_1',
        expiresAt: '2099-01-01',
        retryAfterSeconds: 60,
        message: '已发送',
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT,
        token: 'sms-login-session',
        expiresAt: '2099-01-02',
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    const challenge = await client.requestLoginCode(
      'https://enterprise.otto.test',
      '13800138000',
    );
    expect(challenge.challengeId).toBe('sms_login_1');
    await expect(client.loginWithSms({
      challengeId: challenge.challengeId,
      code: '042731',
    })).resolves.toMatchObject({ account: { id: ACCOUNT.id } });
    expect(client.snapshot().token).toBe('sms-login-session');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://enterprise.otto.test/enterprise/health',
      'https://enterprise.otto.test/enterprise/auth/sms/request',
      'https://enterprise.otto.test/enterprise/auth/sms/verify',
    ]);
  });

  it('登录后按消息幂等键上报 provider 返回的 Token 用量', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(201, { recorded: true, source: 'client_reported' }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(client.recordTokenUsage({
      sessionId: 'session-1',
      messageId: 'message-1',
      model: 'deepseek-v4-pro',
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46,
    })).resolves.toEqual({ recorded: true, source: 'client_reported' });

    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://enterprise.otto.test/enterprise/usage');
    const init = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer session-token' });
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: 'session-1',
      messageId: 'message-1',
      model: 'deepseek-v4-pro',
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46,
    });
  });

  it('未登录时不发送 Token 用量', async () => {
    const fetchMock = vi.fn();
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    client.restore({ serverUrl: 'https://enterprise.otto.test', token: null });

    await expect(client.recordTokenUsage({
      sessionId: 'session-1', messageId: 'message-1',
      inputTokens: 1, outputTokens: 2, totalTokens: 3,
    })).rejects.toThrow('登录已失效');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('登录后把自动提炼的知识条目写入组织知识库', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'added', added: true }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(client.recordKnowledge({
      sourceId: 'kb_123',
      category: 'solution',
      content: '合同审查先核对违约条款。',
      confidence: 0.9,
    })).resolves.toEqual({ status: 'added', added: true });

    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://enterprise.otto.test/enterprise/knowledge');
    const init = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer session-token' });
    expect(JSON.parse(init.body as string)).toEqual({
      sourceId: 'kb_123',
      category: 'solution',
      content: '合同审查先核对违约条款。',
      confidence: 0.9,
    });
  });

  it('登录后从组织知识库读取企业记忆并映射字段', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        knowledge: [{
          id: 'k1',
          organization_id: 'org_acme',
          source_id: 'kb_123',
          department: '研发部',
          category: 'solution',
          content: '合同审查先核对违约条款。',
          contributor: '员工一号',
          confidence: 0.9,
          created_at: '2026-07-20T04:00:00.000Z',
        }],
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(client.listKnowledge({ query: '合同', department: '研发部' })).resolves.toEqual([{
      id: 'k1',
      organizationId: 'org_acme',
      sourceId: 'kb_123',
      title: 'solution',
      department: '研发部',
      category: 'solution',
      content: '合同审查先核对违约条款。',
      contributor: '员工一号',
      confidence: 0.9,
      sourceType: 'manual',
      sourceLabel: null,
      status: 'active',
      version: 1,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: '2026-07-20T04:00:00.000Z',
      updatedAt: '2026-07-20T04:00:00.000Z',
    }]);

    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://enterprise.otto.test/enterprise/knowledge?q=%E5%90%88%E5%90%8C&department=%E7%A0%94%E5%8F%91%E9%83%A8');
    const init = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ authorization: 'Bearer session-token' });
  });

  it('企业管理员可修订知识并读取版本历史', async () => {
    const knowledgeRow = {
      id: 12,
      organization_id: 'org_acme',
      source_id: 'manual-12',
      title: '交付检查',
      department: null,
      category: '流程',
      content: '检查备份、监控和回滚。',
      contributor: '管理员',
      confidence: 0.95,
      source_type: 'manual',
      status: 'active',
      version: 3,
      created_at: '2026-07-20T04:00:00.000Z',
      updated_at: '2026-07-21T04:00:00.000Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { knowledge: knowledgeRow }))
      .mockResolvedValueOnce(jsonResponse(200, {
        revisions: [{
          id: 31,
          knowledge_id: 12,
          version: 2,
          title: '交付检查',
          category: '流程',
          content: '检查备份和监控。',
          status: 'active',
          changed_by: '管理员',
          change_note: '补充监控',
          created_at: '2026-07-20T05:00:00.000Z',
        }],
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(client.reviseKnowledge('12', {
      title: '交付检查',
      category: '流程',
      content: '检查备份、监控和回滚。',
      changeNote: '补充回滚',
    })).resolves.toMatchObject({ id: '12', version: 3, content: knowledgeRow.content });
    expect(fetchMock.mock.calls[2]?.[0])
      .toBe('https://enterprise.otto.test/enterprise/knowledge/12');
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'PATCH' });

    await expect(client.listKnowledgeRevisions('12')).resolves.toEqual([
      expect.objectContaining({
        id: '31',
        knowledgeId: '12',
        version: 2,
        changeNote: '补充监控',
      }),
    ]);
    expect(fetchMock.mock.calls[3]?.[0])
      .toBe('https://enterprise.otto.test/enterprise/knowledge/12/revisions');
  });

  it('登录成员通过 main 内的会话令牌读取完整组织架构', async () => {
    const organizationView = {
      organization: {
        id: 'org_acme',
        name: '星河科技',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_1',
        username: 'staff01',
        name: '员工一号',
        role: '工程师',
        department: '研发部',
        isAdmin: false,
        status: 'active' as const,
      }],
      employeeCount: 1,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, organizationView));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(client.getOrganizationView()).resolves.toEqual(organizationView);
    expect(fetchMock.mock.calls[2]?.[0])
      .toBe('https://enterprise.otto.test/enterprise/organization/view');
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer session-token',
    });
  });

  it('企业在线心跳使用成员会话并要求服务端支持 presence capability', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        presence: { accountId: ACCOUNT.id, online: true, lastSeenAt: '2026-07-23T00:00:00.000Z' },
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(client.heartbeatPresence('desktop-test')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[2]?.[0])
      .toBe('https://enterprise.otto.test/enterprise/presence/heartbeat');
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ clientId: 'desktop-test' }),
    });
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer session-token',
    });
  });

  it('未登录时不会请求组织架构接口', async () => {
    const fetchMock = vi.fn();
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    client.restore({ serverUrl: 'https://enterprise.otto.test', token: null });

    await expect(client.getOrganizationView()).rejects.toThrow('登录已失效');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('登录成员使用会话令牌读取 A2A 待处理请求', async () => {
    const requests = [{
      id: 'msg_atoa_1',
      senderAccountId: 'acc_2',
      recipientAccountId: 'acc_1',
      senderDeviceId: 'peer-device',
      senderIdentitySigningPublicKey: 'peer signing key',
      protocolVersion: 1 as const,
      contentType: 'atoa_request' as const,
      inReplyToMessageId: null,
      ciphertext: 'ciphertext',
      nonce: 'nonce',
      signature: 'signature',
      envelopes: [],
      peerAccountId: 'acc_2',
      peer: {
        id: 'acc_2',
        username: 'staff02',
        name: '员工二号',
        department: '产品部',
        positionTitle: '产品经理',
        role: 'member',
      },
      content: 'OTTO_ATOA_REQUEST {"v":1,"id":"request-1","question":"现在方便吗？"}',
      createdAt: '2026-07-19T12:00:00.000Z',
      readAt: null,
      attachments: [],
    }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { requests }))
      .mockResolvedValueOnce(jsonResponse(200, { device: E2EE_DEVICE }))
      .mockResolvedValueOnce(jsonResponse(200, emptyTransparency('acc_1')))
      .mockResolvedValueOnce(jsonResponse(200, emptyTransparency('acc_2')))
      .mockResolvedValueOnce(jsonResponse(200, {
        devices: [
          E2EE_DEVICE,
          {
            ...E2EE_DEVICE,
            accountId: 'acc_2',
            deviceId: 'peer-device',
            identitySigningPublicKey: 'peer signing key',
          },
        ],
      }));
    const client = new EnterpriseClient(
      fetchMock as typeof fetch,
      () => undefined,
      mockE2eeCrypto({ decryptContent: requests[0]!.content }),
    );
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(client.listAtoaInbox()).resolves.toMatchObject([{
      id: 'msg_atoa_1',
      content: requests[0]!.content,
      peerAccountId: 'acc_2',
      e2ee: true,
    }]);
    expect(fetchMock.mock.calls[2]?.[0])
      .toBe('https://enterprise.otto.test/enterprise/atoa/inbox');
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer session-token',
    });
  });

  it('refuses to decrypt a message whose sender key differs from the pinned directory', async () => {
    const peerDevice = {
      ...E2EE_DEVICE,
      accountId: 'acc_peer',
      deviceId: 'peer-device',
      identitySigningPublicKey: 'trusted peer signing key',
    };
    const message: EnterpriseE2eeWireMessage = {
      id: 'message-substituted-key',
      senderAccountId: 'acc_peer',
      recipientAccountId: 'acc_1',
      senderDeviceId: 'peer-device',
      senderIdentitySigningPublicKey: 'substituted peer signing key',
      protocolVersion: 1,
      contentType: 'message',
      inReplyToMessageId: null,
      ciphertext: 'ciphertext',
      nonce: 'nonce',
      signature: 'signature',
      envelopes: [],
      createdAt: '2026-07-31T00:00:00.000Z',
      readAt: null,
      attachments: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          account: ACCOUNT,
          token: 'session-token',
          expiresAt: '2099-01-01',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { device: E2EE_DEVICE }))
      .mockResolvedValueOnce(jsonResponse(200, emptyTransparency('acc_1')))
      .mockResolvedValueOnce(jsonResponse(200, emptyTransparency('acc_peer')))
      .mockResolvedValueOnce(
        jsonResponse(200, { devices: [E2EE_DEVICE, peerDevice] }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { messages: [message] }));
    const e2ee = mockE2eeCrypto();
    const client = new EnterpriseClient(
      fetchMock as typeof fetch,
      () => undefined,
      e2ee,
    );
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );

    await expect(client.listDirectMessages('acc_peer')).rejects.toThrow(
      'sender key is not trusted',
    );
    expect(e2ee.decryptMessage).not.toHaveBeenCalled();
  });

  it('管理员删除账号后返回删除结果', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: { ...ACCOUNT, isAdmin: true },
        token: 'session-token',
        expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        id: 'acc_staff',
        deleted: true,
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(client.deleteAccount('acc_staff')).resolves.toEqual({
      id: 'acc_staff',
      deleted: true,
    });
    expect(fetchMock.mock.calls[2]?.[0])
      .toBe('https://enterprise.otto.test/enterprise/accounts/acc_staff');
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).method).toBe('DELETE');
  });

  it('企业管理员可读取并手动换新 7 天中心引入链接', async () => {
    const firstInvite = {
      id: 'invite_1', organizationId: 'org_acme', code: 'Ab3D-k9Pq-Z7xY',
      link: 'https://59.110.154.44:7777/enterprise/join/Ab3D-k9Pq-Z7xY', status: 'active' as const,
      defaultDepartment: null,
      departmentId: null, positionId: null, positionTitle: null, defaultRole: null,
      maxUses: null, usedCount: 0,
      issuedAt: '2026-07-14T00:00:00.000Z', expiresAt: '2026-07-21T00:00:00.000Z',
      validHours: 168 as const,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: { ...ACCOUNT, isAdmin: true }, token: 'admin-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        organization: { id: 'org_acme', name: '星河科技' }, invite: firstInvite,
      }))
      .mockResolvedValueOnce(jsonResponse(201, {
        organization: { id: 'org_acme', name: '星河科技' },
        invite: {
          ...firstInvite,
          id: 'invite_2',
          code: 'Wz8Y-m3Na-Q5pB',
          link: 'https://59.110.154.44:7777/enterprise/join/Wz8Y-m3Na-Q5pB',
        },
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'admin', 'password');

    expect((await client.getOrganizationInvite()).invite?.link)
      .toBe('https://59.110.154.44:7777/enterprise/join/Ab3D-k9Pq-Z7xY');
    expect((await client.issueOrganizationInvite()).invite.code).toBe('Wz8Y-m3Na-Q5pB');
    expect(fetchMock.mock.calls.slice(2).map(([, init]) => (init as RequestInit).method)).toEqual([
      'GET', 'POST',
    ]);
    expect((fetchMock.mock.calls[3]?.[1] as RequestInit).body)
      .toBe(JSON.stringify({
        defaultDepartment: null,
        departmentId: null,
        positionId: null,
        positionTitle: null,
        defaultRole: null,
        maxUses: null,
      }));
    expect((fetchMock.mock.calls[3]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer admin-token',
    });
  });

  it('拒绝带账号密码、查询参数或非 http(s) 协议的服务器地址', async () => {
    const client = new EnterpriseClient(vi.fn() as typeof fetch);
    for (const url of [
      'file:///tmp/server',
      'http://user:pass@example.com',
      'http://example.com?token=secret',
    ]) {
      await expect(client.loginWithPassword(url, 'a', 'b')).rejects.toThrow('服务器地址');
    }
  });

  it('公网企业服务器强制 HTTPS，但允许 localhost 供隔离开发测试', async () => {
    const client = new EnterpriseClient(vi.fn() as typeof fetch);
    await expect(client.loginWithPassword('http://59.110.154.44:7777', 'a', 'b'))
      .rejects.toThrow('公网企业服务器必须使用 HTTPS');
    await expect(client.loginWithPassword('http://example.com', 'a', 'b'))
      .rejects.toThrow('公网企业服务器必须使用 HTTPS');

    client.restore({ serverUrl: 'http://127.0.0.1:7777', token: null });
    expect(client.snapshot().serverUrl).toBe('http://127.0.0.1:7777');
    client.restore({ serverUrl: 'http://localhost:7777', token: null });
    expect(client.snapshot().serverUrl).toBe('http://localhost:7777');
  });

  it('服务端 401 时清除已恢复的失效会话', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(401, { error: '登录已失效' }));
    const client = new EnterpriseClient(
      fetchMock as typeof fetch,
    );
    client.restore({ serverUrl: 'https://otto.example.com', token: 'expired-token' });
    const session = await client.getSession();
    expect(session.account).toBeNull();
    expect(client.snapshot().token).toBeNull();
  });

  it('恢复会话遇到断网时保留服务器地址和 token，返回可重试的连接错误', async () => {
    const client = new EnterpriseClient(
      vi.fn().mockRejectedValue(new Error('socket disconnected')) as typeof fetch,
    );
    client.restore({ serverUrl: 'https://enterprise.otto.test', token: 'restored-token' });

    await expect(client.getSession()).resolves.toEqual({
      serverUrl: 'https://enterprise.otto.test',
      account: null,
      connectionError: '无法连接企业服务器：socket disconnected',
    });
    expect(client.snapshot()).toEqual({
      serverUrl: 'https://enterprise.otto.test',
      token: 'restored-token',
    });
  });

  it('任一受保护 API 返回 401 都清除 token 并通知全局会话失效', async () => {
    const onSessionInvalidated = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: { ...ACCOUNT, isAdmin: true },
        token: 'admin-token',
        expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(401, { error: '登录已失效，请重新登录' }));
    const client = new EnterpriseClient(fetchMock as typeof fetch, onSessionInvalidated);
    await client.loginWithPassword('https://enterprise.otto.test', 'admin', 'password');

    await expect(client.listAccounts()).rejects.toThrow('登录已失效，请重新登录');

    expect(client.snapshot().token).toBeNull();
    expect(onSessionInvalidated).toHaveBeenCalledOnce();
  });

  it('管理员修改自己的密码后，即使 PATCH 成功也立即退出已被服务端撤销的会话', async () => {
    const admin = { ...ACCOUNT, id: 'acc_admin', isAdmin: true };
    const onSessionInvalidated = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: admin,
        token: 'admin-token',
        expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { account: admin }));
    const client = new EnterpriseClient(fetchMock as typeof fetch, onSessionInvalidated);
    await client.loginWithPassword('https://enterprise.otto.test', 'admin', 'password');

    await expect(client.updateAccount(admin.id, { password: 'new-password' }))
      .resolves.toMatchObject({ id: admin.id });

    expect(client.snapshot().token).toBeNull();
    expect(client.authenticatedAccountSnapshot()).toBeNull();
    expect(onSessionInvalidated).toHaveBeenCalledOnce();
  });

  it('管理员自降权后不把 isAdmin=false 的更新响应当作仍有效会话', async () => {
    const admin = { ...ACCOUNT, id: 'acc_admin', isAdmin: true };
    const downgraded = { ...admin, isAdmin: false, role: 'member' };
    const onSessionInvalidated = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: admin,
        token: 'admin-token',
        expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { account: downgraded }));
    const client = new EnterpriseClient(fetchMock as typeof fetch, onSessionInvalidated);
    await client.loginWithPassword('https://enterprise.otto.test', 'admin', 'password');

    await expect(client.updateAccount(admin.id, { isAdmin: false }))
      .resolves.toEqual(downgraded);

    expect(client.snapshot().token).toBeNull();
    expect(client.authenticatedAccountSnapshot()).toBeNull();
    expect(onSessionInvalidated).toHaveBeenCalledOnce();
  });

  it('只读账号快照仅反映中心服务已验证的当前账号，且调用方不能篡改内部状态', async () => {
    const updated = { ...ACCOUNT, name: '新姓名', role: 'engineer', tags: ['updated'] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT,
        token: 'member-token',
        expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { account: updated }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    const first = client.authenticatedAccountSnapshot();
    expect(first).toEqual(ACCOUNT);
    first!.tags.push('renderer-forged');
    expect(client.authenticatedAccountSnapshot()?.tags).toEqual(['普通员工']);

    await client.updateAccount(ACCOUNT.id, { name: '新姓名', role: 'engineer' });
    expect(client.authenticatedAccountSnapshot()).toEqual(updated);
  });

  it.each([
    [{ status: 'degraded', apiVersion: 2, capabilities: API_V2_HEALTH.capabilities }],
    [{ status: 'ok', apiVersion: 1, capabilities: API_V2_HEALTH.capabilities }],
    [{ status: 'ok' }],
  ])('密码登录拒绝不兼容的旧服务器，且不会发送凭据或留下会话：%j', async (health) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, health));
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    await expect(client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    )).rejects.toThrow('企业服务器版本过旧或功能不完整，请联系管理员升级后重试');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://enterprise.otto.test/enterprise/health');
    expect(client.snapshot()).toEqual({
      serverUrl: 'https://enterprise.otto.test',
      token: null,
    });
  });

  it('请求注册验证码前验证注册与邀请能力，缺失时不发送手机号和邀请码', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, {
      ...API_V2_HEALTH,
      capabilities: ['password_auth', 'sms_registration', 'organization_invites'],
    }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    await expect(client.requestRegistrationCode(
      'https://enterprise.otto.test',
      '13800138000',
      'Ab3D-k9Pq-Z7xY',
    )).rejects.toThrow('企业服务器版本过旧或功能不完整，请联系管理员升级后重试');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(client.snapshot().token).toBeNull();
  });

  it('提交短信注册前也验证岗位邀请能力，缺失时不发送验证码和密码', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, {
      ...API_V2_HEALTH,
      capabilities: ['password_auth', 'sms_registration', 'organization_invites'],
    }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    client.restore({ serverUrl: 'https://enterprise.otto.test', token: null });

    await expect(client.registerWithSms({
      challengeId: 'sms_1',
      code: '042731',
      name: '员工一号',
      password: 'registered-password',
      legalConsent: true,
      legalDocuments: LEGAL_DOCUMENTS,
    })).rejects.toThrow('企业服务器版本过旧或功能不完整，请联系管理员升级后重试');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://enterprise.otto.test/enterprise/health');
  });

  it.each([
    {
      name: '读取私信',
      capability: 'direct_messages',
      endpoint: '/enterprise/messages/acc_peer',
      invoke: (client: EnterpriseClient) => client.listDirectMessages('acc_peer'),
    },
    {
      name: '发送私信',
      capability: 'direct_messages',
      endpoint: '/enterprise/messages/acc_peer',
      invoke: (client: EnterpriseClient) => client.sendDirectMessage('acc_peer', '你好'),
    },
    {
      name: '读取岗位邀请码',
      capability: 'position_invites',
      endpoint: '/enterprise/organization/invite',
      invoke: (client: EnterpriseClient) => client.getOrganizationInvite(),
    },
    {
      name: '签发岗位邀请码',
      capability: 'position_invites',
      endpoint: '/enterprise/organization/invite',
      invoke: (client: EnterpriseClient) => client.issueOrganizationInvite({ positionId: 'pos_brand' }),
    },
  ])('$name 在业务请求前验证 $capability 能力', async ({ capability, endpoint, invoke }) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        ...API_V2_HEALTH,
        capabilities: ['password_auth'],
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT,
        token: 'session-token',
        expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        ...API_V2_HEALTH,
        capabilities: API_V2_HEALTH.capabilities.filter((item) => item !== capability),
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(invoke(client))
      .rejects.toThrow('企业服务器版本过旧或功能不完整，请联系管理员升级后重试');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://enterprise.otto.test/enterprise/health');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(endpoint))).toBe(false);
  });

  it('发送附件时验证新能力并保留附件元数据', async () => {
    const attachment = {
      fileName: '方案.pdf',
      mimeType: 'application/pdf',
      size: 4,
      data: 'JVBERg==',
    };
    const responseMessage = {
      id: 'message-1',
      senderAccountId: 'acc_1',
      recipientAccountId: 'acc_peer',
      senderDeviceId: 'device-1',
      senderIdentitySigningPublicKey: 'test signing key',
      protocolVersion: 1 as const,
      contentType: 'message' as const,
      inReplyToMessageId: null,
      ciphertext: 'ciphertext',
      nonce: 'nonce',
      signature: 'signature',
      envelopes: [],
      createdAt: '2026-07-26T08:00:00.000Z',
      readAt: null,
      attachments: [{
        id: 'attachment-1',
        ciphertextSize: 20,
        nonce: 'attachment nonce',
      }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT,
        token: 'session-token',
        expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { device: E2EE_DEVICE }))
      .mockResolvedValueOnce(jsonResponse(200, emptyTransparency('acc_1')))
      .mockResolvedValueOnce(jsonResponse(200, emptyTransparency('acc_peer')))
      .mockResolvedValueOnce(jsonResponse(200, {
        devices: [E2EE_DEVICE, { ...E2EE_DEVICE, accountId: 'acc_peer', deviceId: 'peer-device' }],
      }))
      .mockResolvedValueOnce(jsonResponse(201, { message: responseMessage }))
      .mockResolvedValueOnce(jsonResponse(200, {
        attachment: {
          message: responseMessage,
          attachment: {
            id: 'attachment-1',
            ciphertext: 'encrypted attachment',
            nonce: 'attachment nonce',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, { device: E2EE_DEVICE }))
      .mockResolvedValueOnce(jsonResponse(200, emptyTransparency('acc_1')))
      .mockResolvedValueOnce(jsonResponse(200, emptyTransparency('acc_peer')))
      .mockResolvedValueOnce(jsonResponse(200, {
        devices: [E2EE_DEVICE, { ...E2EE_DEVICE, accountId: 'acc_peer', deviceId: 'peer-device' }],
      }));
    const e2ee = mockE2eeCrypto({
      decryptContent: '请查收',
      decryptedAttachments: [{
        id: 'attachment-1',
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        size: attachment.size,
      }],
    });
    const client = new EnterpriseClient(
      fetchMock as typeof fetch,
      () => undefined,
      e2ee,
    );
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(client.sendDirectMessage('acc_peer', '请查收', [attachment]))
      .resolves.toMatchObject({
        id: 'message-1',
        content: '请查收',
        e2ee: true,
        attachments: [{ id: 'attachment-1', fileName: attachment.fileName }],
      });
    await expect(client.getDirectMessageAttachment('attachment-1'))
      .resolves.toMatchObject({ id: 'attachment-1', data: attachment.data });

    const sendInit = fetchMock.mock.calls[6]?.[1] as RequestInit;
    expect(String(sendInit.body)).not.toContain('请查收');
    expect(String(sendInit.body)).not.toContain('方案.pdf');
    expect(fetchMock.mock.calls[7]?.[0]).toBe(
      'https://enterprise.otto.test/enterprise/message-attachments/attachment-1',
    );
  });

  it('园区服务请求兼容旧服务器能力列表，不因缺少 park_service_push 预先失效', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        ...API_V2_HEALTH,
        capabilities: API_V2_HEALTH.capabilities.filter((item) => item !== 'park_service_push'),
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT,
        token: 'session-token',
        expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(201, { recipientCount: 1 }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(client.pushParkService({
      recipientAccountId: 'acc_peer',
      serviceId: 'announcement',
    })).resolves.toEqual({ recipientCount: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://enterprise.otto.test/enterprise/park-services/push');
  });

  it('园区视图读取直接请求业务接口，不因旧 health capabilities 缺 park_membership_v1 隐藏入口', async () => {
    const park = {
      id: 'park_hc',
      name: '宏创园区',
      slug: 'hongchuang',
      brandName: '宏创园区服务',
      adminOrganizationId: 'org_acme',
      status: 'active' as const,
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
      services: [],
      tenantOrganizations: [],
      specialists: [],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { park }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    client.restore({ serverUrl: 'https://enterprise.otto.test', token: 'session-token' });

    await expect(client.getParkView()).resolves.toEqual(park);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://enterprise.otto.test/enterprise/park/view');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer session-token',
    });
  });

  it('恢复会话遇到旧服务器时保留服务器地址和 token，并返回明确的升级提示', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { status: 'ok' }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    client.restore({ serverUrl: 'https://enterprise.otto.test', token: 'restored-token' });

    await expect(client.getSession()).resolves.toEqual({
      serverUrl: 'https://enterprise.otto.test',
      account: null,
      connectionError: '企业服务器版本过旧或功能不完整，请联系管理员升级后重试',
    });
    expect(client.snapshot()).toEqual({
      serverUrl: 'https://enterprise.otto.test',
      token: 'restored-token',
    });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty('authorization');
  });

  it('同一服务器复用成功握手，切换服务器地址后重新验证', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'server-a-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'server-a-token-2', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'server-b-token', expiresAt: '2099-01-01',
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    await client.loginWithPassword('https://a.otto.test', 'staff01', 'password');
    await client.loginWithPassword('https://a.otto.test/', 'staff01', 'password');
    await client.loginWithPassword('https://b.otto.test', 'staff01', 'password');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://a.otto.test/enterprise/health',
      'https://a.otto.test/enterprise/auth/login',
      'https://a.otto.test/enterprise/auth/login',
      'https://b.otto.test/enterprise/health',
      'https://b.otto.test/enterprise/auth/login',
    ]);
    expect(client.snapshot()).toEqual({
      serverUrl: 'https://b.otto.test',
      token: 'server-b-token',
    });
  });

  it('切换服务器时取消旧健康检查，绝不把旧登录凭据发往新服务器', async () => {
    const firstHealth = deferred<Response>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://a.otto.test/enterprise/health') return firstHealth.promise;
      if (url === 'https://b.otto.test/enterprise/health') {
        return Promise.resolve(jsonResponse(200, API_V2_HEALTH));
      }
      if (url === 'https://b.otto.test/enterprise/auth/login') {
        return Promise.resolve(jsonResponse(200, {
          account: { ...ACCOUNT, id: 'acc_b', username: 'staff-b' },
          token: 'server-b-token',
          expiresAt: '2099-01-01',
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    const staleLogin = client.loginWithPassword('https://a.otto.test', 'staff-a', 'password-a');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await expect(client.loginWithPassword('https://b.otto.test', 'staff-b', 'password-b'))
      .resolves.toMatchObject({ account: { id: 'acc_b' } });

    firstHealth.resolve(jsonResponse(200, API_V2_HEALTH));
    await expect(staleLogin).rejects.toThrow('认证操作已被新的请求替代');

    expect(fetchMock.mock.calls.map(([url]) => String(url))).not
      .toContain('https://a.otto.test/enterprise/auth/login');
    expect(client.snapshot()).toEqual({
      serverUrl: 'https://b.otto.test',
      token: 'server-b-token',
    });
  });

  it('旧登录响应晚到时不能覆盖较新的服务器 token 和账号', async () => {
    const firstLogin = deferred<Response>();
    const accountB = { ...ACCOUNT, id: 'acc_b', username: 'staff-b' };
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/enterprise/health')) {
        return Promise.resolve(jsonResponse(200, API_V2_HEALTH));
      }
      if (url === 'https://a.otto.test/enterprise/auth/login') return firstLogin.promise;
      if (url === 'https://b.otto.test/enterprise/auth/login') {
        return Promise.resolve(jsonResponse(200, {
          account: accountB, token: 'server-b-token', expiresAt: '2099-01-01',
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    const staleLogin = client.loginWithPassword('https://a.otto.test', 'staff-a', 'password-a');
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(
      ([url]) => String(url) === 'https://a.otto.test/enterprise/auth/login',
    )).toBe(true));
    await client.loginWithPassword('https://b.otto.test', 'staff-b', 'password-b');

    firstLogin.resolve(jsonResponse(200, {
      account: { ...ACCOUNT, id: 'acc_a', username: 'staff-a' },
      token: 'server-a-token',
      expiresAt: '2099-01-01',
    }));
    await expect(staleLogin).rejects.toThrow('认证操作已被新的请求替代');

    expect(client.snapshot()).toEqual({
      serverUrl: 'https://b.otto.test',
      token: 'server-b-token',
    });
  });

  it('旧注册响应晚到时不能覆盖更新的登录会话', async () => {
    const staleRegistration = deferred<Response>();
    const accountB = { ...ACCOUNT, id: 'acc_b', username: 'staff-b' };
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/enterprise/health')) {
        return Promise.resolve(jsonResponse(200, API_V2_HEALTH));
      }
      if (url === 'https://a.otto.test/enterprise/auth/register/sms/request') {
        return Promise.resolve(jsonResponse(200, {
          challengeId: 'sms_a',
          expiresAt: '2099-01-01',
          retryAfterSeconds: 60,
          message: '已发送',
          organization: { id: 'org_a', name: '企业 A' },
        }));
      }
      if (url === 'https://a.otto.test/enterprise/auth/register/sms/verify') {
        return staleRegistration.promise;
      }
      if (url === 'https://b.otto.test/enterprise/auth/login') {
        return Promise.resolve(jsonResponse(200, {
          account: accountB, token: 'server-b-token', expiresAt: '2099-01-01',
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    await client.requestRegistrationCode('https://a.otto.test', '13800138000', 'Ab3D-k9Pq-Z7xY');
    const staleRegister = client.registerWithSms({
      challengeId: 'sms_a',
      code: '123456',
      name: '员工 A',
      password: 'password-a',
      legalConsent: true,
      legalDocuments: LEGAL_DOCUMENTS,
    });
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(
      ([url]) => String(url) === 'https://a.otto.test/enterprise/auth/register/sms/verify',
    )).toBe(true));
    await client.loginWithPassword('https://b.otto.test', 'staff-b', 'password-b');

    staleRegistration.resolve(jsonResponse(200, {
      account: { ...ACCOUNT, id: 'acc_a', username: 'staff-a' },
      token: 'server-a-token',
      expiresAt: '2099-01-01',
    }));
    await expect(staleRegister).rejects.toThrow('认证操作已被新的请求替代');
    expect(client.snapshot()).toEqual({
      serverUrl: 'https://b.otto.test',
      token: 'server-b-token',
    });
  });

  it('旧恢复请求返回 401 时不能清除后来登录的新会话', async () => {
    const staleSession = deferred<Response>();
    const onSessionInvalidated = vi.fn();
    const accountB = { ...ACCOUNT, id: 'acc_b', username: 'staff-b' };
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/enterprise/health')) {
        return Promise.resolve(jsonResponse(200, API_V2_HEALTH));
      }
      if (url === 'https://a.otto.test/enterprise/auth/me') return staleSession.promise;
      if (url === 'https://b.otto.test/enterprise/auth/login') {
        return Promise.resolve(jsonResponse(200, {
          account: accountB, token: 'server-b-token', expiresAt: '2099-01-01',
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const client = new EnterpriseClient(fetchMock as typeof fetch, onSessionInvalidated);
    client.restore({ serverUrl: 'https://a.otto.test', token: 'restored-a-token' });

    const restoring = client.getSession();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(
      ([url]) => String(url) === 'https://a.otto.test/enterprise/auth/me',
    )).toBe(true));
    await client.loginWithPassword('https://b.otto.test', 'staff-b', 'password-b');

    staleSession.resolve(jsonResponse(401, { error: '旧 token 已失效' }));
    await expect(restoring).resolves.toMatchObject({
      serverUrl: 'https://b.otto.test',
      account: accountB,
    });
    expect(client.snapshot().token).toBe('server-b-token');
    expect(onSessionInvalidated).not.toHaveBeenCalled();
  });

  it('远端退出断网时仍持久化已经清空的本地 token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }))
      .mockRejectedValueOnce(new Error('network offline'));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');
    const persistedSnapshots: Array<ReturnType<typeof client.snapshot>> = [];

    await expect(logoutAndPersistEnterpriseSession(
      client,
      () => persistedSnapshots.push(client.snapshot()),
    )).rejects.toThrow('network offline');

    expect(persistedSnapshots).toEqual([{
      serverUrl: 'https://enterprise.otto.test',
      token: null,
    }]);
  });

  it('通过受版本保护的企业 Skill 市场协议查询、投稿、安装、评分和读取榜单', async () => {
    const marketHealth = {
      ...API_V2_HEALTH,
      capabilities: [...API_V2_HEALTH.capabilities, 'enterprise_skill_market_v1'],
    };
    const skill = {
      id: 'skill-1', organizationId: 'org_acme', slug: 'monthly-report', name: '月报整理',
      description: '整理月报', department: '财务部', visibility: 'department', status: 'active',
      authorAccountId: 'author-1', authorName: '张悦', contentHash: 'hash', version: 1,
      installCount: 1, usageCount: 2, successCount: 2, failureCount: 0,
      rating: 5, ratingCount: 1, installedVersion: null,
      reviewedBy: '管理员', reviewedAt: '2026-07-30', createdAt: '2026-07-30', updatedAt: '2026-07-30',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, marketHealth))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { skills: [skill] }))
      .mockResolvedValueOnce(jsonResponse(201, { outcome: 'submitted', skill }))
      .mockResolvedValueOnce(jsonResponse(200, { skill: { ...skill, content: '# 月报整理' } }))
      .mockResolvedValueOnce(jsonResponse(200, { skill: { ...skill, rating: 4 } }))
      .mockResolvedValueOnce(jsonResponse(200, { skill: { ...skill, usageCount: 3 } }))
      .mockResolvedValueOnce(jsonResponse(200, {
        skills: [{ ...skill, rank: 1, score: 90, successRate: 1 }], contributors: [], generatedAt: '2026-07-30',
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(client.listEnterpriseSkills({ scope: 'department', query: '月报', sort: 'rating' }))
      .resolves.toEqual([skill]);
    await client.submitEnterpriseSkill({
      name: '月报整理', description: '整理月报', content: '# 月报整理', visibility: 'department',
    });
    await client.installEnterpriseSkill('skill-1');
    await client.rateEnterpriseSkill('skill-1', 4);
    await client.recordEnterpriseSkillUsage('skill-1', true, 'a'.repeat(64));
    await expect(client.getEnterpriseSkillLeaderboard()).resolves.toMatchObject({
      skills: [expect.objectContaining({ id: 'skill-1', rank: 1 })],
    });

    expect(fetchMock.mock.calls.slice(2).map(([url]) => url)).toEqual([
      'https://enterprise.otto.test/enterprise/skills?scope=department&q=%E6%9C%88%E6%8A%A5&sort=rating',
      'https://enterprise.otto.test/enterprise/skills',
      'https://enterprise.otto.test/enterprise/skills/skill-1/install',
      'https://enterprise.otto.test/enterprise/skills/skill-1/rating',
      'https://enterprise.otto.test/enterprise/skills/skill-1/usage',
      'https://enterprise.otto.test/enterprise/skills/leaderboard',
    ]);
    expect(JSON.parse((fetchMock.mock.calls[3]?.[1] as RequestInit).body as string)).toMatchObject({
      name: '月报整理', visibility: 'department',
    });
    expect(JSON.parse((fetchMock.mock.calls[5]?.[1] as RequestInit).body as string)).toEqual({ score: 4 });
    expect(JSON.parse((fetchMock.mock.calls[6]?.[1] as RequestInit).body as string)).toEqual({
      success: true,
      eventId: 'a'.repeat(64),
    });
  });

  it('uploads E2EE ciphertext before sending PostgreSQL attachment references', async () => {
    const ciphertext = Buffer.alloc(32, 5);
    const checksum = createHash('sha256').update(ciphertext).digest('hex');
    const encryptedAttachment = {
      id: 'attachment-s3-1',
      ciphertext: ciphertext.toString('base64'),
      nonce: Buffer.alloc(12, 3).toString('base64'),
    };
    const responseMessage: EnterpriseE2eeWireMessage = {
      id: 'message-1',
      senderAccountId: 'acc_1',
      recipientAccountId: 'acc_peer',
      senderDeviceId: 'device-1',
      senderIdentitySigningPublicKey: 'test signing key',
      protocolVersion: 1,
      contentType: 'message',
      inReplyToMessageId: null,
      ciphertext: 'ciphertext',
      nonce: 'nonce',
      signature: 'signature',
      envelopes: [],
      createdAt: '2026-08-01T00:00:00.000Z',
      readAt: null,
      attachments: [
        {
          id: encryptedAttachment.id,
          ciphertextSize: ciphertext.length,
          nonce: encryptedAttachment.nonce,
        },
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        ...API_V2_HEALTH,
        capabilities: [
          ...API_V2_HEALTH.capabilities,
          'e2ee_attachment_objects_v1',
        ],
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT,
        token: 'session-token',
        expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { device: E2EE_DEVICE }))
      .mockResolvedValueOnce(jsonResponse(200, emptyTransparency('acc_1')))
      .mockResolvedValueOnce(jsonResponse(200, emptyTransparency('acc_peer')))
      .mockResolvedValueOnce(jsonResponse(200, {
        devices: [
          E2EE_DEVICE,
          { ...E2EE_DEVICE, accountId: 'acc_peer', deviceId: 'peer-device' },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse(201, {
        attachment: {
          id: encryptedAttachment.id,
          ciphertextBytes: ciphertext.length,
          ciphertextSha256: checksum,
        },
      }))
      .mockResolvedValueOnce(jsonResponse(201, { message: responseMessage }));
    const client = new EnterpriseClient(
      fetchMock as typeof fetch,
      () => undefined,
      mockE2eeCrypto({ encryptedAttachments: [encryptedAttachment] }),
    );
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );

    await client.sendDirectMessage('acc_peer', 'encrypted attachment', [
      {
        fileName: 'private.bin',
        mimeType: 'application/octet-stream',
        size: 16,
        data: Buffer.alloc(16).toString('base64'),
      },
    ]);

    expect(fetchMock.mock.calls[6]?.[0]).toBe(
      'https://enterprise.otto.test/enterprise/attachments/inline',
    );
    const uploadBody = JSON.parse(
      String((fetchMock.mock.calls[6]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(uploadBody).toMatchObject({
      peerAccountId: 'acc_peer',
      attachmentId: encryptedAttachment.id,
      ciphertextSha256: checksum,
    });
    const messageBody = JSON.parse(
      String((fetchMock.mock.calls[7]?.[1] as RequestInit).body),
    ) as {
      attachments: unknown[];
      attachmentReferences: unknown[];
    };
    expect(messageBody.attachments).toEqual([]);
    expect(messageBody.attachmentReferences).toEqual([
      {
        id: encryptedAttachment.id,
        nonce: encryptedAttachment.nonce,
        ciphertextBytes: ciphertext.length,
        ciphertextSha256: checksum,
      },
    ]);
    expect(JSON.stringify(messageBody)).not.toContain(
      encryptedAttachment.ciphertext,
    );
  });

  it('uploads an MLS attachment through resumable presigned multipart requests', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-mls-upload-'));
    const ciphertextPath = path.join(directory, 'ciphertext.bin');
    const ciphertext = Buffer.alloc(96, 7);
    fs.writeFileSync(ciphertextPath, ciphertext);
    const checksum = createHash('sha256').update(ciphertext).digest('hex');
    const attachmentId =
      'mls-attachment-018f0000-0000-7000-8000-000000000020';
    const manifest = {
      format: 1 as const,
      cipher: 'aes-256-gcm-chunked' as const,
      id: attachmentId,
      fileName: 'secret.bin',
      mimeType: 'application/octet-stream',
      plaintextBytes: 80,
      ciphertextBytes: ciphertext.length,
      ciphertextSha256: checksum,
      chunkBytes: 64 * 1024,
      chunkCount: 1,
      dek: Buffer.alloc(32, 1).toString('base64'),
      noncePrefix: Buffer.alloc(8, 2).toString('base64'),
      binding: {
        organizationId: 'org_1',
        conversationId: 'a'.repeat(64),
        sessionGeneration: 2,
        groupId: Buffer.from('group-a').toString('base64'),
        epoch: 4,
        messageId: 'mls-message-018f0000-0000-7000-8000-000000000021',
      },
      object: {
        id: attachmentId,
        ciphertextBytes: ciphertext.length,
        ciphertextSha256: checksum,
      },
    };
    let uploadedCiphertext: Buffer | null = null;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...API_V2_HEALTH,
          capabilities: [
            ...API_V2_HEALTH.capabilities,
            'e2ee_mls_transport_v1',
            'e2ee_attachment_objects_v1',
            's3_multipart_uploads_v1',
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          account: ACCOUNT,
          token: 'session-token',
          expiresAt: '2099-01-01',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(404, { error: 'attachment access denied' }),
      )
      .mockResolvedValueOnce(
        jsonResponse(201, { upload: { attachmentId } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          request: {
            method: 'PUT',
            url: 'https://private-s3.test/upload-part',
            expiresInSeconds: 300,
            requiredHeaders: {
              'content-length': String(ciphertext.length),
              'x-amz-checksum-sha256': Buffer.from(checksum, 'hex').toString(
                'base64',
              ),
            },
          },
        }),
      )
      .mockImplementationOnce((_url, init) => {
        uploadedCiphertext = Buffer.from(init?.body as Buffer);
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { etag: '"part-1"' },
          }),
        );
      })
      .mockResolvedValueOnce(jsonResponse(200, { recorded: true }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          attachment: {
            id: attachmentId,
            ciphertextBytes: ciphertext.length,
            ciphertextSha256: checksum,
          },
        }),
      );
    const client = new EnterpriseClient(
      fetchMock as typeof fetch,
      () => undefined,
    );
    try {
      await client.loginWithPassword(
        'https://enterprise.otto.test',
        'staff01',
        'password',
      );
      await expect(
        client.uploadMlsAttachmentObject({
          peerAccountId: 'acc_peer',
          deviceId: 'device-1',
          manifest,
          ciphertextPath,
          authorizedDevices: [
            { accountId: 'acc_1', deviceId: 'device-1' },
            { accountId: 'acc_peer', deviceId: 'peer-device' },
          ],
        }),
      ).resolves.toEqual(manifest.object);
      expect(fetchMock.mock.calls[2]?.[0]).toContain(
        `/enterprise/attachments/${attachmentId}/resume`,
      );
      expect(fetchMock.mock.calls[3]?.[0]).toBe(
        'https://enterprise.otto.test/enterprise/attachments/uploads',
      );
      expect(fetchMock.mock.calls[5]?.[0]).toBe(
        'https://private-s3.test/upload-part',
      );
      expect(uploadedCiphertext).toEqual(ciphertext);
      const initBody = JSON.parse(
        String((fetchMock.mock.calls[3]?.[1] as RequestInit).body),
      ) as Record<string, unknown>;
      expect(initBody).toMatchObject({
        peerAccountId: 'acc_peer',
        deviceId: 'device-1',
        attachmentId,
        ciphertextBytes: ciphertext.length,
        ciphertextSha256: checksum,
        mlsBinding: manifest.binding,
      });
      expect(JSON.stringify(initBody)).not.toContain(manifest.dek);
      expect(JSON.stringify(initBody)).not.toContain(manifest.fileName);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('streams and verifies an MLS object download before local decryption', async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-mls-download-'),
    );
    const ciphertextPath = path.join(directory, 'ciphertext.bin');
    const ciphertext = Buffer.alloc(96, 9);
    const checksum = createHash('sha256').update(ciphertext).digest('hex');
    const attachmentId =
      'mls-attachment-018f0000-0000-7000-8000-000000000030';
    const manifest = {
      format: 1 as const,
      cipher: 'aes-256-gcm-chunked' as const,
      id: attachmentId,
      fileName: 'secret.bin',
      mimeType: 'application/octet-stream',
      plaintextBytes: 80,
      ciphertextBytes: 96,
      ciphertextSha256: checksum,
      chunkBytes: 64 * 1024,
      chunkCount: 1,
      dek: Buffer.alloc(32, 1).toString('base64'),
      noncePrefix: Buffer.alloc(8, 2).toString('base64'),
      binding: {
        organizationId: 'org_1',
        conversationId: 'a'.repeat(64),
        sessionGeneration: 2,
        groupId: Buffer.from('group-a').toString('base64'),
        epoch: 4,
        messageId: 'mls-message-018f0000-0000-7000-8000-000000000031',
      },
      object: {
        id: attachmentId,
        ciphertextBytes: 96,
        ciphertextSha256: checksum,
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...API_V2_HEALTH,
          capabilities: [
            ...API_V2_HEALTH.capabilities,
            'e2ee_mls_transport_v1',
            'e2ee_attachment_objects_v1',
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          account: ACCOUNT,
          token: 'session-token',
          expiresAt: '2099-01-01',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          attachment: {
            kind: 'presigned',
            ciphertextBytes: 96,
            ciphertextSha256: checksum,
            encryption: 'mls-client-v1',
            request: {
              method: 'GET',
              url: 'https://private-s3.test/download',
              expiresInSeconds: 300,
              requiredHeaders: {},
            },
          },
        }),
      )
      .mockResolvedValueOnce(new Response(ciphertext, { status: 200 }));
    const client = new EnterpriseClient(
      fetchMock as typeof fetch,
      () => undefined,
    );
    try {
      await client.loginWithPassword(
        'https://enterprise.otto.test',
        'staff01',
        'password',
      );
      await expect(
        client.downloadMlsAttachmentObject({
          peerAccountId: 'acc_peer',
          deviceId: 'device-1',
          manifest,
          ciphertextPath,
        }),
      ).resolves.toEqual(manifest.object);
      expect(fs.readFileSync(ciphertextPath)).toEqual(ciphertext);
      expect(fetchMock.mock.calls[2]?.[0]).toContain(
        `peerAccountId=acc_peer&deviceId=device-1`,
      );
      expect(fetchMock.mock.calls[3]?.[0]).toBe(
        'https://private-s3.test/download',
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('stops before local decryption when a presigned attachment fails integrity checks', async () => {
    const responseMessage: EnterpriseE2eeWireMessage = {
      id: 'message-1',
      senderAccountId: 'acc_peer',
      recipientAccountId: 'acc_1',
      senderDeviceId: 'peer-device',
      senderIdentitySigningPublicKey: 'test signing key',
      protocolVersion: 1,
      contentType: 'message',
      inReplyToMessageId: null,
      ciphertext: 'ciphertext',
      nonce: 'nonce',
      signature: 'signature',
      envelopes: [],
      createdAt: '2026-08-01T00:00:00.000Z',
      readAt: null,
      attachments: [
        {
          id: 'attachment-s3-1',
          ciphertextSize: 32,
          nonce: Buffer.alloc(12, 3).toString('base64'),
        },
      ],
    };
    const e2ee = mockE2eeCrypto();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT,
        token: 'session-token',
        expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        attachment: {
          message: responseMessage,
          attachment: {
            id: 'attachment-s3-1',
            nonce: Buffer.alloc(12, 3).toString('base64'),
            ciphertextBytes: 32,
            ciphertextSha256: '0'.repeat(64),
            download: {
              method: 'GET',
              url: 'https://objects.otto.test/signed-object',
              expiresInSeconds: 120,
              requiredHeaders: {},
            },
          },
        },
      }))
      .mockResolvedValueOnce(
        new Response(Buffer.alloc(32, 9), { status: 200 }),
      );
    const client = new EnterpriseClient(
      fetchMock as typeof fetch,
      () => undefined,
      e2ee,
    );
    await client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    );

    await expect(
      client.getDirectMessageAttachment('attachment-s3-1'),
    ).rejects.toThrow('shared attachment download integrity check failed');
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      'https://objects.otto.test/signed-object',
    );
    expect(e2ee.decryptAttachment).not.toHaveBeenCalled();
  });
});
