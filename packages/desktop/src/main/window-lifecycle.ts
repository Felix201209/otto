/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export const DESKTOP_WINDOW_LIFECYCLE_CHANNEL = 'otto:window-lifecycle';
export type DesktopWindowLifecycleAction = 'suspend' | 'resume';

interface DesktopWindowTarget {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, action: DesktopWindowLifecycleAction): void;
  };
  hide(): void;
}

function notify(
  target: DesktopWindowTarget,
  action: DesktopWindowLifecycleAction,
): boolean {
  if (target.isDestroyed() || target.webContents.isDestroyed()) return false;
  target.webContents.send(DESKTOP_WINDOW_LIFECYCLE_CHANNEL, action);
  return true;
}

export function suspendDesktopWindow(target: DesktopWindowTarget): boolean {
  if (!notify(target, 'suspend')) return false;
  target.hide();
  return true;
}

export function resumeDesktopWindow(target: DesktopWindowTarget): boolean {
  return notify(target, 'resume');
}
