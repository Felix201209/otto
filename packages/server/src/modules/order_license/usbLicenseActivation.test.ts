import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicKeyId, signEd25519Envelope } from '../commercial_control/signedEnvelope.js';
import { activateUsbLicense } from './usbLicenseActivation.js';

const keys = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'otto-usb-license-'));
  const licensePath = path.join(dir, 'license.bin');
  const statePath = path.join(dir, 'license-state.json');
  const license = { id: 'lic-usb', activationNonce: 'nonce-unique-1', offline: true };
  await writeFile(licensePath, JSON.stringify({
    license,
    signature: signEd25519Envelope(license, keys.privateKey),
    signingKeyId: publicKeyId(keys.publicKey),
  }));
  let protectedState: string | null = null;
  return { dir, licensePath, statePath, getProtected: async () => protectedState,
    setProtected: async (_licenseId: string, value: string) => { protectedState = value; } };
}

describe('USB single activation license', () => {
  it('accepts a valid signature and the same machine twice', async () => {
    const f = await fixture();
    try {
      const deps = { publicKeys: [keys.publicKey], fingerprint: async () => 'fp-a',
        readProtectedState: f.getProtected, writeProtectedState: f.setProtected };
      await expect(activateUsbLicense({ licensePath: f.licensePath, statePath: f.statePath }, deps))
        .resolves.toMatchObject({ activated: true, fingerprint: 'fp-a' });
      await expect(activateUsbLicense({ licensePath: f.licensePath, statePath: f.statePath }, deps))
        .resolves.toMatchObject({ activated: false, fingerprint: 'fp-a' });
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });

  it('rejects an invalid signature', async () => {
    const f = await fixture();
    try {
      const envelope = JSON.parse(await readFile(f.licensePath, 'utf8'));
      envelope.license.id = 'tampered';
      await writeFile(f.licensePath, JSON.stringify(envelope));
      await expect(activateUsbLicense({ licensePath: f.licensePath, statePath: f.statePath }, {
        publicKeys: [keys.publicKey], fingerprint: async () => 'fp-a',
        readProtectedState: f.getProtected, writeProtectedState: f.setProtected,
      })).rejects.toThrow('签名无效');
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });

  it('rejects another machine', async () => {
    const f = await fixture();
    try {
      const common = { publicKeys: [keys.publicKey], readProtectedState: f.getProtected,
        writeProtectedState: f.setProtected };
      await activateUsbLicense({ licensePath: f.licensePath, statePath: f.statePath },
        { ...common, fingerprint: async () => 'fp-a' });
      await expect(activateUsbLicense({ licensePath: f.licensePath, statePath: f.statePath },
        { ...common, fingerprint: async () => 'fp-b' })).rejects.toThrow('另一台机器');
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });

  it('rejects after USB state deletion because protected state remains', async () => {
    const f = await fixture();
    try {
      const common = { publicKeys: [keys.publicKey], readProtectedState: f.getProtected,
        writeProtectedState: f.setProtected };
      await activateUsbLicense({ licensePath: f.licensePath, statePath: f.statePath },
        { ...common, fingerprint: async () => 'fp-a' });
      await unlink(f.statePath);
      await expect(activateUsbLicense({ licensePath: f.licensePath, statePath: f.statePath },
        { ...common, fingerprint: async () => 'fp-b' })).rejects.toThrow('另一台机器');
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
});
