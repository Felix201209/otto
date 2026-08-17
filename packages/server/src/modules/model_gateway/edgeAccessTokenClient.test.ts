/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../commercial_control/signedEnvelope.js';
import {
  requestEdgeGatewayAccessToken,
  type EdgeGatewayDeploymentCredentials,
} from './edgeAccessTokenClient.js';

const NOW = Date.parse('2026-08-17T08:00:00.000Z');
const NONCE = 'nonce_1234567890abcdef';
const CREDENTIALS: EdgeGatewayDeploymentCredentials = {
  licenseId: 'license_1',
  deploymentId: 'deployment_1',
  organizationId: 'organization_1',
  machineFingerprint: 'machine_1',
  leaseToken: 'lease-token-secret',
  leaseEndpoint: 'https://control.example.test/v1/licenses/lease',
  edgeGatewayUrl: 'https://edge.example.test',
};

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    token: {
      version: 1,
      tokenId: 'edge_token_1',
      deploymentId: CREDENTIALS.deploymentId,
      organizationId: CREDENTIALS.organizationId,
      subjectId: 'account_1',
      scope: 'model_gateway',
      policyVersion: 'policy_1',
      allowedModels: ['otto:deepseek'],
      issuedAtMs: NOW - 1_000,
      expiresAtMs: NOW + 5 * 60_000,
      ...overrides,
    },
    signingKeyId: 'key_1',
    signature: `ed25519:${'A'.repeat(86)}`,
  };
}

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function response(value = envelope()): Response {
  return Response.json({ envelope: value, encodedToken: encoded(value) }, { status: 201 });
}

describe('edge gateway access token client', () => {
  it('signs an exact Control request and returns a bound short-lived token', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://control.example.test/v1/edge-gateway/access-tokens');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        licenseId: CREDENTIALS.licenseId,
        deploymentId: CREDENTIALS.deploymentId,
        organizationId: CREDENTIALS.organizationId,
        machineFingerprint: CREDENTIALS.machineFingerprint,
        subjectId: 'account_1',
        allowedModels: ['otto:deepseek'],
      });
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${CREDENTIALS.leaseToken}`);
      expect(headers.get('x-otto-timestamp')).toBe(String(NOW));
      expect(headers.get('x-otto-nonce')).toBe(NONCE);
      expect(headers.get('x-otto-signature')).toBe(
        'hmac-sha256:' + createHmac('sha256', CREDENTIALS.leaseToken)
          .update(`${NOW}\n${NONCE}\n${canonicalJson(body)}`, 'utf8')
          .digest('base64url'),
      );
      return response();
    }) as typeof fetch;

    await expect(requestEdgeGatewayAccessToken({
      credentials: CREDENTIALS,
      subjectId: 'account_1',
      allowedModels: ['otto:deepseek'],
      fetchImpl,
      now: () => NOW,
      nonce: () => NONCE,
    })).resolves.toEqual({
      baseUrl: 'https://edge.example.test/v1',
      accessToken: encoded(envelope()),
      expiresAtMs: NOW + 5 * 60_000,
      allowedModels: ['otto:deepseek'],
    });
  });

  it('accepts only the non-empty policy-approved subset returned by Control', async () => {
    const value = envelope({ allowedModels: ['otto:deepseek'] });
    await expect(requestEdgeGatewayAccessToken({
      credentials: CREDENTIALS,
      subjectId: 'account_1',
      allowedModels: ['otto:deepseek', 'otto:qwen'],
      fetchImpl: vi.fn(async () => response(value)) as typeof fetch,
      now: () => NOW,
      nonce: () => NONCE,
    })).resolves.toMatchObject({
      allowedModels: ['otto:deepseek'],
    });
  });

  it.each([
    ['deployment', { deploymentId: 'deployment_2' }],
    ['organization', { organizationId: 'organization_2' }],
    ['subject', { subjectId: 'account_2' }],
    ['models', { allowedModels: ['otto:other'] }],
    ['expired', { expiresAtMs: NOW }],
    ['not yet valid', { issuedAtMs: NOW + 5 * 60_000 + 1 }],
    ['overlong', { expiresAtMs: NOW + 15 * 60_000 + 1 }],
  ])('fails closed for a %s token binding', async (_name, overrides) => {
    const value = envelope(overrides);
    await expect(requestEdgeGatewayAccessToken({
      credentials: CREDENTIALS,
      subjectId: 'account_1',
      allowedModels: ['otto:deepseek'],
      fetchImpl: vi.fn(async () => response(value)) as typeof fetch,
      now: () => NOW,
      nonce: () => NONCE,
    })).rejects.toThrow(/token/i);
  });

  it('rejects an encoded token that does not match the inspected envelope', async () => {
    const visible = envelope();
    const substituted = envelope({ subjectId: 'account_2' });
    const fetchImpl = vi.fn(async () => Response.json({
      envelope: visible,
      encodedToken: encoded(substituted),
    }, { status: 201 })) as typeof fetch;

    await expect(requestEdgeGatewayAccessToken({
      credentials: CREDENTIALS,
      subjectId: 'account_1',
      allowedModels: ['otto:deepseek'],
      fetchImpl,
      now: () => NOW,
      nonce: () => NONCE,
    })).rejects.toThrow(/token/i);
  });

  it.each([
    'http://edge.example.test',
    'https://user:pass@edge.example.test',
    'https://edge.example.test/v1',
    'https://edge.example.test?tenant=1',
    'https://edge.example.test#fragment',
  ])('rejects unsafe Edge gateway URL %s before making a request', async (edgeGatewayUrl) => {
    const fetchImpl = vi.fn() as typeof fetch;
    await expect(requestEdgeGatewayAccessToken({
      credentials: { ...CREDENTIALS, edgeGatewayUrl },
      subjectId: 'account_1',
      allowedModels: ['otto:deepseek'],
      fetchImpl,
      now: () => NOW,
      nonce: () => NONCE,
    })).rejects.toThrow(/gateway URL/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows HTTP only for loopback test gateways and Control endpoints', async () => {
    const value = envelope();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('http://127.0.0.1:4010/v1/edge-gateway/access-tokens');
      return response(value);
    }) as typeof fetch;

    await expect(requestEdgeGatewayAccessToken({
      credentials: {
        ...CREDENTIALS,
        leaseEndpoint: 'http://127.0.0.1:4010/v1/licenses/lease',
        edgeGatewayUrl: 'http://localhost:4020',
      },
      subjectId: 'account_1',
      allowedModels: ['otto:deepseek'],
      fetchImpl,
      now: () => NOW,
      nonce: () => NONCE,
    })).resolves.toMatchObject({ baseUrl: 'http://localhost:4020/v1' });
  });

  it.each([
    ['duplicate models', ['otto:deepseek', 'otto:deepseek'], NONCE],
    ['empty models', [], NONCE],
    ['short nonce', ['otto:deepseek'], 'too-short'],
  ])('rejects %s before sending secrets', async (_name, allowedModels, nonce) => {
    const fetchImpl = vi.fn() as typeof fetch;
    await expect(requestEdgeGatewayAccessToken({
      credentials: CREDENTIALS,
      subjectId: 'account_1',
      allowedModels,
      fetchImpl,
      now: () => NOW,
      nonce: () => nonce,
    })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not expose the lease token in network or response errors', async () => {
    for (const fetchImpl of [
      vi.fn(async () => { throw new Error(`network failed ${CREDENTIALS.leaseToken}`); }),
      vi.fn(async () => Response.json({ error: CREDENTIALS.leaseToken }, { status: 403 })),
    ]) {
      const error = await requestEdgeGatewayAccessToken({
        credentials: CREDENTIALS,
        subjectId: 'account_1',
        allowedModels: ['otto:deepseek'],
        fetchImpl: fetchImpl as typeof fetch,
        now: () => NOW,
        nonce: () => NONCE,
      }).catch((caught: unknown) => caught);
      expect(String(error)).not.toContain(CREDENTIALS.leaseToken);
    }
  });
});
