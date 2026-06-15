/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SimpleTextInput - A simple single-line text input component
 *
 * This component replicates the core input handling logic from InputPrompt,
 * ensuring compatibility with:
 * - Node.js 24 on Windows (bracketed paste sequences)
 * - Cross-platform newline key combinations
 * - Unicode/multi-byte characters (emoji, CJK, etc.)
 * - Various terminal emulators and their quirks
 *
 * Key features borrowed from InputPrompt:
 * - Uses KeypressProvider via useKeypress hook
 * - Handles paste events with sanitization
 * - Cross-platform modifier key handling
 * - Unicode-aware cursor positioning
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { useKeypress, Key } from '../../hooks/useKeypress.js';
import { Colors } from '../../colors.js';
import { sanitizePasteContent } from '../../utils/displayUtils.js';
import { cpSlice, cpLen } from '../../utils/textUtils.js';

export interface SimpleTextInputProps {
  /** Current input value */
  value: string;
  /** Callback when value changes */
  onChange: (value: string) => void;
  /** Callback when Enter is pressed */
  onSubmit: (value: string) => void;
  /** Callback when Escape is pressed */
  onCancel?: () => void;
  /** Placeholder text */
  placeholder?: string;
  /** Whether the input is focused and should receive keypresses */
  isActive?: boolean;
  /** Mask character for password input (e.g., '*') */
  mask?: string;
  /** Prompt prefix (default: '> ') */
  prompt?: string;
  /** Prompt color */
  promptColor?: string;
}

export function SimpleTextInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder = '',
  isActive = true,
  mask,
  prompt = '> ',
  promptColor = Colors.AccentCyan,
}: SimpleTextInputProps): React.JSX.Element {
  // Use Unicode code point length for cursor position
  const [cursorPosition, setCursorPosition] = useState(cpLen(value));

  // Keep cursor position in sync with value length (Unicode-aware)
  useEffect(() => {
    const len = cpLen(value);
    if (cursorPosition > len) {
      setCursorPosition(len);
    }
  }, [value, cursorPosition]);

  // 🎯 IME / 批量按键修复：
  // KeypressContext 的 rapidPaste 检测会把短时间内多次中文 IME 上屏字
  // 逐个 broadcast（当字数 < 5 时）。若 handleKeypress 闭包读 state 的 `value`
  // 会是同一 tick 内的旧值 —— 后续字符用旧 value 拼接后覆盖前面的 onChange，
  // 导致「只上屏最后一个字」。
  // 方案：用 ref 保持 value/cursor 的即时最新值，同一 tick 多次 keypress
  // 依然能正确累加。
  const valueRef = useRef(value);
  const cursorRef = useRef(cursorPosition);
  valueRef.current = value;
  cursorRef.current = cursorPosition;

  const commitChange = useCallback(
    (nextValue: string, nextCursor: number) => {
      valueRef.current = nextValue;
      cursorRef.current = nextCursor;
      onChange(nextValue);
      setCursorPosition(nextCursor);
    },
    [onChange],
  );

  const handleKeypress = useCallback((key: Key) => {
    // Always read the freshest value/cursor from refs so that IME multi-char
    // bursts dispatched within the same tick accumulate correctly.
    const curValue = valueRef.current;
    const curCursor = cursorRef.current;
    const valueLen = cpLen(curValue);

    // ============================================
    // Paste handling (from InputPrompt)
    // ============================================

    // Handle paste event with content
    if (key.paste && key.sequence) {
      // Windows special case: Ctrl+Enter/Shift+Enter may be misidentified as paste
      if (key.sequence === '\n' || key.sequence === '\r') {
        return;
      }

      const sanitized = sanitizePasteContent(key.sequence);
      const singleLine = sanitized.replace(/[\r\n]+/g, ' ').trim();
      if (singleLine) {
        const newValue = cpSlice(curValue, 0, curCursor) + singleLine + cpSlice(curValue, curCursor);
        commitChange(newValue, curCursor + cpLen(singleLine));
      }
      return;
    }

    // Handle empty paste event (might be image paste, just ignore for simple text input)
    if (key.paste && !key.sequence) {
      return;
    }

    // Compatibility: some terminals don't set paste flag but send multi-line content
    if (key.sequence && key.sequence.includes('\n') && key.sequence.length > 50) {
      const sanitized = sanitizePasteContent(key.sequence);
      const singleLine = sanitized.replace(/[\r\n]+/g, ' ').trim();
      if (singleLine) {
        const newValue = cpSlice(curValue, 0, curCursor) + singleLine + cpSlice(curValue, curCursor);
        commitChange(newValue, curCursor + cpLen(singleLine));
      }
      return;
    }

    // Enter for submit (only when not using modifiers)
    if (key.name === 'return' && !key.shift && !key.ctrl && !key.meta && !key.paste) {
      onSubmit(curValue);
      return;
    }

    // Ignore modified Enter for single-line input
    if (key.name === 'return') {
      return;
    }

    // Escape
    if (key.name === 'escape') {
      onCancel?.();
      return;
    }

    // Editing keys (Unicode-aware)
    if (key.name === 'backspace') {
      if (curCursor > 0) {
        const newValue = cpSlice(curValue, 0, curCursor - 1) + cpSlice(curValue, curCursor);
        commitChange(newValue, curCursor - 1);
      }
      return;
    }

    if (key.name === 'delete') {
      if (curCursor < valueLen) {
        const newValue = cpSlice(curValue, 0, curCursor) + cpSlice(curValue, curCursor + 1);
        commitChange(newValue, curCursor);
      }
      return;
    }

    // Navigation keys
    if (key.name === 'left') {
      if (curCursor > 0) {
        cursorRef.current = curCursor - 1;
        setCursorPosition(curCursor - 1);
      }
      return;
    }

    if (key.name === 'right') {
      if (curCursor < valueLen) {
        cursorRef.current = curCursor + 1;
        setCursorPosition(curCursor + 1);
      }
      return;
    }

    if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
      cursorRef.current = 0;
      setCursorPosition(0);
      return;
    }

    if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
      cursorRef.current = valueLen;
      setCursorPosition(valueLen);
      return;
    }

    // Kill commands
    if (key.ctrl && key.name === 'u') {
      const newValue = cpSlice(curValue, curCursor);
      commitChange(newValue, 0);
      return;
    }

    if (key.ctrl && key.name === 'k') {
      const newValue = cpSlice(curValue, 0, curCursor);
      commitChange(newValue, curCursor);
      return;
    }

    if (key.ctrl && key.name === 'w') {
      const beforeCursor = cpSlice(curValue, 0, curCursor);
      const match = beforeCursor.match(/\S*\s*$/);
      if (match) {
        const deleteLength = cpLen(match[0]);
        const newValue = cpSlice(curValue, 0, curCursor - deleteLength) + cpSlice(curValue, curCursor);
        commitChange(newValue, curCursor - deleteLength);
      }
      return;
    }

    if (key.ctrl && key.name === 'c') {
      if (curValue.length > 0) {
        commitChange('', 0);
      }
      return;
    }

    // Ignore other control key combinations
    if (key.ctrl || key.meta) {
      return;
    }

    // ============================================
    // Regular character input (handles IME multi-char bursts correctly
    // because we read latest state from refs, not from stale closure)
    // ============================================
    if (key.sequence && !key.ctrl && !key.meta) {
      const charCode = key.sequence.codePointAt(0);
      if (charCode !== undefined && charCode >= 32) {
        const seqLen = cpLen(key.sequence);
        const newValue = cpSlice(curValue, 0, curCursor) + key.sequence + cpSlice(curValue, curCursor);
        commitChange(newValue, curCursor + seqLen);
      }
    }
  }, [commitChange, onSubmit, onCancel]);

  useKeypress(handleKeypress, { isActive });

  // ============================================
  // Render (Unicode-aware)
  // ============================================
  const valueLen = cpLen(value);
  const displayValue = mask ? mask.repeat(valueLen) : value;
  const showPlaceholder = valueLen === 0 && placeholder;

  // Build display with cursor (Unicode-aware slicing)
  const beforeCursor = cpSlice(displayValue, 0, cursorPosition);
  const atCursor = cpSlice(displayValue, cursorPosition, cursorPosition + 1) || ' ';
  const afterCursor = cpSlice(displayValue, cursorPosition + 1);

  return (
    <Box>
      <Text color={promptColor}>{prompt}</Text>
      {showPlaceholder ? (
        <Text color={Colors.Gray}>{placeholder}</Text>
      ) : (
        <>
          <Text>{beforeCursor}</Text>
          <Text inverse>{atCursor}</Text>
          <Text>{afterCursor}</Text>
        </>
      )}
    </Box>
  );
}
