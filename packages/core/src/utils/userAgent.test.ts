/**
 * @license
 * Copyright 2025 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getUserAgent } from './userAgent.js';

describe('getUserAgent', () => {
  const savedCliVersion = process.env.CLI_VERSION;

  afterEach(() => {
    if (savedCliVersion === undefined) delete process.env.CLI_VERSION;
    else process.env.CLI_VERSION = savedCliVersion;
  });

  it('formats a CLI user-agent as Otto/CLI/<version> (platform; arch)', () => {
    process.env.CLI_VERSION = '1.0.399';
    const ua = getUserAgent();
    expect(ua).toBe(`Otto/CLI/1.0.399 (${process.platform}; ${process.arch})`);
  });

  it('detects the VSCode client from the "VSCode-" prefix and strips it', () => {
    process.env.CLI_VERSION = 'VSCode-1.1.0';
    const ua = getUserAgent();
    expect(ua).toBe(`Otto/VSCode/1.1.0 (${process.platform}; ${process.arch})`);
  });

  it('falls back to "unknown" version when CLI_VERSION is not set', () => {
    delete process.env.CLI_VERSION;
    const ua = getUserAgent();
    expect(ua).toBe(`Otto/CLI/unknown (${process.platform}; ${process.arch})`);
  });

  it('accepts an explicit version argument overriding the environment', () => {
    process.env.CLI_VERSION = '1.0.399';
    const ua = getUserAgent('VSCode-2.0.0');
    expect(ua).toBe(`Otto/VSCode/2.0.0 (${process.platform}; ${process.arch})`);
  });

  it('always starts with the Otto brand token', () => {
    process.env.CLI_VERSION = '1.2.3';
    expect(getUserAgent().startsWith('Otto/')).toBe(true);
  });
});
