/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type PublicUrlLookup = typeof lookup;

function blockedIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) {
    return true;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function blockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  const mappedIpv4 = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return blockedIpv4(mappedIpv4);
  return (
    /^f[cd]/.test(normalized) ||
    /^fe[89ab]/.test(normalized) ||
    /^ff/.test(normalized) ||
    /^2001:db8(?::|$)/.test(normalized)
  );
}

export function isBlockedWebAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return blockedIpv4(address);
  if (version === 6) return blockedIpv6(address);
  return true;
}

function blockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal')
  );
}

/** Validate both the URL syntax and every resolved address before a request. */
export async function assertPublicWebUrl(
  rawUrl: string,
  lookupFn: PublicUrlLookup = lookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('web_fetch only accepts valid absolute URLs');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('web_fetch only allows HTTP and HTTPS URLs');
  }
  if (url.username || url.password) {
    throw new Error('web_fetch does not allow credentials in URLs');
  }
  if (blockedHostname(url.hostname)) {
    throw new Error(`web_fetch blocked non-public host: ${url.hostname}`);
  }
  if (isIP(url.hostname)) {
    if (isBlockedWebAddress(url.hostname)) {
      throw new Error(`web_fetch blocked non-public address: ${url.hostname}`);
    }
    return url;
  }

  let addresses: LookupAddress[];
  try {
    addresses = (await lookupFn(url.hostname, {
      all: true,
      verbatim: true,
    })) as LookupAddress[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`web_fetch could not resolve ${url.hostname}: ${message}`);
  }
  if (addresses.length === 0) {
    throw new Error(`web_fetch could not resolve ${url.hostname}`);
  }
  const blocked = addresses.find((item) => isBlockedWebAddress(item.address));
  if (blocked) {
    throw new Error(
      `web_fetch blocked ${url.hostname} because it resolves to a non-public address`,
    );
  }
  return url;
}

export interface SafePublicFetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRedirects?: number;
  fetchFn?: typeof fetch;
  lookupFn?: PublicUrlLookup;
}

/** Fetch a public URL while validating every redirect target. */
export async function safeFetchPublicUrl(
  rawUrl: string,
  options: SafePublicFetchOptions = {},
): Promise<Response> {
  const timeoutController = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signals = options.signal
    ? [options.signal, timeoutController.signal]
    : [timeoutController.signal];
  const signal = AbortSignal.any(signals);
  const fetchFn = options.fetchFn ?? fetch;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let currentUrl = rawUrl;

  try {
    for (
      let redirectCount = 0;
      redirectCount <= maxRedirects;
      redirectCount += 1
    ) {
      const validated = await assertPublicWebUrl(currentUrl, options.lookupFn);
      const response = await fetchFn(validated, {
        redirect: 'manual',
        signal,
      });
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location)
        throw new Error('web_fetch received a redirect without Location');
      if (redirectCount === maxRedirects) {
        throw new Error(`web_fetch exceeded ${maxRedirects} redirects`);
      }
      currentUrl = new URL(location, validated).toString();
    }
    throw new Error(`web_fetch exceeded ${maxRedirects} redirects`);
  } catch (error) {
    if (timeoutController.signal.aborted && !options.signal?.aborted) {
      throw new Error(`web_fetch timed out after ${timeoutMs / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
