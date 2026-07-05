/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { JSDOM } from 'jsdom';

// Keep CLI snapshots deterministic. Product runtime still auto-detects locale;
// tests use English unless a spec explicitly mocks Chinese locale.
process.env.LANG = 'en_US.UTF-8';
process.env.LC_ALL = 'en_US.UTF-8';
process.env.LC_CTYPE = 'en_US.UTF-8';

// Cleanup after each test case (removes any fragments from the DOM)
afterEach(() => {
  cleanup();
});

// Polyfill for jsdom: ensure document is available
if (typeof document === 'undefined') {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  global.document = dom.window.document;
  global.window = dom.window;
}
