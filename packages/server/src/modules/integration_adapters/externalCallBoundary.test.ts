/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ExternalCallBlockedError,
  ExternalCallBoundary,
  InMemoryExternalWriteJournal,
  type ExternalCallAuditEvent,
} from './externalCallBoundary.js';

const metadata = {
  kind: 'http' as const,
  origin: 'park.repair-notification',
  provider: 'feishu',
  tokenUsage: { input: 12, output: 4 },
  estimatedCost: { amount: 0.002, currency: 'CNY' },
};

describe('ExternalCallBoundary', () => {
  it('intercepts a call before the provider and audits the blocked attempt', async () => {
    const events: ExternalCallAuditEvent[] = [];
    const provider = vi.fn();
    const boundary = new ExternalCallBoundary({
      audit: (event) => events.push(event),
      allow: () => false,
    });

    await expect(boundary.read(metadata, provider)).rejects.toBeInstanceOf(
      ExternalCallBlockedError,
    );
    expect(provider).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        outcome: 'blocked',
        origin: metadata.origin,
        provider: metadata.provider,
        retryCount: 0,
        tokenUsage: { input: 12, output: 4 },
        estimatedCost: { amount: 0.002, currency: 'CNY' },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('Bearer');
  });

  it('requires an idempotency key and persists commit state for writes', async () => {
    const journal = new InMemoryExternalWriteJournal();
    const boundary = new ExternalCallBoundary({
      journal,
      audit: () => undefined,
    });
    const provider = vi.fn(
      async ({ idempotencyKey }) => `sent:${idempotencyKey}`,
    );

    await expect(
      boundary.write({ ...metadata, idempotencyKey: '' }, provider),
    ).rejects.toThrow(/idempotency key/i);

    await expect(
      boundary.write({ ...metadata, idempotencyKey: 'repair:42' }, provider),
    ).resolves.toBe('sent:repair:42');
    expect(journal.get('repair:42')).toMatchObject({
      status: 'committed',
      attempts: 1,
    });

    await expect(
      boundary.write({ ...metadata, idempotencyKey: 'repair:42' }, provider),
    ).resolves.toBeUndefined();
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('recovers only the failed write with the same idempotency key', async () => {
    const events: ExternalCallAuditEvent[] = [];
    const journal = new InMemoryExternalWriteJournal();
    const boundary = new ExternalCallBoundary({
      journal,
      audit: (event) => events.push(event),
    });
    const provider = vi
      .fn<({ idempotencyKey }: { idempotencyKey: string }) => Promise<string>>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('accepted');

    await expect(
      boundary.write({ ...metadata, idempotencyKey: 'repair:43' }, provider),
    ).rejects.toThrow('timeout');
    expect(journal.get('repair:43')).toMatchObject({
      status: 'failed',
      attempts: 1,
    });

    await expect(boundary.recover('repair:43', provider)).resolves.toBe(
      'accepted',
    );
    expect(journal.get('repair:43')).toMatchObject({
      status: 'committed',
      attempts: 2,
    });
    expect(events.at(-1)).toMatchObject({ outcome: 'committed', retryCount: 1 });
    expect(provider).toHaveBeenNthCalledWith(2, {
      idempotencyKey: 'repair:43',
      retryCount: 1,
    });
  });

  it('rejects reuse of an idempotency key for a different operation', async () => {
    const journal = new InMemoryExternalWriteJournal();
    const boundary = new ExternalCallBoundary({
      journal,
      audit: () => undefined,
    });
    const provider = vi.fn(async () => undefined);

    await boundary.write(
      { ...metadata, idempotencyKey: 'stable-key' },
      provider,
    );
    await expect(
      boundary.write(
        { ...metadata, origin: 'another-origin', idempotencyKey: 'stable-key' },
        provider,
      ),
    ).rejects.toThrow(/different external operation/i);
  });
});
