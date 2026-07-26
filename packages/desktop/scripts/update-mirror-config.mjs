export const DEFAULT_UPDATE_ASSET_BASE_URL =
  'https://59.110.154.44:7777/downloads';

export function resolveUpdateAssetBaseUrl(
  candidate = process.env.OTTO_UPDATE_ASSET_BASE_URL,
) {
  const raw = candidate?.trim() || DEFAULT_UPDATE_ASSET_BASE_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid OTTO_UPDATE_ASSET_BASE_URL: ${raw}`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(
      'OTTO_UPDATE_ASSET_BASE_URL must be an HTTPS URL without credentials, query, or fragment',
    );
  }
  return parsed.toString().replace(/\/+$/, '');
}
