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

export interface DesktopWindowActivityTarget {
  isVisible(): boolean;
  isMinimized(): boolean;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

/**
 * Converts every Electron visibility transition into one foreground signal.
 * This keeps background schedulers correct on minimize, hide, restore, and
 * macOS close paths instead of depending on the Windows tray-close handler.
 */
export function observeDesktopWindowActivity(
  target: DesktopWindowActivityTarget,
  onForegroundChange: (foreground: boolean) => void,
): () => void {
  const updateForeground = (): void => {
    onForegroundChange(target.isVisible() && !target.isMinimized());
  };
  const updateBackground = (): void => {
    onForegroundChange(false);
  };
  const foregroundEvents = ['show', 'restore'] as const;
  const backgroundEvents = ['hide', 'minimize', 'close'] as const;

  for (const event of foregroundEvents) target.on(event, updateForeground);
  for (const event of backgroundEvents) target.on(event, updateBackground);
  updateForeground();

  return () => {
    for (const event of foregroundEvents) {
      target.removeListener(event, updateForeground);
    }
    for (const event of backgroundEvents) {
      target.removeListener(event, updateBackground);
    }
  };
}
