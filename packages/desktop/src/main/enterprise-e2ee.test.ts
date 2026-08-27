/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, verify } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EnterpriseE2eeCrypto,
  EnterpriseE2eeKeyVault,
  enterpriseE2eeDeviceApprovalSignaturePayload,
  enterpriseE2eeDeviceVerification,
  enterpriseFederationContactVerification,
  enterpriseFederationIdentityCardDevices,
  type EnterpriseE2eeDeviceBundle,
  type EnterpriseE2eeKeyTransparencyEvent,
  type EnterpriseE2eeKeyTransparencyView,
  type EnterpriseE2eeSendPayload,
  type EnterpriseE2eeWireMessage,
} from './enterprise-e2ee.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function createEndpoint(deviceName: string) {
  const root = mkdtempSync(join(tmpdir(), 'otto-e2ee-test-'));
  roots.push(root);
  const vault = new EnterpriseE2eeKeyVault({
    directory: root,
    deviceName: () => deviceName,
    now: () => new Date('2026-07-31T00:00:00.000Z'),
    protect: (plaintext) =>
      `protected:${Buffer.from(plaintext).toString('base64')}`,
    unprotect: (protectedValue) =>
      Buffer.from(protectedValue.slice('protected:'.length), 'base64').toString(
        'utf8',
      ),
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

function transparencyView(
  organizationId: string,
  accountId: string,
  events: Array<{
    device: EnterpriseE2eeDeviceBundle;
    event: EnterpriseE2eeKeyTransparencyEvent;
  }>,
): EnterpriseE2eeKeyTransparencyView {
  let previousHash = '0'.repeat(64);
  const entries = events.map(({ device, event }, index) => {
    const sequence = index + 1;
    const createdAt = `2026-07-31T00:0${sequence}:00.000Z`;
    const unsigned = {
      sequence,
      organizationId,
      accountId,
      deviceId: device.deviceId,
      event,
      keyFingerprint: device.keyFingerprint,
      actorDeviceId: event === 'bootstrap_approved' ? null : events[0]!.device.deviceId,
      previousHash,
      createdAt,
    };
    const entryHash = createHash('sha256')
      .update('otto:e2ee-key-transparency:v1\n')
      .update(JSON.stringify(unsigned))
      .digest('hex');
    previousHash = entryHash;
    return { ...unsigned, entryHash };
  });
  return {
    accountId,
    headSequence: entries.length,
    headHash: previousHash,
    entries,
  };
}

describe('enterprise private-chat E2EE', () => {
  it('streams federation attachments, verifies ciphertext and decrypts only on the recipient device', async () => {
    const alice = createEndpoint('Alice laptop');
    const bob = createEndpoint('Bob laptop');
    const aliceDevice = alice.crypto.localDevice('federation', 'alice');
    const bobDevice = bob.crypto.localDevice('federation', 'bob');
    const source = join(alice.root, 'large-source.bin');
    const ciphertext = join(alice.root, 'large-ciphertext.bin');
    const destination = join(bob.root, 'large-destination.bin');
    const body = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
    writeFileSync(source, body);
    const messageId = 'fmessage_streaming_attachment';
    const prepared = await alice.crypto.encryptExternalAttachmentFile({
      messageId,
      sourcePath: source,
      ciphertextPath: ciphertext,
      fileName: 'large.bin',
      mimeType: 'application/octet-stream',
      size: body.length,
      attachmentId: 'fattachment_streaming',
    });
    expect(prepared.metadata.ciphertextSize).toBe(body.length + 16);
    expect(prepared.metadata.ciphertextSha256).toMatch(/^[a-f0-9]{64}$/u);

    const encrypted = alice.crypto.encryptMessage({
      serverScope: 'federation',
      organizationId: 'conversation',
      senderAccountId: 'alice',
      recipientAccountId: 'bob',
      content: 'See attachment',
      contentType: 'message',
      devices: [aliceDevice, bobDevice],
      externalAttachments: [prepared],
      messageId,
    });
    const message = wire(encrypted, aliceDevice);
    message.attachments = [{
      id: prepared.metadata.id,
      ciphertextSize: prepared.metadata.ciphertextSize,
      nonce: prepared.metadata.nonce,
    }];
    const metadata = bob.crypto.federationAttachmentMetadata({
      serverScope: 'federation',
      organizationId: 'conversation',
      accountId: 'bob',
      message,
      attachmentId: prepared.metadata.id,
    });
    await bob.crypto.decryptExternalAttachmentFile({
      messageId,
      ciphertextPath: ciphertext,
      destinationPath: destination,
      metadata,
    });
    expect(readFileSync(destination)).toEqual(body);

    const tampered = Buffer.from(readFileSync(ciphertext));
    tampered[0] ^= 1;
    writeFileSync(ciphertext, tampered);
    await expect(bob.crypto.decryptExternalAttachmentFile({
      messageId,
      ciphertextPath: ciphertext,
      destinationPath: join(bob.root, 'tampered.bin'),
      metadata,
    })).rejects.toThrow('ciphertext verification failed');
  }, 30_000);

  it('pins, verifies and isolates signed federation contact identities', () => {
    const alice = createEndpoint('Alice laptop');
    const bob = createEndpoint('Bob laptop');
    const rotatedBob = createEndpoint('Bob replacement laptop');
    const bobCard = bob.crypto.createFederationIdentityCard({
      deploymentId: 'deployment-b',
      principalId: 'bob-account',
      displayName: 'Bob',
      issuedAt: '2026-07-31T00:00:00.000Z',
    });
    const scope = {
      localServerScope: 'https://alice.example.test',
      localAccountId: 'alice-account',
      contactId: 'contact-bob',
    };

    expect(alice.crypto.verifyFederationIdentityCard(bobCard)).toEqual(bobCard);
    expect(alice.crypto.pinFederationContact({ ...scope, card: bobCard })).toMatchObject({
      card: bobCard,
      verifiedAt: null,
    });
    expect(alice.crypto.federationContactTrust({
      ...scope,
      localAccountId: 'other-alice-account',
    })).toBeNull();
    expect(alice.crypto.verifyFederationContact(scope).verifiedAt).toBe(
      '2026-07-31T00:00:00.000Z',
    );

    const trustFile = readdirSync(alice.root).find((name) =>
      name.endsWith('.federation-contact'),
    );
    expect(trustFile).toBeTruthy();
    const stored = readFileSync(join(alice.root, trustFile!), 'utf8');
    expect(stored).toMatch(/^protected:/);
    expect(stored).not.toContain('Bob');

    expect(() => alice.crypto.verifyFederationIdentityCard({
      ...bobCard,
      displayName: 'Mallory',
    })).toThrow('signature is invalid');

    const replacementCard = rotatedBob.crypto.createFederationIdentityCard({
      deploymentId: 'deployment-b',
      principalId: 'bob-account',
      displayName: 'Bob',
      issuedAt: '2026-07-31T00:10:00.000Z',
    });
    expect(() => alice.crypto.pinFederationContact({
      ...scope,
      card: replacementCard,
    })).toThrow('device key changed');
    expect(alice.crypto.pinFederationContact({
      ...scope,
      card: replacementCard,
      allowDeviceKeyChange: true,
    }).verifiedAt).toBeNull();

    alice.crypto.removeFederationContact(scope);
    expect(alice.crypto.federationContactTrust(scope)).toBeNull();
  });

  it('accepts only monotonic multi-device federation directories signed by a trusted device', () => {
    const alice = createEndpoint('Alice laptop');
    const bob = createEndpoint('Bob laptop');
    const bobPhone = createEndpoint('Bob phone');
    const bobDevice = bob.crypto.localDevice('https://bob.test', 'bob');
    const phoneDevice = bobPhone.crypto.localDevice('https://bob.test', 'bob');
    const scope = {
      localServerScope: 'https://alice.test',
      localAccountId: 'alice',
      contactId: 'bob',
    };
    const card = bob.crypto.createFederationIdentityCard({
      deploymentId: 'deployment-b',
      principalId: 'bob',
      displayName: 'Bob',
      devices: [bobDevice],
      identityDevice: bobDevice,
      directorySequence: 1,
      directoryHash: '1'.repeat(64),
      keyring: { serverScope: 'https://bob.test', accountId: 'bob' },
    });
    alice.crypto.pinFederationContact({ ...scope, card });
    alice.crypto.verifyFederationContact(scope);

    const expanded = bob.crypto.createFederationIdentityCard({
      deploymentId: 'deployment-b',
      principalId: 'bob',
      displayName: 'Bob',
      devices: [bobDevice, phoneDevice],
      identityDevice: bobDevice,
      directorySequence: 2,
      directoryHash: '2'.repeat(64),
      keyring: { serverScope: 'https://bob.test', accountId: 'bob' },
    });
    expect(alice.crypto.pinFederationContact({
      ...scope,
      card: expanded,
    }).verifiedAt).toBe('2026-07-31T00:00:00.000Z');

    const rollback = bob.crypto.createFederationIdentityCard({
      deploymentId: 'deployment-b',
      principalId: 'bob',
      displayName: 'Bob',
      devices: [bobDevice],
      identityDevice: bobDevice,
      directorySequence: 1,
      directoryHash: '1'.repeat(64),
      keyring: { serverScope: 'https://bob.test', accountId: 'bob' },
    });
    expect(() => alice.crypto.pinFederationContact({
      ...scope,
      card: rollback,
    })).toThrow('directory is untrusted');

    const fork = bob.crypto.createFederationIdentityCard({
      deploymentId: 'deployment-b',
      principalId: 'bob',
      displayName: 'Bob',
      devices: [bobDevice, phoneDevice],
      identityDevice: bobDevice,
      directorySequence: 2,
      directoryHash: 'f'.repeat(64),
      keyring: { serverScope: 'https://bob.test', accountId: 'bob' },
    });
    expect(() => alice.crypto.pinFederationContact({
      ...scope,
      card: fork,
    })).toThrow('directory is untrusted');

    const stranger = createEndpoint('Unknown device');
    const strangerDevice = stranger.crypto.localDevice(
      'https://bob.test',
      'bob',
    );
    const substituted = stranger.crypto.createFederationIdentityCard({
      deploymentId: 'deployment-b',
      principalId: 'bob',
      displayName: 'Bob',
      devices: [strangerDevice],
      identityDevice: strangerDevice,
      directorySequence: 3,
      directoryHash: '3'.repeat(64),
      keyring: { serverScope: 'https://bob.test', accountId: 'bob' },
    });
    expect(() => alice.crypto.pinFederationContact({
      ...scope,
      card: substituted,
    })).toThrow('directory is untrusted');
  });

  it('keeps a stable federation safety number after root-device revocation', () => {
    const alice = createEndpoint('Alice laptop');
    const bob = createEndpoint('Bob laptop');
    const bobPhone = createEndpoint('Bob phone');
    const aliceDevice = alice.crypto.localDevice('https://alice.test', 'alice');
    const bobDevice = bob.crypto.localDevice('https://bob.test', 'bob');
    const phoneDevice = bobPhone.crypto.localDevice('https://bob.test', 'bob');
    const aliceCard = alice.crypto.createFederationIdentityCard({
      deploymentId: 'deployment-a',
      principalId: 'alice',
      displayName: 'Alice',
      devices: [aliceDevice],
      identityDevice: aliceDevice,
      directorySequence: 1,
      directoryHash: 'a'.repeat(64),
      keyring: { serverScope: 'https://alice.test', accountId: 'alice' },
    });
    const before = bob.crypto.createFederationIdentityCard({
      deploymentId: 'deployment-b',
      principalId: 'bob',
      displayName: 'Bob',
      devices: [bobDevice, phoneDevice],
      identityDevice: bobDevice,
      directorySequence: 2,
      directoryHash: 'b'.repeat(64),
      keyring: { serverScope: 'https://bob.test', accountId: 'bob' },
    });
    const revokedRoot = {
      ...bobDevice,
      revokedAt: '2026-07-31T00:30:00.000Z',
    };
    const after = bobPhone.crypto.createFederationIdentityCard({
      deploymentId: 'deployment-b',
      principalId: 'bob',
      displayName: 'Bob',
      devices: [phoneDevice],
      identityDevice: revokedRoot,
      directorySequence: 3,
      directoryHash: 'c'.repeat(64),
      keyring: { serverScope: 'https://bob.test', accountId: 'bob' },
    });
    expect(enterpriseFederationContactVerification(aliceCard, before))
      .toEqual(enterpriseFederationContactVerification(aliceCard, after));
    expect(enterpriseFederationIdentityCardDevices(after)).toHaveLength(1);
    expect(enterpriseFederationIdentityCardDevices(after)[0]?.deviceId)
      .toBe(phoneDevice.deviceId);
  });

  it('wraps a federated message key for every approved active device', () => {
    const alice = createEndpoint('Alice laptop');
    const alicePhone = createEndpoint('Alice phone');
    const bob = createEndpoint('Bob laptop');
    const bobPhone = createEndpoint('Bob phone');
    const aliceDevice = alice.crypto.localDevice('https://alice.test', 'alice');
    const alicePhoneDevice = alicePhone.crypto.localDevice(
      'https://alice.test',
      'alice',
    );
    const bobDevice = bob.crypto.localDevice('https://bob.test', 'bob');
    const bobPhoneDevice = bobPhone.crypto.localDevice(
      'https://bob.test',
      'bob',
    );
    const devices = [
      ...[aliceDevice, alicePhoneDevice].map((device) => ({
        ...device,
        accountId: 'deployment-a:alice',
      })),
      ...[bobDevice, bobPhoneDevice].map((device) => ({
        ...device,
        accountId: 'deployment-b:bob',
      })),
    ];
    const encrypted = alice.crypto.encryptMessage({
      serverScope: 'federation',
      organizationId: 'conversation-a-b',
      senderAccountId: 'deployment-a:alice',
      recipientAccountId: 'deployment-b:bob',
      keyring: { serverScope: 'https://alice.test', accountId: 'alice' },
      content: 'multi-device federation',
      contentType: 'message',
      devices,
    });
    expect(encrypted.envelopes).toHaveLength(4);
    expect(new Set(encrypted.envelopes.map((item) => item.deviceId)).size)
      .toBe(4);
    const message = wire(
      encrypted,
      { ...aliceDevice, accountId: 'deployment-a:alice' },
      'deployment-a:alice',
      'deployment-b:bob',
    );
    expect(bob.crypto.decryptMessage({
      serverScope: 'federation',
      organizationId: 'conversation-a-b',
      accountId: 'deployment-b:bob',
      keyring: { serverScope: 'https://bob.test', accountId: 'bob' },
      message,
    }).content).toBe('multi-device federation');
  });

  it('pins transparency heads and rejects a server rollback or fork', () => {
    const alice = createEndpoint('Alice laptop');
    const aliceDevice = alice.crypto.localDevice('https://otto.test', 'alice');
    const second = createEndpoint('Alice phone').crypto.localDevice(
      'https://otto.test',
      'alice',
    );
    const first = transparencyView('org-a', 'alice', [
      { device: aliceDevice, event: 'bootstrap_approved' },
    ]);
    const extended = transparencyView('org-a', 'alice', [
      { device: aliceDevice, event: 'bootstrap_approved' },
      { device: second, event: 'registered_pending' },
    ]);

    expect(
      alice.crypto.verifyAndPinKeyTransparency({
        serverScope: 'https://otto.test',
        organizationId: 'org-a',
        view: first,
      }),
    ).toEqual(first);
    expect(
      alice.crypto.verifyAndPinKeyTransparency({
        serverScope: 'https://otto.test',
        organizationId: 'org-a',
        view: extended,
      }),
    ).toEqual(extended);
    expect(() =>
      alice.crypto.verifyAndPinKeyTransparency({
        serverScope: 'https://otto.test',
        organizationId: 'org-a',
        view: first,
      }),
    ).toThrow('rollback');

    const fork = transparencyView('org-a', 'alice', [
      { device: aliceDevice, event: 'bootstrap_approved' },
      { device: aliceDevice, event: 'revoked' },
    ]);
    expect(() =>
      alice.crypto.verifyAndPinKeyTransparency({
        serverScope: 'https://otto.test',
        organizationId: 'org-a',
        view: fork,
      }),
    ).toThrow('fork');

    const checkpointFiles = readFileSync(
      join(
        alice.root,
        `${createHash('sha256')
          .update('https://otto.test\0org-a\0alice')
          .digest('hex')}.transparency`,
      ),
      'utf8',
    );
    expect(checkpointFiles).toMatch(/^protected:/);
    expect(checkpointFiles).not.toContain(extended.headHash);
  });

  it('rejects malformed transparency entries and inconsistent device directories', () => {
    const alice = createEndpoint('Alice laptop');
    const bob = createEndpoint('Bob laptop');
    const aliceDevice = alice.crypto.localDevice('https://otto.test', 'alice');
    const bobDevice = bob.crypto.localDevice('https://otto.test', 'bob');
    const aliceView = transparencyView('org-a', 'alice', [
      { device: aliceDevice, event: 'bootstrap_approved' },
    ]);
    const bobView = transparencyView('org-a', 'bob', [
      { device: bobDevice, event: 'bootstrap_approved' },
    ]);

    expect(() =>
      alice.crypto.verifyAndPinKeyTransparency({
        serverScope: 'https://otto.test',
        organizationId: 'org-a',
        view: {
          ...aliceView,
          entries: [
            { ...aliceView.entries[0]!, entryHash: 'f'.repeat(64) },
          ],
        },
      }),
    ).toThrow('integrity');

    expect(() =>
      alice.crypto.verifyDeviceDirectory({
        organizationId: 'org-a',
        devices: [aliceDevice],
        transparency: [aliceView, bobView],
        includePending: false,
        includeRevoked: false,
      }),
    ).toThrow('does not match');
    expect(() =>
      alice.crypto.verifyDeviceDirectory({
        organizationId: 'org-a',
        devices: [aliceDevice, { ...bobDevice, keyFingerprint: 'a'.repeat(64) }],
        transparency: [aliceView, bobView],
        includePending: false,
        includeRevoked: false,
      }),
    ).toThrow('fingerprint');
    expect(
      alice.crypto.verifyDeviceDirectory({
        organizationId: 'org-a',
        devices: [aliceDevice, bobDevice],
        transparency: [aliceView, bobView],
        includePending: false,
        includeRevoked: false,
      }),
    ).toEqual([aliceDevice, bobDevice]);
  });

  it('derives symmetric safety numbers and signs out-of-band device approvals locally', () => {
    const aliceOne = createEndpoint('Alice one');
    const aliceTwo = createEndpoint('Alice two');
    const first = aliceOne.crypto.localDevice('https://otto.test', 'alice');
    const second = aliceTwo.crypto.localDevice('https://otto.test', 'alice');

    expect(
      aliceOne.crypto.verifyLocalDeviceRegistration(first, first),
    ).toEqual(first);
    expect(() =>
      aliceOne.crypto.verifyLocalDeviceRegistration(first, {
        ...first,
        identitySigningPublicKey: second.identitySigningPublicKey,
        keyFingerprint: second.keyFingerprint,
      }),
    ).toThrow('substituted');

    const forward = enterpriseE2eeDeviceVerification(first, second);
    const reverse = enterpriseE2eeDeviceVerification(second, first);
    expect(forward.safetyNumber).toMatch(/^(\d{5} ){11}\d{5}$/);
    expect(reverse).toEqual(forward);
    expect(forward.qrPayload).toMatch(/^otto-e2ee-verify:v1:/);

    const approval = aliceOne.crypto.signDeviceApproval({
      serverScope: 'https://otto.test',
      organizationId: 'org-a',
      accountId: 'alice',
      targetDevice: second,
    });
    expect(approval.targetKeyFingerprint).toBe(second.keyFingerprint);
    expect(
      verify(
        null,
        enterpriseE2eeDeviceApprovalSignaturePayload({
          organizationId: 'org-a',
          accountId: 'alice',
          approverDeviceId: approval.approverDeviceId,
          targetDeviceId: approval.targetDeviceId,
          targetKeyFingerprint: approval.targetKeyFingerprint,
        }),
        first.identitySigningPublicKey,
        Buffer.from(approval.signature, 'base64'),
      ),
    ).toBe(true);
  });

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
    expect(
      encrypted.envelopes.map((item) => `${item.accountId}:${item.deviceId}`),
    ).toEqual([`alice:${aliceDevice.deviceId}`, `bob:${bobDevice.deviceId}`]);
    const message = wire(encrypted, aliceDevice);
    expect(
      bob.crypto.decryptMessage({
        serverScope: 'https://otto.test',
        organizationId: 'org-a',
        accountId: 'bob',
        message,
      }).content,
    ).toBe('only the endpoints can read this');
    expect(
      alice.crypto.decryptMessage({
        serverScope: 'https://otto.test',
        organizationId: 'org-a',
        accountId: 'alice',
        message,
      }).content,
    ).toBe('only the endpoints can read this');

    expect(() =>
      bob.crypto.decryptMessage({
        serverScope: 'https://otto.test',
        organizationId: 'org-a',
        accountId: 'bob',
        message: {
          ...message,
          ciphertext: Buffer.from('tampered plus tag value').toString('base64'),
        },
      }),
    ).toThrow('signature is invalid');
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
      attachments: [
        {
          fileName: 'secret-plan.txt',
          mimeType: 'text/plain',
          size: body.length,
          data: body.toString('base64'),
        },
      ],
      messageId: 'message-attachment',
    });
    expect(JSON.stringify(encrypted)).not.toContain('secret-plan.txt');
    expect(JSON.stringify(encrypted)).not.toContain('confidential attachment');
    const message = wire(encrypted, aliceDevice);
    expect(
      bob.crypto.decryptMessage({
        serverScope: 'https://otto.test',
        organizationId: 'org-a',
        accountId: 'bob',
        message,
      }).attachments,
    ).toMatchObject([{ fileName: 'secret-plan.txt', size: body.length }]);
    expect(
      bob.crypto.decryptAttachment({
        serverScope: 'https://otto.test',
        organizationId: 'org-a',
        accountId: 'bob',
        message,
        attachment: encrypted.attachments[0]!,
      }),
    ).toMatchObject({
      fileName: 'secret-plan.txt',
      data: body.toString('base64'),
    });
    const tampered = {
      ...encrypted.attachments[0]!,
      ciphertext: Buffer.from('tampered attachment plus auth tag').toString(
        'base64',
      ),
    };
    expect(() =>
      bob.crypto.decryptAttachment({
        serverScope: 'https://otto.test',
        organizationId: 'org-a',
        accountId: 'bob',
        message,
        attachment: tampered,
      }),
    ).toThrow('authentication failed');
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
          : device,
      ),
    });
    expect(second.envelopes.some((item) => item.deviceId === revokedId)).toBe(
      false,
    );
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
    const newDeviceBeforeImport = newBob.crypto.localDevice(
      'https://otto.test',
      'bob',
    );
    newBob.vault.importRecoveryBundle(
      'https://otto.test',
      'bob',
      recovery,
      'correct horse battery staple',
    );
    expect(newBob.crypto.localDevice('https://otto.test', 'bob').deviceId).toBe(
      newDeviceBeforeImport.deviceId,
    );
    expect(
      newBob.crypto.decryptMessage({
        serverScope: 'https://otto.test',
        organizationId: 'org-a',
        accountId: 'bob',
        message: wire(encrypted, aliceDevice),
      }).content,
    ).toBe('recoverable history');
    expect(() =>
      newBob.vault.importRecoveryBundle(
        'https://otto.test',
        'bob',
        recovery,
        'wrong passphrase',
      ),
    ).toThrow('bundle or passphrase is invalid');
  });

  it('keeps raw private keys out of the vault file', () => {
    const endpoint = createEndpoint('Protected device');
    const device = endpoint.crypto.localDevice('https://otto.test', 'alice');
    const files = readFileSync(
      join(
        endpoint.root,
        `${createHash('sha256').update('https://otto.test\0alice').digest('hex')}.keyring`,
      ),
      'utf8',
    );
    expect(files).toMatch(/^protected:/);
    expect(files).not.toContain(device.identitySigningPublicKey);
  });
});
