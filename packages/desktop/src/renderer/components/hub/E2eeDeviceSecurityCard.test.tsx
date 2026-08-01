/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnterpriseE2eeTrustOverview } from '../../../preload/index.js';
import { E2eeDeviceSecurityCard } from './E2eeDeviceSecurityCard.js';

vi.mock('../../lib/qrMatrix.js', () => ({
  createQrMatrix: () => Array.from({ length: 21 }, (_, y) =>
    Array.from({ length: 21 }, (_, x) => (x + y) % 2 === 0)),
}));

const overview: EnterpriseE2eeTrustOverview = {
  capability: {
    protocolId: 'otto-mls-v1',
    releaseState: 'foundation-only',
    enabled: false,
    externalAuditCompleted: false,
    mlsEngineReady: false,
    reason: 'OpenMLS integration is incomplete',
  },
  secureStorage: { available: true, backend: 'Windows DPAPI' },
  localDevice: {
    deviceId: 'device-current',
    deviceName: 'Finance laptop',
    publicKeyFingerprint: 'a'.repeat(64),
    registrationState: 'approved',
  },
  directoryState: 'ready',
  canManageDevices: true,
  devices: [
    {
      deviceId: 'device-current',
      deviceName: 'Finance laptop',
      state: 'approved',
      isCurrentDevice: true,
      issuedAt: '2026-08-01T08:00:00.000Z',
      expiresAt: '2027-08-01T08:00:00.000Z',
      credentialFingerprint: 'b'.repeat(64),
      transparencySequence: 2,
    },
    {
      deviceId: 'device-pending',
      deviceName: 'Home desktop',
      state: 'pending',
      isCurrentDevice: false,
      issuedAt: '2026-08-01T09:00:00.000Z',
      expiresAt: '2027-08-01T09:00:00.000Z',
      credentialFingerprint: 'c'.repeat(64),
      transparencySequence: 4,
    },
  ],
  transparency: {
    size: 4,
    rootHash: 'd'.repeat(64),
    pinnedAt: '2026-08-01T09:00:00.000Z',
  },
};

const getOverview = vi.fn(async () => structuredClone(overview));
const getVerification = vi.fn(async () => ({
  deviceId: 'device-pending',
  deviceName: 'Home desktop',
  safetyNumber: Array.from({ length: 12 }, () => '12345').join(' '),
  qrPayload: 'otto-e2ee-verify:v2:test',
  fingerprints: ['b'.repeat(64), 'c'.repeat(64)] as [string, string],
}));
const approve = vi.fn(async () => ({
  ...structuredClone(overview),
  devices: overview.devices.map((device) =>
    device.deviceId === 'device-pending' ? { ...device, state: 'approved' as const } : device),
}));

beforeEach(() => {
  Object.defineProperty(window, 'otto', {
    configurable: true,
    value: {
      enterpriseE2eeTrustOverview: getOverview,
      enterpriseE2eeDeviceVerification: getVerification,
      enterpriseE2eeDeviceApprove: approve,
      enterpriseE2eeDeviceRevoke: vi.fn(),
    } as unknown as Window['otto'],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('E2eeDeviceSecurityCard', () => {
  it('states that encrypted chat is disabled and requires verification before approval', async () => {
    render(<E2eeDeviceSecurityCard />);

    expect(await screen.findByText('设备信任基础已准备')).toBeTruthy();
    expect(screen.getByText('当前仍未启用消息加密，也不会把明文聊天伪装为 E2EE。')).toBeTruthy();
    expect(screen.getByText('Home desktop')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '核验无误并批准' })).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: '核验' })[1]!);
    expect(await screen.findByRole('dialog', { name: '核验 E2EE 设备' })).toBeTruthy();
    expect(screen.getByText(Array.from({ length: 12 }, () => '12345').join(' '))).toBeTruthy();
    expect(screen.getByRole('img', { name: '设备安全号码二维码' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '核验无误并批准' }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith('device-pending'));
    expect(await screen.findByText(/新设备已批准/u)).toBeTruthy();
  });

  it('fails closed when the OS secure store is unavailable', async () => {
    getOverview.mockResolvedValueOnce({
      ...structuredClone(overview),
      secureStorage: { available: false, backend: 'Linux basic_text' },
      localDevice: null,
      directoryState: 'not_initialized',
      canManageDevices: false,
      devices: [],
      transparency: null,
    });

    render(<E2eeDeviceSecurityCard />);

    expect(await screen.findByText(/系统安全存储不可用/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '核验' })).toBeNull();
  });
});
