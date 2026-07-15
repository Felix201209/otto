export const DEFAULT_ENTERPRISE_SERVER_URL = 'https://59.110.154.44:7777';

const LEGACY_ENTERPRISE_SERVER_URLS = new Set([
  'https://59-110-154-44.sslip.io',
]);

export function defaultEnterpriseServerUrl(environmentValue: string | undefined): string {
  return environmentValue?.trim() || DEFAULT_ENTERPRISE_SERVER_URL;
}

export function migrateEnterpriseServerUrl(
  persistedValue: string | undefined,
  fallbackUrl: string,
): string {
  const value = persistedValue?.trim();
  if (!value) return fallbackUrl;

  const normalizedValue = value.replace(/\/+$/, '');
  return LEGACY_ENTERPRISE_SERVER_URLS.has(normalizedValue) ? fallbackUrl : value;
}
