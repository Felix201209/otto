/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import {
  assertPublicWebUrl,
  isBlockedWebAddress,
  safeFetchPublicUrl,
  type PublicUrlLookup,
} from './web-fetch-security.js';

function lookupAddress(address: string): PublicUrlLookup {
  return vi
    .fn()
    .mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
}

describe('web_fetch public URL security', () => {
  it('blocks private, loopback and metadata addresses', async () => {
    expect(isBlockedWebAddress('127.0.0.1')).toBe(true);
    expect(isBlockedWebAddress('169.254.169.254')).toBe(true);
    expect(isBlockedWebAddress('192.168.1.1')).toBe(true);
    expect(isBlockedWebAddress('8.8.8.8')).toBe(false);
    await expect(assertPublicWebUrl('http://127.0.0.1/admin')).rejects.toThrow(
      'non-public',
    );
  });

  it('blocks public-looking hostnames that resolve to private addresses', async () => {
    await expect(
      assertPublicWebUrl('https://example.com', lookupAddress('10.0.0.8')),
    ).rejects.toThrow('resolves to a non-public address');
  });

  it('accepts public addresses and rejects URL credentials', async () => {
    await expect(
      assertPublicWebUrl(
        'https://example.com/path',
        lookupAddress('93.184.216.34'),
      ),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertPublicWebUrl(
        'https://user:pass@example.com',
        lookupAddress('93.184.216.34'),
      ),
    ).rejects.toThrow('credentials');
  });

  it('revalidates redirects and blocks redirects to metadata services', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      }),
    );
    await expect(
      safeFetchPublicUrl('https://example.com', {
        fetchFn,
        lookupFn: lookupAddress('93.184.216.34'),
      }),
    ).rejects.toThrow('non-public');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
