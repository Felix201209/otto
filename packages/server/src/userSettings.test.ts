/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadUserSettingsSubset,
  patchUserSettings,
  userSettingsFilePath,
} from './userSettings.js';

const tempHomes: string[] = [];

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-user-settings-'));
  tempHomes.push(home);
  return home;
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe('后台模型任务用户设置', () => {
  it('新安装和缺失字段时均安全默认关闭', () => {
    const home = tempHome();
    expect(loadUserSettingsSubset(home).backgroundModelTasksEnabled).toBe(false);
  });

  it('只在显式开启后返回 true，并保留其它未知字段', () => {
    const home = tempHome();
    const file = userSettingsFilePath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ customField: 'keep-me' }));

    patchUserSettings({ backgroundModelTasksEnabled: true }, home);

    expect(loadUserSettingsSubset(home).backgroundModelTasksEnabled).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).customField).toBe('keep-me');
  });
});
