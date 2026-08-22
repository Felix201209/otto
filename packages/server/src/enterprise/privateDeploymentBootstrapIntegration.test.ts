/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { PrivateDeploymentReadiness } from '../modules/deployment_lifecycle/index.js';
import {
  canConsumePrivateDeploymentBootstrapSecret,
  consumePrivateDeploymentBootstrapSecretFile,
  privateDeploymentBootstrapConfigFromEnvironment,
} from './privateDeploymentBootstrapIntegration.js';

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

  it('treats an already consumed secret file as not configured', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-bootstrap-'));
    temporaryDirectories.push(directory);
    const secretFile = path.join(directory, 'already-consumed-secret');

    expect(
      privateDeploymentBootstrapConfigFromEnvironment({
        appVersion: '1.10.2',
        buildCommit: 'a'.repeat(40),
        publicOrigin: 'https://customer.otto.example',
        environment: {
          NODE_ENV: 'production',
          OTTO_CONTROL_URL: 'https://control.otto.example',
          OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE: secretFile,
        },
      }),
    ).toBeNull();
  });

  it('only permits secret consumption after activation and account identity readiness', () => {
    const ready: PrivateDeploymentReadiness = {
      state: 'ready',
      canAuthenticate: true,
      canUseLicensedFeatures: true,
      bootstrap: {
        phase: 'activated',
        lastAttemptAt: '2026-08-22T00:00:00.000Z',
        lastSuccessAt: '2026-08-22T00:00:00.000Z',
        errorCode: null,
      },
      steps: [{
        id: 'account_identity',
        state: 'ready',
        required: true,
        message: 'ready',
      }],
    };

    expect(canConsumePrivateDeploymentBootstrapSecret(ready)).toBe(true);
    expect(canConsumePrivateDeploymentBootstrapSecret({
      ...ready,
      bootstrap: { ...ready.bootstrap, phase: 'failed' },
    })).toBe(false);
    expect(canConsumePrivateDeploymentBootstrapSecret({
      ...ready,
      canUseLicensedFeatures: false,
    })).toBe(false);
    expect(canConsumePrivateDeploymentBootstrapSecret({
      ...ready,
      steps: [{ ...ready.steps[0], state: 'waiting_for_user' }],
    })).toBe(false);
  });

  it('consumes a successful one-time secret file idempotently', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-bootstrap-'));
    temporaryDirectories.push(directory);
    const secretFile = path.join(directory, 'bootstrap-secret');
    fs.writeFileSync(secretFile, 'x'.repeat(48), { mode: 0o600 });
    const environment: NodeJS.ProcessEnv = {
      OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE: secretFile,
    };

    consumePrivateDeploymentBootstrapSecretFile(environment);

    expect(fs.existsSync(secretFile)).toBe(false);
    expect(environment.OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE).toBeUndefined();
    expect(() =>
      consumePrivateDeploymentBootstrapSecretFile(environment),
    ).not.toThrow();
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
