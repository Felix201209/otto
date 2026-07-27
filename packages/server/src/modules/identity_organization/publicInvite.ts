/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Public enterprise onboarding links.
 *
 * The public base URL is configuration, never request metadata. In particular,
 * Host and X-Forwarded-Host are not trusted because either can be supplied by a
 * client when a reverse proxy is misconfigured.
 */

export const DEFAULT_ENTERPRISE_PUBLIC_URL = 'https://59.110.154.44:7777';

const ORGANIZATION_INVITE_CODE_PATTERN = /^[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}$/;

export interface EnterprisePublicBaseUrlOptions {
  /** Explicit option or OTTO_ENTERPRISE_PUBLIC_URL. */
  configuredUrl?: string;
  /** Accepted for call-site context only; never used to construct the public URL. */
  host?: string;
  /** Accepted for call-site context only; never used to construct the public URL. */
  port?: number;
}

function invalidPublicUrl(): Error {
  return new Error(
    'OTTO_ENTERPRISE_PUBLIC_URL 必须是无账号、query 或 fragment 的 HTTP(S) 公网基址',
  );
}

/**
 * Normalize the configured public base while retaining an optional deployment
 * path prefix. An empty value intentionally falls back to Otto's built-in,
 * certificate-verified public endpoint.
 */
export function resolveEnterprisePublicBaseUrl(
  options: EnterprisePublicBaseUrlOptions = {},
): string {
  const raw = options.configuredUrl?.trim() || DEFAULT_ENTERPRISE_PUBLIC_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidPublicUrl();
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw invalidPublicUrl();
  }

  const pathPrefix = parsed.pathname === '/'
    ? ''
    : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathPrefix}`;
}

export function isOrganizationInviteCode(code: string): boolean {
  return ORGANIZATION_INVITE_CODE_PATTERN.test(code);
}

export function buildOrganizationInviteLink(baseUrl: string, code: string): string {
  if (!isOrganizationInviteCode(code)) {
    throw new Error('企业邀请码格式无效');
  }
  const normalizedBase = resolveEnterprisePublicBaseUrl({ configuredUrl: baseUrl });
  return `${normalizedBase}/enterprise/join/${code}`;
}
