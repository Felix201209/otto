import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UPDATE_ASSET_BASE_URL,
  resolveUpdateAssetBaseUrl,
} from './update-mirror-config.mjs';

describe('update mirror configuration', () => {
  it('defaults release assets to the Otto no-proxy mirror', () => {
    expect(resolveUpdateAssetBaseUrl('')).toBe(DEFAULT_UPDATE_ASSET_BASE_URL);
    expect(DEFAULT_UPDATE_ASSET_BASE_URL).toBe(
      'https://59.110.154.44:7777/downloads',
    );
  });

  it('accepts a private HTTPS mirror and removes trailing slashes', () => {
    expect(resolveUpdateAssetBaseUrl('https://updates.example.com/otto///')).toBe(
      'https://updates.example.com/otto',
    );
  });

  it.each([
    'http://updates.example.com/downloads',
    'file:///tmp/downloads',
    'https://user:password@updates.example.com/downloads',
    'https://updates.example.com/downloads?channel=stable',
    'https://updates.example.com/downloads#stable',
    'not-a-url',
  ])('rejects unsafe mirror URL %s', (value) => {
    expect(() => resolveUpdateAssetBaseUrl(value)).toThrow(
      /OTTO_UPDATE_ASSET_BASE_URL/,
    );
  });
});
