/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
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
  documents: [
    {
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
    },
  ],
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

const listE2eeDevices = vi.fn(async () => [
  {
    accountId: 'account-1',
    deviceId: 'device-current-12345678',
    deviceName: '办公电脑',
    identitySigningPublicKey: 'signing-public-key',
    deviceExchangePublicKey: 'exchange-public-key',
    keyFingerprint: 'a'.repeat(64),
    approvalState: 'approved' as const,
    approvedByDeviceId: null,
    approvedAt: '2026-07-30T09:00:00.000Z',
    isCurrentDevice: true,
    createdAt: '2026-07-30T09:00:00.000Z',
    lastSeenAt: '2026-07-31T09:00:00.000Z',
    revokedAt: null,
  },
  {
    accountId: 'account-1',
    deviceId: 'device-old-12345678',
    deviceName: '旧电脑',
    identitySigningPublicKey: 'old-signing-public-key',
    deviceExchangePublicKey: 'old-exchange-public-key',
    keyFingerprint: 'b'.repeat(64),
    approvalState: 'approved' as const,
    approvedByDeviceId: 'device-current-12345678',
    approvedAt: '2026-07-20T09:00:00.000Z',
    createdAt: '2026-07-20T09:00:00.000Z',
    lastSeenAt: '2026-07-21T09:00:00.000Z',
    revokedAt: '2026-07-22T09:00:00.000Z',
  },
  {
    accountId: 'account-1',
    deviceId: 'device-pending-12345678',
    deviceName: '待批准手机',
    identitySigningPublicKey: 'pending-signing-public-key',
    deviceExchangePublicKey: 'pending-exchange-public-key',
    keyFingerprint: 'c'.repeat(64),
    approvalState: 'pending' as const,
    approvedByDeviceId: null,
    approvedAt: null,
    isCurrentDevice: false,
    createdAt: '2026-07-31T08:00:00.000Z',
    lastSeenAt: '2026-07-31T09:00:00.000Z',
    revokedAt: null,
  },
]);
const approveE2eeDevice = vi.fn(async () => undefined);
const verifyE2eeDevice = vi.fn(async () => ({
  safetyNumber: Array.from({ length: 12 }, () => '12345').join(' '),
  qrPayload: `otto-e2ee-verify:v1:${Buffer.from('{}').toString('base64url')}`,
  deviceFingerprints: ['a'.repeat(64), 'c'.repeat(64)] as [string, string],
}));
const revokeE2eeDevice = vi.fn(async () => undefined);
const getE2eeKeyTransparency = vi.fn(async () => ({
  accountId: 'account-1',
  headSequence: 3,
  headHash: 'd'.repeat(64),
  entries: [
    {
      sequence: 1,
      accountId: 'account-1',
      deviceId: 'device-current-12345678',
      event: 'bootstrap_approved' as const,
      keyFingerprint: 'a'.repeat(64),
      actorDeviceId: null,
      previousHash: '0'.repeat(64),
      entryHash: 'b'.repeat(64),
      createdAt: '2026-07-30T09:00:00.000Z',
    },
    {
      sequence: 2,
      accountId: 'account-1',
      deviceId: 'device-pending-12345678',
      event: 'registered_pending' as const,
      keyFingerprint: 'c'.repeat(64),
      actorDeviceId: null,
      previousHash: 'b'.repeat(64),
      entryHash: 'c'.repeat(64),
      createdAt: '2026-07-31T08:00:00.000Z',
    },
    {
      sequence: 3,
      accountId: 'account-1',
      deviceId: 'device-pending-12345678',
      event: 'approved' as const,
      keyFingerprint: 'c'.repeat(64),
      actorDeviceId: 'device-current-12345678',
      previousHash: 'c'.repeat(64),
      entryHash: 'd'.repeat(64),
      createdAt: '2026-07-31T09:00:00.000Z',
    },
  ],
}));
const exportE2eeRecovery = vi.fn(async () => '{"v":1,"ciphertext":"sealed"}');
const importE2eeRecovery = vi.fn(async () => undefined);
const saveTextFile = vi.fn(async () => 'D:\\Backups\\otto-e2ee-recovery.json');

beforeEach(() => {
  Object.defineProperty(window, 'otto', {
    configurable: true,
    value: {
      enterpriseDataGovernanceGet: getProfile,
      enterpriseLegalAccept: vi.fn(),
      enterprisePrivacyExport: vi.fn(),
      enterprisePrivacyDelete: vi.fn(),
      enterpriseE2eeDevicesList: listE2eeDevices,
      enterpriseE2eeDeviceApprove: approveE2eeDevice,
      enterpriseE2eeDeviceVerification: verifyE2eeDevice,
      enterpriseE2eeDeviceRevoke: revokeE2eeDevice,
      enterpriseE2eeKeyTransparency: getE2eeKeyTransparency,
      enterpriseE2eeRecoveryExport: exportE2eeRecovery,
      enterpriseE2eeRecoveryImport: importE2eeRecovery,
      saveTextFile,
      enterpriseSession: vi.fn(async () => ({
        serverUrl: 'https://enterprise.example.test',
      })),
      openExternal: vi.fn(),
    } as unknown as Window['otto'],
  });
});

afterEach(() => {
  cleanup();
  getProfile.mockClear();
  listE2eeDevices.mockClear();
  approveE2eeDevice.mockClear();
  verifyE2eeDevice.mockClear();
  revokeE2eeDevice.mockClear();
  getE2eeKeyTransparency.mockClear();
  exportE2eeRecovery.mockClear();
  importE2eeRecovery.mockClear();
  saveTextFile.mockClear();
});

describe('PrivacyDataPanel', () => {
  it('shows authoritative license, residency, controller and consent state', async () => {
    render(<PrivacyDataPanel />);

    expect(await screen.findByText('enterprise')).toBeTruthy();
    expect(
      screen.getByText('Example Data Controller · privacy@example.test'),
    ).toBeTruthy();
    expect(screen.getByText('Privacy Policy')).toBeTruthy();
    expect(screen.getByText('中国境内 / 当前企业服务器')).toBeTruthy();
    expect(getProfile).toHaveBeenCalledTimes(1);
  });

  it('lists encrypted-chat devices and requires an explicit second click before revocation', async () => {
    render(<PrivacyDataPanel />);

    expect(await screen.findByText('办公电脑')).toBeTruthy();
    expect(screen.getByText('旧电脑')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '撤销设备 办公电脑' }));
    expect(revokeE2eeDevice).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认撤销 办公电脑' }));
    await waitFor(() =>
      expect(revokeE2eeDevice).toHaveBeenCalledWith('device-current-12345678'),
    );
    expect(listE2eeDevices).toHaveBeenCalledTimes(2);
  });

  it('shows a locally generated safety number before approving a pending device', async () => {
    render(<PrivacyDataPanel />);

    expect(await screen.findByText('待批准手机')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '核验并批准' }));
    expect(
      await screen.findByText(
        Array.from({ length: 12 }, () => '12345').join(' '),
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('img', { name: '设备安全号码二维码' }),
    ).toBeTruthy();
    expect(approveE2eeDevice).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '号码一致，批准设备' }));
    await waitFor(() =>
      expect(approveE2eeDevice).toHaveBeenCalledWith('device-pending-12345678'),
    );
  });

  it('shows the auditable key-transparency history and current chain head', async () => {
    render(<PrivacyDataPanel />);

    expect(await screen.findByText('密钥透明日志')).toBeTruthy();
    expect(screen.getByText('链头序号 3')).toBeTruthy();
    expect(screen.getByText('首台设备建立')).toBeTruthy();
    expect(screen.getByText('新设备待批准')).toBeTruthy();
    expect(screen.getByText('设备已批准')).toBeTruthy();
    expect(getE2eeKeyTransparency).toHaveBeenCalledTimes(1);
  });

  it('exports a passphrase-protected recovery bundle through the native save dialog', async () => {
    render(<PrivacyDataPanel />);
    await screen.findByText('办公电脑');

    fireEvent.change(screen.getByLabelText('恢复包口令'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.change(screen.getByLabelText('确认恢复包口令'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: '导出恢复包' }));

    await waitFor(() =>
      expect(exportE2eeRecovery).toHaveBeenCalledWith('correct horse battery'),
    );
    expect(saveTextFile).toHaveBeenCalledWith(
      expect.stringMatching(/^otto-e2ee-recovery-\d{4}-\d{2}-\d{2}\.json$/u),
      '{"v":1,"ciphertext":"sealed"}',
    );
    expect(await screen.findByText(/恢复包已保存到/u)).toBeTruthy();
  });
});
