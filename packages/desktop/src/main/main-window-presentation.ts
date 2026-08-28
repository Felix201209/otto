/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

export interface MainWindowPresentationTarget {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/** Coordinates showing the main window across Electron lifecycle events. */
export class MainWindowPresentationController {
  private ready = false;
  private showRequested = true;
  private focusRequested = false;

  constructor(private readonly target: MainWindowPresentationTarget) {}

  markReady(): void {
    this.ready = true;
    this.flush();
  }

  requestShow(options?: { focus?: boolean }): void {
    this.showRequested = true;
    this.focusRequested ||= options?.focus === true;
    this.flush();
  }

  private flush(): void {
    if (!this.ready || !this.showRequested || this.target.isDestroyed()) return;

    if (this.target.isMinimized()) this.target.restore();
    this.target.show();
    if (this.focusRequested) this.target.focus();

    this.showRequested = false;
    this.focusRequested = false;
  }
}
