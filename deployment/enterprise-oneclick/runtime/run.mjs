#!/usr/bin/env node

import { closeEnterpriseDatabase } from './src/enterprise/db.js';
import { startEnterpriseServer } from './src/enterprise/server.js';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const host = required('OTTO_ENTERPRISE_HOST');
if (host !== '127.0.0.1') {
  throw new Error('OTTO_ENTERPRISE_HOST must be 127.0.0.1 in the managed deployment');
}
const port = Number(required('OTTO_ENTERPRISE_PORT'));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('OTTO_ENTERPRISE_PORT must be an integer between 1 and 65535');
}
const publicUrl = required('OTTO_ENTERPRISE_PUBLIC_URL');
const parsedPublicUrl = new URL(publicUrl);
if (parsedPublicUrl.protocol !== 'https:' || parsedPublicUrl.username || parsedPublicUrl.password) {
  throw new Error('OTTO_ENTERPRISE_PUBLIC_URL must be a credential-free HTTPS URL');
}
const appVersion = required('OTTO_APP_VERSION');
const buildCommit = required('OTTO_BUILD_COMMIT');
if (!/^[0-9a-f]{40}$/i.test(buildCommit)) {
  throw new Error('OTTO_BUILD_COMMIT must be a 40-character hexadecimal build id');
}
const adminToken = required('OTTO_ENTERPRISE_ADMIN_TOKEN');
if (adminToken.length < 32) {
  throw new Error('OTTO_ENTERPRISE_ADMIN_TOKEN must contain at least 32 characters');
}
if (required('OTTO_ENTERPRISE_TRUST_PROXY_HOPS') !== '1') {
  throw new Error('OTTO_ENTERPRISE_TRUST_PROXY_HOPS must be exactly 1 behind managed Caddy');
}

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
  process.stdout.write(`[Otto Enterprise] ${signal} received, draining connections\n`);
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
      process.stderr.write(`[Otto Enterprise] shutdown failed: ${error.message}\n`);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
