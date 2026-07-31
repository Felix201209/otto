/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

export const PET_WIDGET_PREFERENCE_KEY = 'otto.pet-widget.enabled';
export const PET_WIDGET_PREFERENCE_EVENT = 'otto:pet-widget-preference-change';

export function readPetWidgetEnabled(): boolean {
  try {
    return window.localStorage.getItem(PET_WIDGET_PREFERENCE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writePetWidgetEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(PET_WIDGET_PREFERENCE_KEY, enabled ? '1' : '0');
  } catch {
    // A blocked localStorage must not prevent the settings page from rendering.
  }
  window.dispatchEvent(new Event(PET_WIDGET_PREFERENCE_EVENT));
}
