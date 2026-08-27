/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const createRendererConfig = require('../webpack.config.cjs');
const originalValue = process.env.OTTO_INTERNAL_TEST_ACCESS;
const originalAdminValue = process.env.OTTO_INTERNAL_TEST_ADMIN;

function internalAccessDefinition() {
  const config = createRendererConfig({}, { mode: 'production' });
  const plugin = config.plugins.find(
    (candidate) => candidate?.constructor?.name === 'DefinePlugin',
  );
  return plugin?.definitions?.__OTTO_INTERNAL_TEST_ACCESS__;
}

function internalAdminDefinition() {
  const config = createRendererConfig({}, { mode: 'production' });
  const plugin = config.plugins.find(
    (candidate) => candidate?.constructor?.name === 'DefinePlugin',
  );
  return plugin?.definitions?.__OTTO_INTERNAL_TEST_ADMIN__;
}

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env.OTTO_INTERNAL_TEST_ACCESS;
  } else {
    process.env.OTTO_INTERNAL_TEST_ACCESS = originalValue;
  }
  if (originalAdminValue === undefined) {
    delete process.env.OTTO_INTERNAL_TEST_ADMIN;
  } else {
    process.env.OTTO_INTERNAL_TEST_ADMIN = originalAdminValue;
  }
});

describe('renderer internal-test build switch', () => {
  it('pins every renderer dependency to the desktop React 18 singleton', () => {
    const config = createRendererConfig({}, { mode: 'production' });
    expect(config.resolve.alias['react$']).toContain('/packages/desktop/node_modules/react/');
    expect(config.resolve.alias['react-dom$']).toContain('/packages/desktop/node_modules/react-dom/');
    expect(config.resolve.alias['react/jsx-runtime$']).toContain('/packages/desktop/node_modules/react/');
  });

  it('is compiled off unless the build explicitly opts in', () => {
    delete process.env.OTTO_INTERNAL_TEST_ACCESS;
    expect(internalAccessDefinition()).toBe(JSON.stringify(false));
  });

  it('is compiled on only for the explicit internal preview build', () => {
    process.env.OTTO_INTERNAL_TEST_ACCESS = '1';
    expect(internalAccessDefinition()).toBe(JSON.stringify(true));
  });

  it('keeps the synthetic administrator preview off by default', () => {
    delete process.env.OTTO_INTERNAL_TEST_ADMIN;
    expect(internalAdminDefinition()).toBe(JSON.stringify(false));
  });

  it('enables the synthetic administrator preview only when explicitly requested', () => {
    process.env.OTTO_INTERNAL_TEST_ADMIN = '1';
    expect(internalAdminDefinition()).toBe(JSON.stringify(true));
  });
});
