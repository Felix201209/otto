/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { getBackgroundModeSignal } from 'otto-core';
import React,{ useEffect } from 'react';
import { useBackgroundModeContext } from '../contexts/BackgroundModeContext.js';

declare global {
  var __backgroundModeCallback: ((requested: boolean) => void) | undefined;
}

/**
 * Bridge component that connects KeypressContext's Ctrl+B detection to BackgroundModeContext
 * AND to the Core layer's BackgroundModeSignal for ShellTool to detect during execution
 */
export const BackgroundModeBridge: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const backgroundModeContext = useBackgroundModeContext();

  useEffect(() => {
    if (process.env.DEBUG) { console.log('[BackgroundModeBridge] Setting up onBackgroundModeRequested callback'); }

    // Create callback that will be called when Ctrl+B is detected
    const onCtrlB = (requested: boolean) => {
      if (process.env.DEBUG) { console.log('[BackgroundModeBridge] 🔥 onCtrlB called with:', requested); }

      // Update React state (for UI)
      backgroundModeContext.setBackgroundModeRequested(requested);

      // 🔥 CRITICAL: Also signal the Core layer so ShellTool can detect it during execution
      if (requested) {
        const signal = getBackgroundModeSignal();
        signal.requestBackgroundMode();
        if (process.env.DEBUG) { console.log('[BackgroundModeBridge] 📡 Sent signal to Core layer'); }
      }
    };

    // Store in global for KeypressProvider to access
    globalThis.__backgroundModeCallback = onCtrlB;

    return () => {
      delete globalThis.__backgroundModeCallback;
    };
  }, [backgroundModeContext]);

  return <>{children}</>;
};
