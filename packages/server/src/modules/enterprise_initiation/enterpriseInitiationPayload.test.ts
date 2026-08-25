/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseEnterpriseInitiationPayload } from './enterpriseInitiationPayload.js';

function validPayload(): Record<string, unknown> {
  return {
    organization: {
      id: 'org_beikong_001',
      name: '北控宏创',
      slug: 'BeiKong-HongChuang',
    },
    ceo: {
      username: 'ceo.beikong',
      name: '企业负责人',
      phone: '138-0013-8000',
    },
    defaultDepartmentName: '总经办',
    modules: ['enterprise_tree', 'direct_messages', 'direct_messages'],
  };
}

describe('enterprise.initiate payload parser', () => {
  it('accepts and normalizes the exact production contract', () => {
    expect(parseEnterpriseInitiationPayload(validPayload())).toEqual({
      organization: {
        id: 'org_beikong_001',
        name: '北控宏创',
        slug: 'beikong-hongchuang',
      },
      ceo: {
        username: 'ceo.beikong',
        name: '企业负责人',
        phone: '+8613800138000',
      },
      defaultDepartmentName: '总经办',
      modules: ['enterprise_tree', 'direct_messages'],
    });
  });

  it.each([
    ['root', { ...validPayload(), unexpected: true }],
    [
      'organization',
      {
        ...validPayload(),
        organization: {
          ...(validPayload().organization as Record<string, unknown>),
          secret: 'must-not-pass',
        },
      },
    ],
    [
      'ceo',
      {
        ...validPayload(),
        ceo: {
          ...(validPayload().ceo as Record<string, unknown>),
          password: 'must-not-pass',
        },
      },
    ],
  ])('rejects unknown fields at %s', (_label, payload) => {
    expect(() => parseEnterpriseInitiationPayload(payload)).toThrow(
      /unknown_field/u,
    );
  });

  it.each([
    ['empty organization name', { organization: { name: '   ' } }],
    ['empty CEO phone', { ceo: { phone: '' } }],
    ['invalid CEO username', { ceo: { username: 'CEO with spaces' } }],
    ['non-array modules', { modules: 'enterprise_tree' }],
    ['empty modules', { modules: [] }],
    ['non-string module', { modules: ['enterprise_tree', 42] }],
  ])('rejects invalid or empty values: %s', (_label, patch) => {
    const payload = validPayload();
    if ('organization' in patch) {
      payload.organization = {
        ...(payload.organization as Record<string, unknown>),
        ...patch.organization,
      };
    } else if ('ceo' in patch) {
      payload.ceo = {
        ...(payload.ceo as Record<string, unknown>),
        ...patch.ceo,
      };
    } else {
      Object.assign(payload, patch);
    }
    expect(() => parseEnterpriseInitiationPayload(payload)).toThrow();
  });

  it.each(['12345678901', '12800138000', '+861380013800', '+1-202-555-0100'])(
    'rejects malformed CEO phone %s',
    (phone) => {
      const payload = validPayload();
      payload.ceo = {
        ...(payload.ceo as Record<string, unknown>),
        phone,
      };
      expect(() => parseEnterpriseInitiationPayload(payload)).toThrow(
        'ceo_phone_invalid',
      );
    },
  );

  it.each([
    ['organization name', { organization: { name: '企'.repeat(81) } }],
    ['CEO name', { ceo: { name: '人'.repeat(81) } }],
    ['department', { defaultDepartmentName: '部'.repeat(81) }],
    ['module', { modules: ['x'.repeat(81)] }],
  ])('rejects overlong %s', (_label, patch) => {
    const payload = validPayload();
    if ('organization' in patch) {
      payload.organization = {
        ...(payload.organization as Record<string, unknown>),
        ...patch.organization,
      };
    } else if ('ceo' in patch) {
      payload.ceo = {
        ...(payload.ceo as Record<string, unknown>),
        ...patch.ceo,
      };
    } else {
      Object.assign(payload, patch);
    }
    expect(() => parseEnterpriseInitiationPayload(payload)).toThrow();
  });
});
