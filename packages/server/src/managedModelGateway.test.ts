/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createManagedModelConfig,
  ManagedModelUnavailableError,
} from './managedModelGateway.js';
import type { AuthenticatedManagedModelGateway } from './productWorkspaceStore.js';

const gateway = (
  patch: Partial<AuthenticatedManagedModelGateway> = {},
): AuthenticatedManagedModelGateway => ({
  baseUrl: 'https://edge.otto.test/v1',
  accessToken: 'edge-token-first-at-least-thirty-two-characters',
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  allowedModels: ['otto:deepseek'],
  ...patch,
});

describe('managed model gateway runtime configuration', () => {
  it('uses the latest in-memory short token without putting it in apiKey', async () => {
    let access = gateway();
    const provider = vi.fn(() => access);
    const config = createManagedModelConfig('otto:deepseek', provider);

    expect(config).toMatchObject({
      provider: 'openai',
      baseUrl: 'https://edge.otto.test/v1',
      modelId: 'otto:deepseek',
      apiKey: '__OTTO_MANAGED_RUNTIME_TOKEN__',
    });
    await expect(config.apiKeyProvider?.()).resolves.toBe(
      access.accessToken,
    );
    access = gateway({
      accessToken: 'edge-token-refreshed-at-least-thirty-two-characters',
    });
    await expect(config.apiKeyProvider?.()).resolves.toBe(
      access.accessToken,
    );
  });

  it('fails closed when access expires, model binding changes, or Edge origin changes', async () => {
    let access = gateway();
    const config = createManagedModelConfig('otto:deepseek', () => access);

    access = gateway({ expiresAt: '2000-01-01T00:00:00.000Z' });
    await expect(config.apiKeyProvider?.()).rejects.toBeInstanceOf(
      ManagedModelUnavailableError,
    );
    access = gateway({ allowedModels: ['otto:qwen'] });
    await expect(config.apiKeyProvider?.()).rejects.toBeInstanceOf(
      ManagedModelUnavailableError,
    );
    access = gateway({ baseUrl: 'https://other-edge.otto.test/v1' });
    await expect(config.apiKeyProvider?.()).rejects.toBeInstanceOf(
      ManagedModelUnavailableError,
    );
  });

  it('rejects managed models without a valid current enterprise grant', () => {
    expect(() =>
      createManagedModelConfig('otto:deepseek', () => null),
    ).toThrow(ManagedModelUnavailableError);
    expect(() =>
      createManagedModelConfig('otto:not-in-catalog', () => gateway()),
    ).toThrow(/未知/);
  });
});
