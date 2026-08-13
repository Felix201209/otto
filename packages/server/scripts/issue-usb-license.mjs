/** Control-side USB license issuer. Requires a built otto-server package. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { issueSignedLicense } from '../dist/src/modules/order_license/licenseIssuance.js';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const entitlementPath = arg('entitlement');
const privateKeyPath = arg('private-key');
const outputPath = arg('output');
if (!entitlementPath || !privateKeyPath || !outputPath) {
  throw new Error('usage: --entitlement entitlement.json --private-key signing-key.pem --output X:\\Otto\\许可证\\license.bin');
}
const entitlement = JSON.parse(await readFile(path.resolve(entitlementPath), 'utf8'));
const signingPrivateKey = await readFile(path.resolve(privateKeyPath), 'utf8');
const signingKeyId = arg('key-id');
if (!signingKeyId) throw new Error('--key-id is required and must match the trusted public key id');
const envelope = issueSignedLicense({
  entitlement,
  signingPrivateKey,
  signingKeyId,
  rollbackSequence: Number(arg('rollback-sequence') || 1),
  activationNonce: randomUUID(),
});
await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await writeFile(path.resolve(outputPath), `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
console.log(`USB license written: ${path.resolve(outputPath)}`);
