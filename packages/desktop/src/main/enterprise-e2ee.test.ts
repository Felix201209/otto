/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EnterpriseE2eeCrypto,
  EnterpriseE2eeKeyVault,
  type EnterpriseE2eeDeviceBundle,
  type EnterpriseE2eeSendPayload,
  type EnterpriseE2eeWireMessage,
} from './enterprise-e2ee.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createEndpoint(deviceName: string) {
  const root = mkdtempSync(join(tmpdir(), 'otto-e2ee-test-'));
  roots.push(root);
  const vault = new EnterpriseE2eeKeyVault({
    directory: root,
    deviceName: () => deviceName,
    now: () => new Date('2026-07-31T00:00:00.000Z'),
    protect: (plaintext) => `protected:${Buffer.from(plaintext).toString('base64')}`,
    unprotect: (protectedValue) =>
      Buffer.from(protectedValue.slice('protected:'.length), 'base64').toString('utf8'),
  });
  return { root, vault, crypto: new EnterpriseE2eeCrypto(vault) };
}

function wire(
  payload: EnterpriseE2eeSendPayload,
  senderDevice: EnterpriseE2eeDeviceBundle,
  senderAccountId = 'alice',
  recipientAccountId = 'bob',
): EnterpriseE2eeWireMessage {
  return {
    id: payload.messageId,
    senderAccountId,
    recipientAccountId,
    senderDeviceId: payload.senderDeviceId,
    senderIdentitySigningPublicKey: senderDevice.identitySigningPublicKey,
    protocolVersion: payload.protocolVersion,
    contentType: payload.contentType,
    inReplyToMessageId: payload.inReplyToMessageId,
    ciphertext: payload.ciphertext,
    nonce: payload.nonce,
    signature: payload.signature,
    envelopes: payload.envelopes,
    createdAt: '2026-07-31T00:01:00.000Z',
    readAt: null,
    attachments: payload.attachments.map((attachment) => ({
      id: attachment.id,
      ciphertextSize: Buffer.from(attachment.ciphertext, 'base64').length,
      nonce: attachment.nonce,
    })),
  };
}

describe('enterprise private-chat E2EE', () => {
  it('encrypts for sender and recipient devices and detects message tampering', () => {
    const alice = createEndpoint('Alice laptop');
    const bob = createEndpoint('Bob laptop');
    const aliceDevice = alice.crypto.localDevice('https://otto.test', 'alice');
    const bobDevice = bob.crypto.localDevice('https://otto.test', 'bob');
    const encrypted = alice.crypto.encryptMessage({
      serverScope: 'https://otto.test',
      organizationId: 'org-a',
      senderAccountId: 'alice',
      recipientAccountId: 'bob',
      content: 'only the endpoints can read this',
      contentType: 'message',
      devices: [aliceDevice, bobDevice],
      messageId: 'message-1',
    });
    expect(JSON.stringify(encrypted)).not.toContain('only the endpoints');
    expect(encrypted.envelopes.map((item) => `${item.accountId}:${item.deviceId}`)).toEqual([
      `alice:${aliceDevice.deviceId}`,
      `bob:${bobDevice.deviceId}`,
    ]);
    const message = wire(encrypted, aliceDevice);
    expect(bob.crypto.decryptMessage({
      serverScope: 'https://otto.test',
      organizationId: 'org-a',
      accountId: 'bob',
      message,
    }).content).toBe('only the endpoints can read this');
    expect(alice.crypto.decryptMessage({
      serverScope: 'https://otto.test',
      organizationId: 'org-a',
      accountId: 'alice',
      message,
    }).content).toBe('only the endpoints can read this');

    expect(() => bob.crypto.decryptMessage({
      serverScope: 'https://otto.test',
      organizationId: 'org-a',
      accountId: 'bob',
      message: { ...message, ciphertext: Buffer.from('tampered plus tag value').toString('base64') },
    })).toThrow('signature is invalid');
  });

  it('encrypts attachment bodies and metadata and authenticates downloads', () => {
    const alice = createEndpoint('Alice laptop');
    const bob = createEndpoint('Bob laptop');
    const aliceDevice = alice.crypto.localDevice('https://otto.test', 'alice');
    const bobDevice = bob.crypto.localDevice('https://otto.test', 'bob');
    const body = Buffer.from('confidential attachment body');
    const encrypted = alice.crypto.encryptMessage({
      serverScope: 'https://otto.test',
      organizationId: 'org-a',
      senderAccountId: 'alice',
      recipientAccountId: 'bob',
      content: 'see attachment',
      contentType: 'message',
      devices: [aliceDevice, bobDevice],
      attachments: [{
        fileName: 'secret-plan.txt',
        mimeType: 'text/plain',
        size: body.length,
        data: body.toString('base64'),
      }],
      messageId: 'message-attachment',
    });
    expect(JSON.stringify(encrypted)).not.toContain('secret-plan.txt');
    expect(JSON.stringify(encrypted)).not.toContain('confidential attachment');
    const message = wire(encrypted, aliceDevice);
    expect(bob.crypto.decryptMessage({
      serverScope: 'https://otto.test',
      organizationId: 'org-a',
      accountId: 'bob',
      message,
    }).attachments).toMatchObject([{ fileName: 'secret-plan.txt', size: body.length }]);
    expect(bob.crypto.decryptAttachment({
      serverScope: 'https://otto.test',
      organizationId: 'org-a',
      accountId: 'bob',
      message,
      attachment: encrypted.attachments[0]!,
    })).toMatchObject({
      fileName: 'secret-plan.txt',
      data: body.toString('base64'),
    });
    const tampered = {
      ...encrypted.attachments[0]!,
      ciphertext: Buffer.from('tampered attachment plus auth tag').toString('base64'),
    };
    expect(() => bob.crypto.decryptAttachment({
      serverScope: 'https://otto.test',
      organizationId: 'org-a',
      accountId: 'bob',
      message,
      attachment: tampered,
    })).toThrow('authentication failed');
  });

  it('covers every active device and stops targeting a revoked device', () => {
    const alice = createEndpoint('Alice');
    const bobOne = createEndpoint('Bob one');
    const bobTwo = createEndpoint('Bob two');
    const devices = [
      alice.crypto.localDevice('https://otto.test', 'alice'),
      bobOne.crypto.localDevice('https://otto.test', 'bob'),
      bobTwo.crypto.localDevice('https://otto.test', 'bob'),
    ];
    const first = alice.crypto.encryptMessage({
      serverScope: 'https://otto.test',
      organizationId: 'org-a',
      senderAccountId: 'alice',
      recipientAccountId: 'bob',
      content: 'multi-device',
      contentType: 'message',
      devices,
    });
    expect(first.envelopes).toHaveLength(3);

    const revokedId = devices[2]!.deviceId;
    const second = alice.crypto.encryptMessage({
      serverScope: 'https://otto.test',
      organizationId: 'org-a',
      senderAccountId: 'alice',
      recipientAccountId: 'bob',
      content: 'after revoke',
      contentType: 'message',
      devices: devices.map((device) =>
        device.deviceId === revokedId
          ? { ...device, revokedAt: '2026-07-31T01:00:00.000Z' }
          : device),
    });
    expect(second.envelopes.some((item) => item.deviceId === revokedId)).toBe(false);
  });

  it('imports a passphrase recovery bundle as historical keys on a new device', () => {
    const oldBob = createEndpoint('Old Bob');
    const alice = createEndpoint('Alice');
    const aliceDevice = alice.crypto.localDevice('https://otto.test', 'alice');
    const oldBobDevice = oldBob.crypto.localDevice('https://otto.test', 'bob');
    const encrypted = alice.crypto.encryptMessage({
      serverScope: 'https://otto.test',
      organizationId: 'org-a',
      senderAccountId: 'alice',
      recipientAccountId: 'bob',
      content: 'recoverable history',
      contentType: 'message',
      devices: [aliceDevice, oldBobDevice],
      messageId: 'historical-message',
    });
    const recovery = oldBob.vault.exportRecoveryBundle(
      'https://otto.test',
      'bob',
      'correct horse battery staple',
    );

    const newBob = createEndpoint('New Bob');
    const newDeviceBeforeImport = newBob.crypto.localDevice('https://otto.test', 'bob');
    newBob.vault.importRecoveryBundle(
      'https://otto.test',
      'bob',
      recovery,
      'correct horse battery staple',
    );
    expect(newBob.crypto.localDevice('https://otto.test', 'bob').deviceId)
      .toBe(newDeviceBeforeImport.deviceId);
    expect(newBob.crypto.decryptMessage({
      serverScope: 'https://otto.test',
      organizationId: 'org-a',
      accountId: 'bob',
      message: wire(encrypted, aliceDevice),
    }).content).toBe('recoverable history');
    expect(() => newBob.vault.importRecoveryBundle(
      'https://otto.test',
      'bob',
      recovery,
      'wrong passphrase',
    )).toThrow('bundle or passphrase is invalid');
  });

  it('keeps raw private keys out of the vault file', () => {
    const endpoint = createEndpoint('Protected device');
    const device = endpoint.crypto.localDevice('https://otto.test', 'alice');
    const files = readFileSync(join(endpoint.root, `${createHash('sha256').update('https://otto.test\0alice').digest('hex')}.keyring`), 'utf8');
    expect(files).toMatch(/^protected:/);
    expect(files).not.toContain(device.identitySigningPublicKey);
  });
});
