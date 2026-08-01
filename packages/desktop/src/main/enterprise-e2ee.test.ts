/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  e2eeDeviceCertificateRequestHash,
  e2eeMerkleInclusionProof,
  e2eeMerkleRoot,
  verifyE2eeDeviceCertificateApproval,
} from 'otto-server';

import {
  EnterpriseE2eeCrypto,
  EnterpriseE2eeKeyVault,
  enterpriseE2eeDeviceVerification,
  enterpriseE2eeTransparencyLeaf,
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
      certificateHash:
        device.certificateHash ||
        (device.certificateRequest
          ? e2eeDeviceCertificateRequestHash(device.certificateRequest)
          : device.keyFingerprint),
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
    treeSize: entries.length,
    merkleRoot: e2eeMerkleRoot(
      entries.map((entry) =>
        enterpriseE2eeTransparencyLeaf(organizationId, entry),
      ),
    ),
    inclusionProofs: entries.map((_, index) => {
      const leaves = entries.map((entry) =>
        enterpriseE2eeTransparencyLeaf(organizationId, entry),
      );
      return e2eeMerkleInclusionProof(leaves, index);
    }),
    entries,
  };
}

describe('enterprise private-chat E2EE', () => {
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
    const maliciousProofs = extended.inclusionProofs.map((proof, index) =>
      index === 0
        ? { ...proof, hashes: proof.hashes.map(() => 'f'.repeat(64)) }
        : proof,
    );
    expect(() =>
      alice.crypto.verifyAndPinKeyTransparency({
        serverScope: 'https://otto.test',
        organizationId: 'org-a',
        view: { ...extended, inclusionProofs: maliciousProofs },
      }),
    ).toThrow('inclusion proof');
    expect(() =>
      alice.crypto.verifyAndPinKeyTransparency({
        serverScope: 'https://otto.test',
        organizationId: 'org-a',
        view: { ...extended, merkleRoot: 'e'.repeat(64) },
      }),
    ).toThrow('root');
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

  it('documents the first-use split-view gap until an external witness exists', () => {
    const firstObserver = createEndpoint('First observer');
    const secondObserver = createEndpoint('Second observer');
    const honestDevice = createEndpoint('Honest Alice').crypto.localDevice(
      'https://otto.test',
      'alice',
    );
    const substitutedDevice = createEndpoint(
      'Substituted Alice',
    ).crypto.localDevice('https://otto.test', 'alice');
    const honestView = transparencyView('org-a', 'alice', [
      { device: honestDevice, event: 'bootstrap_approved' },
    ]);
    const splitView = transparencyView('org-a', 'alice', [
      { device: substitutedDevice, event: 'bootstrap_approved' },
    ]);

    expect(honestView.merkleRoot).not.toBe(splitView.merkleRoot);
    expect(() =>
      firstObserver.crypto.verifyAndPinKeyTransparency({
        serverScope: 'https://otto.test',
        organizationId: 'org-a',
        view: honestView,
      }),
    ).not.toThrow();
    expect(() =>
      secondObserver.crypto.verifyAndPinKeyTransparency({
        serverScope: 'https://otto.test',
        organizationId: 'org-a',
        view: splitView,
      }),
    ).not.toThrow();
  });

  it('rejects malformed transparency entries and inconsistent device directories', () => {
    const alice = createEndpoint('Alice laptop');
    const bob = createEndpoint('Bob laptop');
    const aliceLocal = alice.crypto.localDevice('https://otto.test', 'alice');
    const bobLocal = bob.crypto.localDevice('https://otto.test', 'bob');
    const aliceRequest = alice.crypto.createDeviceCertificateRequest({
      serverScope: 'https://otto.test',
      deploymentId: 'deployment-test',
      organizationId: 'org-a',
      accountId: 'alice',
    });
    const bobRequest = bob.crypto.createDeviceCertificateRequest({
      serverScope: 'https://otto.test',
      deploymentId: 'deployment-test',
      organizationId: 'org-a',
      accountId: 'bob',
    });
    const aliceDevice: EnterpriseE2eeDeviceBundle = {
      ...aliceLocal,
      certificateFormat: 2,
      certificateSerial: aliceRequest.certificateSerial,
      certificateRequest: aliceRequest,
      certificateHash: e2eeDeviceCertificateRequestHash(aliceRequest),
      certificateExpiresAt: null,
    };
    const bobDevice: EnterpriseE2eeDeviceBundle = {
      ...bobLocal,
      certificateFormat: 2,
      certificateSerial: bobRequest.certificateSerial,
      certificateRequest: bobRequest,
      certificateHash: e2eeDeviceCertificateRequestHash(bobRequest),
      certificateExpiresAt: null,
    };
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

    const forward = enterpriseE2eeDeviceVerification(first, second);
    const reverse = enterpriseE2eeDeviceVerification(second, first);
    expect(forward.safetyNumber).toMatch(/^(\d{5} ){11}\d{5}$/);
    expect(reverse).toEqual(forward);
    expect(forward.qrPayload).toMatch(/^otto-e2ee-verify:v1:/);

    const firstRequest = aliceOne.crypto.createDeviceCertificateRequest({
      serverScope: 'https://otto.test',
      deploymentId: 'deployment-test',
      organizationId: 'org-a',
      accountId: 'alice',
    });
    const secondRequest = aliceTwo.crypto.createDeviceCertificateRequest({
      serverScope: 'https://otto.test',
      deploymentId: 'deployment-test',
      organizationId: 'org-a',
      accountId: 'alice',
    });
    const approverDevice: EnterpriseE2eeDeviceBundle = {
      ...first,
      certificateFormat: 2,
      certificateSerial: firstRequest.certificateSerial,
      certificateRequest: firstRequest,
      certificateHash: e2eeDeviceCertificateRequestHash(firstRequest),
      certificateExpiresAt: null,
    };
    const targetDevice: EnterpriseE2eeDeviceBundle = {
      ...second,
      certificateFormat: 2,
      certificateSerial: secondRequest.certificateSerial,
      certificateRequest: secondRequest,
      certificateHash: null,
      certificateExpiresAt: null,
    };
    expect(
      aliceOne.crypto.verifyLocalDeviceRegistration(first, approverDevice),
    ).toEqual(approverDevice);
    expect(() =>
      aliceOne.crypto.verifyLocalDeviceRegistration(first, {
        ...approverDevice,
        identitySigningPublicKey: second.identitySigningPublicKey,
        keyFingerprint: second.keyFingerprint,
      }),
    ).toThrow('substituted');
    const approval = aliceOne.crypto.signDeviceApproval({
      serverScope: 'https://otto.test',
      organizationId: 'org-a',
      accountId: 'alice',
      approverDevice,
      targetDevice,
    });
    expect(
      verifyE2eeDeviceCertificateApproval({
        approval,
        approverSigningPublicKey: first.identitySigningPublicKey,
      }).request.deviceId,
    ).toBe(second.deviceId);
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
    expect(JSON.parse(recovery)).toMatchObject({
      v: 2,
      kdf: 'scrypt',
      cipher: 'aes-256-gcm',
    });

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
    expect(() =>
      newBob.vault.importRecoveryBundle(
        'https://different-deployment.test',
        'bob',
        recovery,
        'correct horse battery staple',
      ),
    ).toThrow('bundle or passphrase is invalid');
    const tampered = JSON.parse(recovery) as Record<string, unknown>;
    tampered.accountHash = 'f'.repeat(64);
    expect(() =>
      newBob.vault.importRecoveryBundle(
        'https://otto.test',
        'bob',
        JSON.stringify(tampered),
        'correct horse battery staple',
      ),
    ).toThrow('bundle or passphrase is invalid');
  });

  it('returns only the signed and consumed A2A authorization scope', () => {
    const endpoint = createEndpoint('A2A owner');
    const receipt = endpoint.crypto.authorizeAtoaOnce({
      serverScope: 'https://otto.test',
      issuerDeploymentId: 'deployment-a',
      audienceDeploymentId: 'deployment-a',
      organizationId: 'org-a',
      issuerAccountId: 'alice',
      requesterAccountId: 'bob',
      requestMessageId: 'request-1',
      requestContent: 'Can Otto check the selected messages?',
      allowedSources: ['current_chat', 'schedules'],
      authorizedMessageIds: ['message-2', 'message-1'],
    });

    expect(receipt.grantDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.expiresAt).toBe('2026-07-31T00:03:00.000Z');
    expect(receipt.allowedSources).toEqual(['current_chat', 'schedules']);
    expect(receipt.authorizedMessageIds).toEqual(['message-1', 'message-2']);
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
