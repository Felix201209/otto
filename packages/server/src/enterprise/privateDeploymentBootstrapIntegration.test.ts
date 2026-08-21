/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { privateDeploymentBootstrapConfigFromEnvironment } from './privateDeploymentBootstrapIntegration.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('private deployment bootstrap environment', () => {
  it('keeps the one-time secret server-side and accepts a service-readable file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-bootstrap-'));
    temporaryDirectories.push(directory);
    const secretFile = path.join(directory, 'bootstrap-secret');
    fs.writeFileSync(secretFile, 'x'.repeat(48), { mode: 0o600 });

    expect(privateDeploymentBootstrapConfigFromEnvironment({
      appVersion: '1.10.2',
      buildCommit: 'a'.repeat(40),
      publicOrigin: 'https://customer.otto.example',
      environment: {
        NODE_ENV: 'production',
        OTTO_CONTROL_URL: 'https://control.otto.example',
        OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE: secretFile,
      },
    })).toMatchObject({
      controlUrl: 'https://control.otto.example',
      bootstrapSecret: 'x'.repeat(48),
      publicOrigin: 'https://customer.otto.example',
      allowInsecureLoopback: false,
    });
  });

  it('does not configure Control when either endpoint or secret is absent', () => {
    expect(privateDeploymentBootstrapConfigFromEnvironment({
      appVersion: '1.10.2',
      buildCommit: 'a'.repeat(40),
      publicOrigin: 'https://customer.otto.example',
      environment: { NODE_ENV: 'production' },
    })).toBeNull();
    expect(privateDeploymentBootstrapConfigFromEnvironment({
      appVersion: '1.10.2',
      buildCommit: 'a'.repeat(40),
      publicOrigin: 'https://customer.otto.example',
      environment: {
        NODE_ENV: 'production',
        OTTO_DEPLOYMENT_BOOTSTRAP_SECRET: 'x'.repeat(48),
      },
    })).toBeNull();
  });
});
