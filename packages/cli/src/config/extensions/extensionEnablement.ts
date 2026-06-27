/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export class ExtensionEnablementManager {
  private enabledExtensionOverrides?: string[];

  constructor(enabledExtensionOverrides?: string[]) {
    this.enabledExtensionOverrides = enabledExtensionOverrides;
  }

  getEnabledExtensions(): string[] {
    // Return enabled extensions from settings or overrides
    return this.enabledExtensionOverrides || [];
  }
}
