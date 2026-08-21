/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export const DESKTOP_WINDOW_LIFECYCLE_CHANNEL = 'otto:window-lifecycle';
export type DesktopWindowLifecycleAction = 'suspend' | 'resume';

interface DesktopConnectionController {
  connect(): Promise<boolean>;
  disconnect(): void;
  clearPending?(): void;
}

export async function applyDesktopConnectionLifecycle(
  action: DesktopWindowLifecycleAction,
  controller: DesktopConnectionController,
): Promise<void> {
  if (action === 'suspend') {
    controller.clearPending?.();
    controller.disconnect();
    return;
  }
  await controller.connect();
}
