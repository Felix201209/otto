import { describe, expect, it } from 'vitest';

import { parseFederationStagingSmokeConfig } from '../smoke-federation-staging.mjs';

function environment(overrides = {}) {
  return {
    OTTO_FEDERATION_SMOKE_CONFIRM: 'STAGING_ONLY',
    OTTO_FEDERATION_SMOKE_GATEWAY_URL: 'https://federation.test',
    OTTO_FEDERATION_SMOKE_GATEWAY_ADMIN_TOKEN: 'gateway-admin-token',
    OTTO_FEDERATION_SMOKE_SERVER_A_URL: 'https://server-a.test',
    OTTO_FEDERATION_SMOKE_SERVER_A_ADMIN_TOKEN: 'server-a-admin-token',
    OTTO_FEDERATION_SMOKE_SERVER_A_MEMBER_TOKEN: 'server-a-member-token',
    OTTO_FEDERATION_SMOKE_SERVER_B_URL: 'https://server-b.test',
    OTTO_FEDERATION_SMOKE_SERVER_B_ADMIN_TOKEN: 'server-b-admin-token',
    OTTO_FEDERATION_SMOKE_SERVER_B_MEMBER_TOKEN: 'server-b-member-token',
    ...overrides,
  };
}

describe('federation staging smoke configuration', () => {
  it('requires an explicit staging-only confirmation', () => {
    expect(() => parseFederationStagingSmokeConfig(environment({
      OTTO_FEDERATION_SMOKE_CONFIRM: '',
    }))).toThrow('STAGING_ONLY');
  });

  it('accepts three HTTPS origins and keeps credentials out of URLs', () => {
    const config = parseFederationStagingSmokeConfig(environment({
      OTTO_FEDERATION_SMOKE_SOURCE_COMMIT: '1d8f944',
    }));
    expect(config).toMatchObject({
      gatewayUrl: 'https://federation.test',
      serverAUrl: 'https://server-a.test',
      serverBUrl: 'https://server-b.test',
      sourceCommit: '1d8f944',
    });
    expect(() => parseFederationStagingSmokeConfig(environment({
      OTTO_FEDERATION_SMOKE_SERVER_A_URL: 'https://user:secret@server-a.test',
    }))).toThrow('without credentials');
  });

  it('only permits HTTP for an explicitly enabled loopback test', () => {
    expect(() => parseFederationStagingSmokeConfig(environment({
      OTTO_FEDERATION_SMOKE_GATEWAY_URL: 'http://127.0.0.1:7790',
    }))).toThrow('HTTPS origin');
    const config = parseFederationStagingSmokeConfig(environment({
      OTTO_FEDERATION_SMOKE_ALLOW_HTTP: 'true',
      OTTO_FEDERATION_SMOKE_GATEWAY_URL: 'http://127.0.0.1:7790',
      OTTO_FEDERATION_SMOKE_SERVER_A_URL: 'http://localhost:7777',
      OTTO_FEDERATION_SMOKE_SERVER_B_URL: 'http://127.0.0.1:7778',
    }));
    expect(config).toMatchObject({
      gatewayUrl: 'http://127.0.0.1:7790',
      serverAUrl: 'http://localhost:7777',
      serverBUrl: 'http://127.0.0.1:7778',
    });
  });
});
