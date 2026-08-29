import { describe, expect, it, vi } from 'vitest';

import { CustomerModuleHostBroker } from './customerModuleHost.js';

describe('CustomerModuleHostBroker', () => {
  it('rejects undeclared capabilities before invoking an adapter', async () => {
    const invoke = vi.fn();
    const broker = new CustomerModuleHostBroker({ invoke });
    await expect(broker.request({
      moduleId: 'com.acme.report', version: '1.0.0', capability: 'http',
      approvedCapabilities: [], payload: { url: 'https://api.acme.test' },
    })).rejects.toThrow(/not approved/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('requires an idempotency key for external writes', async () => {
    const broker = new CustomerModuleHostBroker({ invoke: vi.fn() });
    await expect(broker.request({
      moduleId: 'com.acme.report', version: '1.0.0', capability: 'http',
      approvedCapabilities: ['http'], payload: { method: 'POST', url: 'https://api.acme.test' },
      externalWrite: true,
    })).rejects.toThrow(/idempotency/);
  });

  it('records origin, provider, retries, token usage and cost without raw credentials', async () => {
    const audits: unknown[] = [];
    const broker = new CustomerModuleHostBroker({
      invoke: vi.fn().mockResolvedValue({
        data: { text: 'ok' }, provider: 'openai', inputTokens: 10, outputTokens: 4,
        retryCount: 1, estimatedCostUsd: 0.002,
      }),
      onAudit: (event) => audits.push(event),
    });
    await broker.request({
      moduleId: 'com.acme.report', version: '1.0.0', capability: 'model',
      approvedCapabilities: ['model'], payload: { prompt: 'hello', apiKey: 'secret' },
    });
    expect(audits).toEqual([expect.objectContaining({
      origin: 'customer-module:com.acme.report@1.0.0', provider: 'openai',
      inputTokens: 10, outputTokens: 4, retryCount: 1, estimatedCostUsd: 0.002,
    })]);
    expect(JSON.stringify(audits)).not.toContain('secret');
  });

  it('audits failed host calls without copying adapter errors or payload secrets', async () => {
    const audits: unknown[] = [];
    const broker = new CustomerModuleHostBroker({
      invoke: vi.fn().mockRejectedValue(new Error('provider leaked secret-token')),
      onAudit: (event) => audits.push(event),
    });
    await expect(broker.request({
      moduleId: 'com.acme.report', version: '1.0.0', capability: 'model',
      approvedCapabilities: ['model'], payload: { apiKey: 'secret-token' },
    })).rejects.toThrow();
    expect(audits).toEqual([expect.objectContaining({ outcome: 'failed', commitStatus: 'failed' })]);
    expect(JSON.stringify(audits)).not.toContain('secret-token');
  });
});
