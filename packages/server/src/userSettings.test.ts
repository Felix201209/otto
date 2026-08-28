/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadUserSettingsSubset,
  patchUserSettings,
} from './userSettings.js';

const temporaryHomes: string[] = [];

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-settings-'));
  temporaryHomes.push(home);
  return home;
}

describe('background model task user setting', () => {
  it('defaults to disabled when the setting is absent', () => {
    expect(
      loadUserSettingsSubset(temporaryHome()).backgroundModelTasksEnabled,
    ).toBe(false);
  });

  it('is enabled only by an explicit persisted true value', () => {
    const home = temporaryHome();
    patchUserSettings({ backgroundModelTasksEnabled: true }, home);
    expect(loadUserSettingsSubset(home).backgroundModelTasksEnabled).toBe(true);

    patchUserSettings({ backgroundModelTasksEnabled: false }, home);
    expect(loadUserSettingsSubset(home).backgroundModelTasksEnabled).toBe(false);
  });
});
