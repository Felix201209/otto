/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivacyDataPanel } from './PrivacyDataPanel.js';

const getProfile = vi.fn(async () => ({
  controller: {
    name: 'Example Data Controller',
    privacyContact: 'privacy@example.test',
    configured: true,
  },
  residency: {
    mode: 'customer_server',
    region: 'CN',
    crossBorderEnabled: false,
    localizationReady: true,
  },
  security: {
    publicTransport: 'HTTPS/TLS required',
    database: 'SQLite on the selected enterprise server',
    encryptedData: [],
    hashedData: [],
    plaintextData: [],
  },
  retention: {
    securityAuditMinimumDays: 180,
    encryptedBackupDefaultDays: 30,
    healthTelemetryDefaultDays: 90,
  },
  readiness: { configured: true, warnings: [] },
  documents: [{
    id: 'privacy',
    title: 'Privacy Policy',
    version: '2026-07-29',
    effectiveAt: '2026-07-29',
    required: true,
    summary: [],
    sourceUrls: [],
    hash: 'a'.repeat(64),
    accepted: true,
    acceptedAt: Date.parse('2026-07-29T00:00:00.000Z'),
  }],
  processingActivities: [],
  rights: [],
  currentConsentComplete: true,
  authorization: {
    deploymentId: 'dep_test',
    license: {
      status: 'active',
      plan: 'enterprise',
      expiresAt: '2027-07-29T00:00:00.000Z',
      seatLimit: 100,
      activeSeatCount: 3,
      modules: ['enterprise_tree'],
      offline: false,
      enforce: true,
    },
    telemetry: { enabled: false, contentMode: 'operational_only' },
    dataBoundary: {},
  },
}));

beforeEach(() => {
  Object.defineProperty(window, 'otto', {
    configurable: true,
    value: {
      enterpriseDataGovernanceGet: getProfile,
      enterpriseLegalAccept: vi.fn(),
      enterprisePrivacyExport: vi.fn(),
      enterprisePrivacyDelete: vi.fn(),
      enterpriseSession: vi.fn(async () => ({ serverUrl: 'https://enterprise.example.test' })),
      openExternal: vi.fn(),
    } as unknown as Window['otto'],
  });
});

afterEach(() => {
  cleanup();
  getProfile.mockClear();
});

describe('PrivacyDataPanel', () => {
  it('shows authoritative license, residency, controller and consent state', async () => {
    render(<PrivacyDataPanel />);

    expect(await screen.findByText('enterprise')).toBeTruthy();
    expect(screen.getByText('Example Data Controller · privacy@example.test')).toBeTruthy();
    expect(screen.getByText('Privacy Policy')).toBeTruthy();
    expect(screen.getByText('中国境内 / 当前企业服务器')).toBeTruthy();
    expect(getProfile).toHaveBeenCalledTimes(1);
  });
});
