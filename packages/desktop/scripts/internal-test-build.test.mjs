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

function internalAccessDefinition() {
  const config = createRendererConfig({}, { mode: 'production' });
  const plugin = config.plugins.find(
    (candidate) => candidate?.constructor?.name === 'DefinePlugin',
  );
  return plugin?.definitions?.__OTTO_INTERNAL_TEST_ACCESS__;
}

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env.OTTO_INTERNAL_TEST_ACCESS;
  } else {
    process.env.OTTO_INTERNAL_TEST_ACCESS = originalValue;
  }
});

describe('renderer internal-test build switch', () => {
  it('is compiled off unless the build explicitly opts in', () => {
    delete process.env.OTTO_INTERNAL_TEST_ACCESS;
    expect(internalAccessDefinition()).toBe(JSON.stringify(false));
  });

  it('is compiled on only for the explicit internal preview build', () => {
    process.env.OTTO_INTERNAL_TEST_ACCESS = '1';
    expect(internalAccessDefinition()).toBe(JSON.stringify(true));
  });
});
