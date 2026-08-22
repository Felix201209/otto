#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const host = required('OTTO_ENTERPRISE_HOST');
if (host !== '127.0.0.1') {
  throw new Error(
    'OTTO_ENTERPRISE_HOST must be 127.0.0.1 in the managed deployment',
  );
}
const port = Number(required('OTTO_ENTERPRISE_PORT'));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(
    'OTTO_ENTERPRISE_PORT must be an integer between 1 and 65535',
  );
}
const publicUrl = required('OTTO_ENTERPRISE_PUBLIC_URL');
const parsedPublicUrl = new URL(publicUrl);
if (
  parsedPublicUrl.protocol !== 'https:' ||
  parsedPublicUrl.username ||
  parsedPublicUrl.password
) {
  throw new Error(
    'OTTO_ENTERPRISE_PUBLIC_URL must be a credential-free HTTPS URL',
  );
}
const appVersion = required('OTTO_APP_VERSION');
const buildCommit = required('OTTO_BUILD_COMMIT');
if (!/^[0-9a-f]{40}$/i.test(buildCommit)) {
  throw new Error(
    'OTTO_BUILD_COMMIT must be a 40-character hexadecimal build id',
  );
}
const adminToken = required('OTTO_ENTERPRISE_ADMIN_TOKEN');
if (adminToken.length < 32) {
  throw new Error(
    'OTTO_ENTERPRISE_ADMIN_TOKEN must contain at least 32 characters',
  );
}
if (required('OTTO_ENTERPRISE_TRUST_PROXY_HOPS') !== '1') {
  throw new Error(
    'OTTO_ENTERPRISE_TRUST_PROXY_HOPS must be exactly 1 behind managed Caddy',
  );
}

const licenseTrustFile = path.resolve(required('OTTO_LICENSE_TRUST_FILE'));
const trustMetadata = fs.lstatSync(licenseTrustFile);
if (trustMetadata.isSymbolicLink() || !trustMetadata.isFile()) {
  throw new Error(
    'OTTO_LICENSE_TRUST_FILE must be a regular file from the signed release',
  );
}
const licensePublicKeys = JSON.parse(fs.readFileSync(licenseTrustFile, 'utf8'));
if (
  !Array.isArray(licensePublicKeys) ||
  licensePublicKeys.length === 0 ||
  licensePublicKeys.some(
    (key) => typeof key !== 'string' || !key.includes('BEGIN PUBLIC KEY'),
  )
) {
  throw new Error('signed release license trust store is invalid');
}
process.env.NODE_ENV = 'production';
process.env.OTTO_LICENSE_ENFORCE = 'true';
process.env.OTTO_LICENSE_PUBLIC_KEYS = JSON.stringify(licensePublicKeys);

const controlTrustFileValue = process.env.OTTO_CONTROL_TRUST_FILE?.trim();
const bootstrapSecretFileValue =
  process.env.OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE?.trim();
let bootstrapSecretFileExists = false;
if (bootstrapSecretFileValue) {
  try {
    fs.lstatSync(path.resolve(bootstrapSecretFileValue));
    bootstrapSecretFileExists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
if (bootstrapSecretFileExists && !controlTrustFileValue) {
  throw new Error(
    'OTTO_CONTROL_TRUST_FILE is required for automatic deployment enrollment',
  );
}
if (controlTrustFileValue) {
  const controlTrustFile = path.resolve(controlTrustFileValue);
  const controlTrustMetadata = fs.lstatSync(controlTrustFile);
  if (controlTrustMetadata.isSymbolicLink() || !controlTrustMetadata.isFile()) {
    throw new Error('OTTO_CONTROL_TRUST_FILE must be a regular file');
  }
  const controlPublicKeys = JSON.parse(
    fs.readFileSync(controlTrustFile, 'utf8'),
  );
  if (
    !Array.isArray(controlPublicKeys) ||
    controlPublicKeys.length === 0 ||
    controlPublicKeys.some(
      (key) => typeof key !== 'string' || !key.includes('BEGIN PUBLIC KEY'),
    )
  ) {
    throw new Error('Control command trust store is invalid');
  }
  process.env.OTTO_ENTERPRISE_CONTROL_PUBLIC_KEYS =
    JSON.stringify(controlPublicKeys);
}

const { closeEnterpriseDatabase } = await import('./src/enterprise/db.js');
const { startEnterpriseServer } = await import('./src/enterprise/server.js');

const server = startEnterpriseServer({
  host,
  port,
  publicUrl,
  adminToken,
  appVersion,
  buildCommit,
});

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(
    `[Otto Enterprise] ${signal} received, draining connections\n`,
  );
  const forceTimer = setTimeout(() => {
    process.stderr.write('[Otto Enterprise] graceful shutdown timed out\n');
    server.closeAllConnections?.();
    closeEnterpriseDatabase();
    process.exit(1);
  }, 15_000);
  forceTimer.unref();
  server.close((error) => {
    clearTimeout(forceTimer);
    closeEnterpriseDatabase();
    if (error) {
      process.stderr.write(
        `[Otto Enterprise] shutdown failed: ${error.message}\n`,
      );
      process.exit(1);
    }
    process.exit(0);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
