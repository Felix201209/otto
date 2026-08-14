/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PET_WIDGET_PREFERENCE_EVENT,
  readPetWidgetEnabled,
  writePetWidgetEnabled,
} from './petWidgetPreference.js';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('pet widget preference', () => {
  it('fails closed and still publishes the change event when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const onChange = vi.fn();
    window.addEventListener(PET_WIDGET_PREFERENCE_EVENT, onChange, {
      once: true,
    });

    expect(readPetWidgetEnabled()).toBe(false);
    expect(() => writePetWidgetEnabled(true)).not.toThrow();
    expect(onChange).toHaveBeenCalledOnce();
  });
});
