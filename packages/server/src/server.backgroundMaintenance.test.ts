/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OttoServer } from './server.js';
import { ProductWorkspaceStore } from './productWorkspaceStore.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('OttoServer background maintenance load', () => {
  it('creates no idle timer while paid background work is disabled', () => {
    vi.useFakeTimers();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-maintenance-'));
    roots.push(root);
    const server = new OttoServer({
      port: 0,
      mock: true,
      productWorkspaceStore: new ProductWorkspaceStore({ rootDir: root }),
    });
    const maintenance = server as unknown as {
      setBackgroundMaintenanceEnabled: (enabled: boolean) => void;
    };
    maintenance.setBackgroundMaintenanceEnabled(false);
    expect(vi.getTimerCount()).toBe(0);

    maintenance.setBackgroundMaintenanceEnabled(true);
    expect(vi.getTimerCount()).toBe(1);
    maintenance.setBackgroundMaintenanceEnabled(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
