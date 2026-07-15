import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENTERPRISE_SERVER_URL,
  defaultEnterpriseServerUrl,
  migrateEnterpriseServerUrl,
} from './enterprise-server-url.js';

describe('enterprise server URL', () => {
  it('uses the reachable IP HTTPS endpoint by default', () => {
    expect(DEFAULT_ENTERPRISE_SERVER_URL).toBe('https://59.110.154.44:7777');
    expect(defaultEnterpriseServerUrl(undefined)).toBe(DEFAULT_ENTERPRISE_SERVER_URL);
  });

  it('keeps an explicit environment override', () => {
    expect(defaultEnterpriseServerUrl('  https://enterprise.example.com/  ')).toBe(
      'https://enterprise.example.com/',
    );
  });

  it('migrates the blocked legacy endpoint from persisted sessions', () => {
    expect(
      migrateEnterpriseServerUrl(
        'https://59-110-154-44.sslip.io/',
        DEFAULT_ENTERPRISE_SERVER_URL,
      ),
    ).toBe(DEFAULT_ENTERPRISE_SERVER_URL);
  });

  it('preserves a custom persisted endpoint', () => {
    expect(
      migrateEnterpriseServerUrl('https://otto.example.com/', DEFAULT_ENTERPRISE_SERVER_URL),
    ).toBe('https://otto.example.com/');
  });
});
