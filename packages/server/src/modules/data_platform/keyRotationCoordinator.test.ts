/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createAutomaticKeyRotationTask,
  createKeyRotationCoordinator,
} from './keyRotationCoordinator.js';

function createHarness() {
  const events: unknown[] = [];
  const target = {
    getStatus: vi.fn(() => ({ dekVersion: 4, kekVersion: 'kek-v1' })),
    prepareDekRotation: vi.fn(async () => ({ nextDekVersion: 5 })),
    cancelPreparedDek: vi.fn(async () => undefined),
    rotatePreparedDek: vi.fn(async () => ({
      dekVersion: 5,
      recoveryReference: 'snapshot-5',
    })),
    verify: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    prepareKekRotation: vi.fn(async () => ({
      rotationId: 'kek-rotation-01',
      previousKekVersions: ['kek-v1'],
      activeKekVersion: 'kek-v2',
      dekVersions: [4],
    })),
    activateKekRotation: vi.fn(async () => undefined),
    abortKekRotation: vi.fn(async () => undefined),
  };
  const backups = {
    prepare: vi.fn(async () => undefined),
    activate: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    retire: vi.fn(async () => undefined),
  };
  const lease = {
    acquire: vi.fn(async () => true),
    release: vi.fn(async () => true),
  };
  return {
    events,
    target,
    backups,
    lease,
    coordinator: createKeyRotationCoordinator({
      target,
      backups,
      lease,
      audit: { append: async (event) => void events.push(event) },
      leaseTtlMs: 120_000,
    }),
  };
}

describe('key rotation coordinator', () => {
  it('runs KEK rewrap under a distributed lease and synchronizes backups', async () => {
    const harness = createHarness();

    await expect(
      harness.coordinator.rotateKek({ actorId: 'operator-a' }),
    ).resolves.toMatchObject({ activeKekVersion: 'kek-v2' });
    expect(harness.lease.acquire).toHaveBeenCalledOnce();
    expect(harness.backups.prepare).toHaveBeenCalledWith(
      'kek',
      expect.objectContaining({ fromVersion: 'kek-v1' }),
    );
    expect(harness.backups.activate).toHaveBeenCalledWith(
      'kek',
      expect.objectContaining({ toVersion: 'kek-v2' }),
    );
    expect(harness.target.activateKekRotation).toHaveBeenCalledWith(
      'kek-rotation-01',
    );
    expect(harness.lease.release).toHaveBeenCalledOnce();
    expect(JSON.stringify(harness.events)).not.toMatch(
      /ciphertext|plaintext|keyBase64/i,
    );
  });

  it('runs due automatic rotations while the coordinator enforces the distributed lock', async () => {
    const values = new Map<string, string>();
    const coordinator = {
      rotateKek: vi.fn(async () => ({
        previousKekVersions: ['1'],
        activeKekVersion: '2',
        dekVersions: [1],
      })),
      rotateDek: vi.fn(async () => ({
        dekVersion: 2,
        recoveryReference: 'snapshot-2',
      })),
      recover: vi.fn(),
    };
    const task = createAutomaticKeyRotationTask({
      coordinator,
      state: {
        get: async (key) => values.get(key) ?? null,
        set: async (key, value) => void values.set(key, value),
      },
      actorId: 'system:key-rotation',
      kekIntervalMs: 86_400_000,
      dekIntervalMs: 604_800_000,
      isDekMaintenanceWindow: () => true,
      now: () => new Date('2026-08-01T00:00:00.000Z'),
    });

    await task.runOnce();
    await task.runOnce();

    expect(coordinator.rotateKek).toHaveBeenCalledOnce();
    expect(coordinator.rotateDek).toHaveBeenCalledOnce();
    expect(values.get('key-rotation:last-kek-success')).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('cancels a prepared DEK when backup preparation fails', async () => {
    const harness = createHarness();
    harness.backups.prepare.mockRejectedValueOnce(
      new Error('backup preparation failed'),
    );

    await expect(
      harness.coordinator.rotateDek({
        actorId: 'operator-a',
        maintenanceWindowConfirmed: true,
      }),
    ).rejects.toThrow('backup preparation failed');
    expect(harness.target.cancelPreparedDek).toHaveBeenCalledWith(5);
  });

  it('requires a maintenance confirmation for DEK rekey and rolls back on failure', async () => {
    const harness = createHarness();
    await expect(
      harness.coordinator.rotateDek({
        actorId: 'operator-a',
        maintenanceWindowConfirmed: false,
      }),
    ).rejects.toThrow(/maintenance window/i);

    harness.backups.activate.mockRejectedValueOnce(
      new Error('backup activation failed'),
    );
    await expect(
      harness.coordinator.rotateDek({
        actorId: 'operator-a',
        maintenanceWindowConfirmed: true,
      }),
    ).rejects.toThrow('backup activation failed');
    expect(harness.target.rollback).toHaveBeenCalledWith('snapshot-5');
    expect(harness.backups.rollback).toHaveBeenCalled();
    expect(harness.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'rollback', result: 'succeeded' }),
      ]),
    );
  });

  it('requires two distinct approvers and rejects recovery of client E2EE keys', async () => {
    const harness = createHarness();
    const recover = vi.fn(async () => 'recovered');

    await expect(
      harness.coordinator.recover({
        actorId: 'operator-a',
        approverIds: ['operator-a'],
        requestId: 'recovery-01',
        trustDomain: 'server-database',
        recover,
      }),
    ).rejects.toThrow(/two distinct approvers/i);
    await expect(
      harness.coordinator.recover({
        actorId: 'operator-a',
        approverIds: ['operator-a', 'operator-b'],
        requestId: 'recovery-02',
        trustDomain: 'client-e2ee',
        recover,
      }),
    ).rejects.toThrow(/client E2EE/i);
    await expect(
      harness.coordinator.recover({
        actorId: 'operator-a',
        approverIds: ['operator-a', 'operator-b'],
        requestId: 'recovery-03',
        trustDomain: 'server-database',
        recover,
      }),
    ).resolves.toBe('recovered');
    expect(recover).toHaveBeenCalledOnce();
  });
});
