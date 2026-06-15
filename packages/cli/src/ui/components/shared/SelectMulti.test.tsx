/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import { SelectMulti, SelectMultiItem } from './SelectMulti.js';

// Mock the keypress hook. The component subscribes via `useKeypress`; under
// `ink-testing-library` there's no real stdin, so we just verify render shape.
vi.mock('../../hooks/useKeypress.js', () => ({
  useKeypress: () => {
    /* noop */
  },
}));

describe('SelectMulti', () => {
  const items: Array<SelectMultiItem<string>> = [
    { label: 'OAuth', value: 'oauth', description: 'standard flow' },
    { label: 'API Key', value: 'apikey', description: 'static token' },
    { label: 'Basic Auth', value: 'basic' },
  ];

  it('renders all items with checkboxes', () => {
    const { lastFrame } = render(
      <SelectMulti items={items} onSubmit={vi.fn()} isFocused={true} />,
    );
    const output = lastFrame() || '';

    // Every label appears.
    expect(output).toContain('OAuth');
    expect(output).toContain('API Key');
    expect(output).toContain('Basic Auth');

    // Each item has an unchecked box to start.
    const unchecked = (output.match(/\[ \]/g) ?? []).length;
    expect(unchecked).toBe(items.length);
  });

  it('reflects pre-selected defaultValues with checked boxes', () => {
    const { lastFrame } = render(
      <SelectMulti
        items={items}
        defaultValues={['oauth', 'basic']}
        onSubmit={vi.fn()}
        isFocused={true}
      />,
    );
    const output = lastFrame() || '';
    const checked = (output.match(/\[x\]/g) ?? []).length;
    expect(checked).toBe(2);
  });

  it('renders descriptions inline when provided', () => {
    const { lastFrame } = render(
      <SelectMulti items={items} onSubmit={vi.fn()} isFocused={true} />,
    );
    const output = lastFrame() || '';
    expect(output).toContain('standard flow');
    expect(output).toContain('static token');
  });

  it('shows numeric prefixes when showNumbers=true (default)', () => {
    const { lastFrame } = render(
      <SelectMulti items={items} onSubmit={vi.fn()} isFocused={true} />,
    );
    const output = lastFrame() || '';
    expect(output).toContain('1.');
    expect(output).toContain('2.');
    expect(output).toContain('3.');
  });

  it('hides numeric prefixes when showNumbers=false', () => {
    const { lastFrame } = render(
      <SelectMulti
        items={items}
        onSubmit={vi.fn()}
        isFocused={true}
        showNumbers={false}
      />,
    );
    const output = lastFrame() || '';
    // No "1." / "2." / "3." prefixes. (string "1" might appear in descriptions
    // — check the dot form that only the prefix uses.)
    expect(output).not.toMatch(/\b1\.\s/);
    expect(output).not.toMatch(/\b2\.\s/);
  });
});
