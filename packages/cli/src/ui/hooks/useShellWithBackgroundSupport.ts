/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { useCallback,useRef,useState } from 'react';

export interface UseShellWithBackgroundSupportReturn {
  isBackgroundMode: boolean;
  setBackgroundMode: (mode: boolean) => void;
  handleCtrlB: () => void;
  shouldExecuteBackground: () => boolean;
  resetBackgroundMode: () => void;
}

/**
 * Hook to add Ctrl+B support to shell command execution
 * When Ctrl+B is pressed during shell execution, the command is moved to background
 */
export function useShellWithBackgroundSupport(): UseShellWithBackgroundSupportReturn {
  const [isBackgroundMode, setBackgroundMode] = useState(false);
  const backggroundRequestRef = useRef(false);

  const handleCtrlB = useCallback(() => {
    backggroundRequestRef.current = true;
    setBackgroundMode(true);
  }, []);

  const shouldExecuteBackground = useCallback((): boolean => backggroundRequestRef.current, []);

  const resetBackgroundMode = useCallback(() => {
    backggroundRequestRef.current = false;
    setBackgroundMode(false);
  }, []);

  return {
    isBackgroundMode,
    setBackgroundMode,
    handleCtrlB,
    shouldExecuteBackground,
    resetBackgroundMode,
  };
}

/**
 * 在 shell 命令处理器中集成此 Hook
 * 示例用法：
 *
 * const { shouldExecuteBackground, resetBackgroundMode } = useShellWithBackgroundSupport();
 *
 * // 在处理 shell 命令时：
 * if (shouldExecuteBackground()) {
 *   const result = shellTool.executeBackground(params, signal);
 *   resetBackgroundMode();
 *   return result;
 * }
 */
