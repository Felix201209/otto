/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EnterpriseMlsPrivateMessageService,
  FileEnterpriseMlsMessageHistory,
  type EnterpriseMlsPrivateMessageCoordinator,
} from './enterprise-mls-private-messages.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function coordinator(): EnterpriseMlsPrivateMessageCoordinator {
  return {
    activeScope: () => ({
      serverUrl: 'https://enterprise.example.test',
      organizationId: 'org-a',
      accountId: 'alice',
      deviceId: 'alice-device',
    }),
    establishDirectSession: vi.fn(async () => ({
      state: 'ready' as const,
      group: {
        protocol: 'mls10-openmls-0.8' as const,
        conversation_id: 'conversation-a',
        group_id: 'group-a',
        epoch: 1,
        member_count: 2,
      },
    })),
    refreshEpoch: vi.fn(async () => undefined),
    sendApplication: vi.fn(async () => ({
      sequence: 1,
      eventId: 'transport-event-a',
      conversationId: 'conversation-a',
      sessionGeneration: 1,
      senderAccountId: 'alice',
      senderDeviceId: 'alice-device',
      recipientAccountId: null,
      recipientDeviceId: null,
      eventType: 'application' as const,
      epoch: 1,
      groupId: 'group-a',
      payload: 'ciphertext',
      keyPackageReference: null,
      createdAt: '2026-08-03T00:00:01.000Z',
      expiresAt: '2026-11-01T00:00:01.000Z',
    })),
    poll: vi.fn(async () => ({
      previousSequence: 0,
      nextSequence: 0,
      processedEvents: 0,
      messages: [],
    })),
    acknowledgeReceivedApplication: vi.fn(async () => undefined),
    listActiveConversationPeers: vi.fn(async () => ['bob']),
    resetDirectSession: vi.fn(async () => undefined),
  };
}

function history(): FileEnterpriseMlsMessageHistory {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-mls-chat-'));
  temporaryDirectories.push(directory);
  return new FileEnterpriseMlsMessageHistory({
    directory,
    secureStorage: {
      assertAvailable: () => undefined,
      protect: (value) => `protected:${value}`,
      unprotect: (value) => value.slice('protected:'.length),
    },
  });
}

describe('EnterpriseMlsPrivateMessageService', () => {
  it('persists an outgoing message before sending it through MLS', async () => {
    const transport = coordinator();
    const store = history();
    const service = new EnterpriseMlsPrivateMessageService(transport, store, {
      randomId: () => '018f0000-0000-7000-8000-000000000001',
      now: () => new Date('2026-08-03T00:00:00.000Z'),
    });

    const message = await service.send('bob', 'secret message');

    expect(message).toMatchObject({
      id: 'mls-message-018f0000-0000-7000-8000-000000000001',
      senderAccountId: 'alice',
      recipientAccountId: 'bob',
      content: 'secret message',
      e2ee: true,
      e2eeProtocol: 'mls10-openmls-0.8',
    });
    expect(transport.sendApplication).toHaveBeenCalledOnce();
    expect(transport.refreshEpoch).toHaveBeenCalledWith('bob');
    const plaintext = Buffer.from(
      vi.mocked(transport.sendApplication).mock.calls[0]![1],
    ).toString('utf8');
    expect(JSON.parse(plaintext)).toMatchObject({
      format: 1,
      id: message.id,
      senderAccountId: 'alice',
      recipientAccountId: 'bob',
      content: 'secret message',
    });
    expect(await service.list('bob')).toEqual([message]);
  });

  it('stores a received plaintext durably before acknowledging the native inbox', async () => {
    const transport = coordinator();
    const received = {
      format: 1,
      id: 'mls-message-018f0000-0000-7000-8000-000000000002',
      senderAccountId: 'bob',
      recipientAccountId: 'alice',
      content: 'received secret',
      contentType: 'message',
      inReplyToMessageId: null,
      createdAt: '2026-08-03T00:00:02.000Z',
    };
    vi.mocked(transport.poll).mockResolvedValue({
      previousSequence: 0,
      nextSequence: 1,
      processedEvents: 1,
      messages: [
        {
          sequence: 1,
          eventId: 'transport-event-b',
          senderAccountId: 'bob',
          senderDeviceId: 'bob-device',
          plaintext: Buffer.from(JSON.stringify(received)),
          createdAt: '2026-08-03T00:00:03.000Z',
        },
      ],
    });
    const store = history();
    const service = new EnterpriseMlsPrivateMessageService(transport, store);

    expect(await service.list('bob')).toEqual([
      expect.objectContaining({
        id: received.id,
        senderAccountId: 'bob',
        content: 'received secret',
      }),
    ]);
    expect(transport.acknowledgeReceivedApplication).toHaveBeenCalledWith(
      'bob',
      'transport-event-b',
    );
  });

  it('does not acknowledge plaintext when durable history persistence fails', async () => {
    const transport = coordinator();
    vi.mocked(transport.poll).mockResolvedValue({
      previousSequence: 0,
      nextSequence: 1,
      processedEvents: 1,
      messages: [
        {
          sequence: 1,
          eventId: 'transport-event-c',
          senderAccountId: 'bob',
          senderDeviceId: 'bob-device',
          plaintext: Buffer.from(
            JSON.stringify({
              format: 1,
              id: 'mls-message-018f0000-0000-7000-8000-000000000003',
              senderAccountId: 'bob',
              recipientAccountId: 'alice',
              content: 'must survive',
              contentType: 'message',
              inReplyToMessageId: null,
              createdAt: '2026-08-03T00:00:02.000Z',
            }),
          ),
          createdAt: '2026-08-03T00:00:03.000Z',
        },
      ],
    });
    const service = new EnterpriseMlsPrivateMessageService(transport, {
      list: vi.fn(async () => []),
      put: vi.fn(async () => {
        throw new Error('disk full');
      }),
      pendingOutgoing: vi.fn(async () => []),
      markOutgoingDelivered: vi.fn(async () => undefined),
      markRead: vi.fn(async () => undefined),
      unread: vi.fn(async () => []),
    });

    await expect(service.list('bob')).rejects.toThrow('disk full');
    expect(transport.acknowledgeReceivedApplication).not.toHaveBeenCalled();
  });

  it('rejects attachments instead of falling back to the legacy envelope protocol', async () => {
    const transport = coordinator();
    const service = new EnterpriseMlsPrivateMessageService(
      transport,
      history(),
    );

    await expect(
      service.send('bob', 'file', [
        {
          fileName: 'secret.txt',
          mimeType: 'text/plain',
          size: 6,
          data: Buffer.from('secret').toString('base64'),
        },
      ]),
    ).rejects.toThrow('MLS attachment transport is not active');
    expect(transport.sendApplication).not.toHaveBeenCalled();
  });

  it('exposes an explicit peer-bound MLS security-state reset', async () => {
    const transport = coordinator();
    const service = new EnterpriseMlsPrivateMessageService(
      transport,
      history(),
    );

    await expect(service.reset('bob')).resolves.toBeUndefined();
    expect(transport.resetDirectSession).toHaveBeenCalledWith('bob');
    await expect(service.reset('alice')).rejects.toThrow(
      'peer account is invalid',
    );
  });
});

describe('FileEnterpriseMlsMessageHistory', () => {
  it('never writes message plaintext or the unwrapped history key to disk', async () => {
    const store = history();
    const scope = coordinator().activeScope();
    await store.put(scope, 'bob', {
      id: 'mls-message-018f0000-0000-7000-8000-000000000004',
      senderAccountId: 'alice',
      recipientAccountId: 'bob',
      content: 'plaintext must not appear',
      createdAt: '2026-08-03T00:00:00.000Z',
      readAt: '2026-08-03T00:00:00.000Z',
      e2ee: true,
      e2eeProtocol: 'mls10-openmls-0.8',
      contentType: 'message',
      inReplyToMessageId: null,
      deliveryState: 'delivered',
    });

    const files = fs.readdirSync(temporaryDirectories.at(-1)!);
    expect(files).toHaveLength(1);
    const serialized = fs.readFileSync(
      path.join(temporaryDirectories.at(-1)!, files[0]!),
      'utf8',
    );
    expect(serialized).not.toContain('plaintext must not appear');
    expect(serialized).not.toMatch(/"content"/);
    expect(JSON.parse(serialized)).toMatchObject({
      format: 1,
      keyProtection: 'os-secure-storage',
      cipher: 'aes-256-gcm',
    });
  });
});
