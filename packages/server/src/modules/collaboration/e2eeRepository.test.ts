/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { applyDatabaseSchemaContributors, Database } from '../data_platform/index.js';
import { COLLABORATION_SCHEMA_CONTRIBUTOR } from './collaborationSchema.js';
import {
  E2EE_PROTOCOL_VERSION,
  createE2eeFacade,
  e2eeMessageSignaturePayload,
  type E2eeMessageEnvelope,
  type SendE2eeDirectMessageInput,
} from './e2eeRepository.js';

function publicPem(key: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );
    INSERT INTO organizations (id) VALUES ('org-a'), ('org-b');
    INSERT INTO accounts (id, organization_id, name, status) VALUES
      ('alice', 'org-a', 'Alice', 'active'),
      ('bob', 'org-a', 'Bob', 'active'),
      ('carol', 'org-a', 'Carol', 'active'),
      ('mallory', 'org-b', 'Mallory', 'active');
  `);
  applyDatabaseSchemaContributors(database, [COLLABORATION_SCHEMA_CONTRIBUTOR]);
  return database;
}

function createHarness() {
  const database = createDatabase();
  const facade = createE2eeFacade({
    db: () => database,
    getActiveAccountInOrganization(accountId, organizationId) {
      return database.prepare(
        `SELECT id, name FROM accounts
         WHERE id = ? AND organization_id = ? AND status = 'active'`,
      ).get(accountId, organizationId) as { id: string; name: string } | undefined ?? null;
    },
  });
  const devices = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  const register = (accountId: string, deviceId: string) => {
    const signing = generateKeyPairSync('ed25519');
    const exchange = generateKeyPairSync('x25519');
    devices.set(`${accountId}:${deviceId}:signing`, signing);
    facade.registerE2eeDevice({
      organizationId: 'org-a',
      accountId,
      deviceId,
      deviceName: `${accountId} laptop`,
      identitySigningPublicKey: publicPem(signing.publicKey),
      deviceExchangePublicKey: publicPem(exchange.publicKey),
    });
    return { signing, exchange };
  };
  const envelope = (accountId: string, deviceId: string): E2eeMessageEnvelope => ({
    accountId,
    deviceId,
    ephemeralPublicKey: publicPem(generateKeyPairSync('x25519').publicKey),
    wrappedKey: Buffer.alloc(48, deviceId.charCodeAt(0)).toString('base64'),
    nonce: Buffer.alloc(12, accountId.charCodeAt(0)).toString('base64'),
  });
  const signedMessage = (overrides: Partial<SendE2eeDirectMessageInput> = {}) => {
    const unsigned: Omit<SendE2eeDirectMessageInput, 'signature'> = {
      organizationId: 'org-a',
      senderAccountId: 'alice',
      recipientAccountId: 'bob',
      messageId: 'message-1',
      senderDeviceId: 'alice-device-1',
      protocolVersion: E2EE_PROTOCOL_VERSION,
      contentType: 'message',
      inReplyToMessageId: null,
      ciphertext: Buffer.from('ciphertext-plus-auth-tag-value').toString('base64'),
      nonce: Buffer.alloc(12, 7).toString('base64'),
      envelopes: [
        envelope('alice', 'alice-device-1'),
        envelope('bob', 'bob-device-1'),
        ...(devices.has('bob:bob-device-2:signing')
          ? [envelope('bob', 'bob-device-2')]
          : []),
      ],
      attachments: [],
      ...overrides,
    };
    const signing = devices.get(`${unsigned.senderAccountId}:${unsigned.senderDeviceId}:signing`);
    if (!signing) throw new Error('test signing device is missing');
    return {
      ...unsigned,
      signature: sign(null, e2eeMessageSignaturePayload(unsigned), signing.privateKey)
        .toString('base64'),
    } satisfies SendE2eeDirectMessageInput;
  };
  return { database, facade, register, signedMessage };
}

describe('server-side E2EE repository', () => {
  it('registers immutable device keys and supports self-revocation', () => {
    const harness = createHarness();
    try {
      const first = harness.register('alice', 'alice-device-1');
      expect(harness.facade.listE2eeDevices({
        organizationId: 'org-a',
        requesterAccountId: 'alice',
        accountIds: ['alice'],
      })).toMatchObject([{ accountId: 'alice', deviceId: 'alice-device-1', revokedAt: null }]);

      const replacement = generateKeyPairSync('ed25519');
      expect(() => harness.facade.registerE2eeDevice({
        organizationId: 'org-a',
        accountId: 'alice',
        deviceId: 'alice-device-1',
        deviceName: 'stolen id',
        identitySigningPublicKey: publicPem(replacement.publicKey),
        deviceExchangePublicKey: publicPem(first.exchange.publicKey),
      })).toThrow('cannot be rebound');

      expect(harness.facade.revokeE2eeDevice({
        organizationId: 'org-a',
        accountId: 'alice',
        deviceId: 'alice-device-1',
      })).toBe(true);
      expect(harness.facade.listE2eeDevices({
        organizationId: 'org-a',
        requesterAccountId: 'alice',
        accountIds: ['alice'],
      })).toEqual([]);
      expect(harness.facade.listE2eeDevices({
        organizationId: 'org-a',
        requesterAccountId: 'alice',
        accountIds: ['alice'],
        includeRevoked: true,
      })[0]?.revokedAt).toBeTruthy();
    } finally {
      harness.database.close();
    }
  });

  it('stores only signed ciphertext and requires envelopes for every active device', () => {
    const harness = createHarness();
    try {
      harness.register('alice', 'alice-device-1');
      harness.register('bob', 'bob-device-1');
      harness.register('bob', 'bob-device-2');

      const missingDevice = harness.signedMessage({
        envelopes: [
          {
            accountId: 'alice',
            deviceId: 'alice-device-1',
            ephemeralPublicKey: publicPem(generateKeyPairSync('x25519').publicKey),
            wrappedKey: Buffer.alloc(48, 1).toString('base64'),
            nonce: Buffer.alloc(12, 2).toString('base64'),
          },
          {
            accountId: 'bob',
            deviceId: 'bob-device-1',
            ephemeralPublicKey: publicPem(generateKeyPairSync('x25519').publicKey),
            wrappedKey: Buffer.alloc(48, 3).toString('base64'),
            nonce: Buffer.alloc(12, 4).toString('base64'),
          },
        ],
      });
      expect(() => harness.facade.sendE2eeDirectMessage(missingDevice)).toThrow(
        'every active participant device',
      );

      const message = harness.signedMessage({
        ciphertext: Buffer.from('the plaintext is never sent here plus tag').toString('base64'),
        attachments: [{
          id: 'attachment-1',
          ciphertext: Buffer.from('encrypted attachment plus auth tag').toString('base64'),
          nonce: Buffer.alloc(12, 9).toString('base64'),
        }],
      });
      const sent = harness.facade.sendE2eeDirectMessage(message);
      expect(sent).toMatchObject({
        id: 'message-1',
        protocolVersion: 1,
        senderDeviceId: 'alice-device-1',
      });
      const storedMessage = harness.database.prepare(
        `SELECT content, content_ciphertext, e2ee_ciphertext
         FROM direct_messages WHERE id = 'message-1'`,
      ).get();
      expect(storedMessage).toEqual({
        content: '[e2ee:v1]',
        content_ciphertext: null,
        e2ee_ciphertext: message.ciphertext,
      });
      const storedAttachment = harness.database.prepare(
        `SELECT file_name, mime_type, content
         FROM direct_message_attachments WHERE id = 'attachment-1'`,
      ).get() as { file_name: string; mime_type: string; content: Uint8Array };
      expect(storedAttachment.file_name).toBe('[e2ee]');
      expect(storedAttachment.mime_type).toBe('application/octet-stream');
      expect(Buffer.from(storedAttachment.content).toString('utf8')).not.toContain('attachment body');
    } finally {
      harness.database.close();
    }
  });

  it('rejects tampering and excludes revoked devices from future envelope coverage', () => {
    const harness = createHarness();
    try {
      harness.register('alice', 'alice-device-1');
      harness.register('bob', 'bob-device-1');
      harness.register('bob', 'bob-device-2');
      const valid = harness.signedMessage();
      expect(() => harness.facade.sendE2eeDirectMessage({
        ...valid,
        ciphertext: Buffer.from('tampered ciphertext plus tag').toString('base64'),
      })).toThrow('signature is invalid');

      harness.facade.revokeE2eeDevice({
        organizationId: 'org-a',
        accountId: 'bob',
        deviceId: 'bob-device-2',
      });
      const afterRevocation = harness.signedMessage({
        envelopes: valid.envelopes.filter((item) => item.deviceId !== 'bob-device-2'),
      });
      expect(harness.facade.sendE2eeDirectMessage(afterRevocation).id).toBe('message-1');
    } finally {
      harness.database.close();
    }
  });

  it('tracks encrypted A2A request/response linkage without reading their bodies', () => {
    const harness = createHarness();
    try {
      harness.register('alice', 'alice-device-1');
      harness.register('bob', 'bob-device-1');
      const request = harness.signedMessage({ contentType: 'atoa_request' });
      harness.facade.sendE2eeDirectMessage(request);
      expect(harness.facade.listPendingE2eeAtoaRequests({
        organizationId: 'org-a',
        accountId: 'bob',
      })).toMatchObject([{ id: 'message-1', peerAccountId: 'alice' }]);

      const responseUnsigned = harness.signedMessage({
        messageId: 'message-2',
        senderAccountId: 'bob',
        recipientAccountId: 'alice',
        senderDeviceId: 'bob-device-1',
        contentType: 'atoa_response',
        inReplyToMessageId: 'message-1',
      });
      harness.facade.sendE2eeDirectMessage(responseUnsigned);
      expect(harness.facade.listPendingE2eeAtoaRequests({
        organizationId: 'org-a',
        accountId: 'bob',
      })).toEqual([]);
    } finally {
      harness.database.close();
    }
  });
});
