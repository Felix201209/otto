/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SelectMulti - Multi-selection list with checkbox-style toggling.
 *
 * Ported from claude-code's SelectMulti component in spirit, adapted to
 * DeepCode's UI primitives (Ink + useKeypress + Colors).
 *
 * Keybindings:
 *   ↑/↓ (or k/j): move focus
 *   Space: toggle current item
 *   1-9: jump focus to that item (also toggles if pressed twice)
 *   Enter: submit the current selection
 *   Esc: cancel
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../../colors.js';
import { useKeypress, Key } from '../../hooks/useKeypress.js';

export interface SelectMultiItem<T> {
  label: string;
  value: T;
  /** Optional secondary text displayed dimmed next to the label. */
  description?: string;
  disabled?: boolean;
}

export interface SelectMultiProps<T> {
  items: Array<SelectMultiItem<T>>;
  /** Initially selected values. */
  defaultValues?: T[];
  /** Called on every selection change (space toggle). */
  onChange?: (values: T[]) => void;
  /** Called when the user presses Enter. */
  onSubmit: (values: T[]) => void;
  /** Called when the user presses Escape. */
  onCancel?: () => void;
  isFocused?: boolean;
  showNumbers?: boolean;
  /** Called when focus moves past the last item (↓ on last). */
  onDownFromLastItem?: () => void;
  /** True when an external overlay (footer/editor) has taken focus. */
  isDisabled?: boolean;
}

export function SelectMulti<T>({
  items,
  defaultValues = [],
  onChange,
  onSubmit,
  onCancel,
  isFocused = true,
  showNumbers = true,
  onDownFromLastItem,
  isDisabled = false,
}: SelectMultiProps<T>): React.JSX.Element {
  const [activeIndex, setActiveIndex] = useState(0);
  const [selected, setSelected] = useState<Set<T>>(new Set(defaultValues));
  const numberInputRef = useRef<{ buffer: string; timer: NodeJS.Timeout | null }>({
    buffer: '',
    timer: null,
  });

  // Keep `selected` in sync if defaultValues reference changes.
  const defaultsKey = defaultValues.map((v) => String(v)).join('\u0001');
  useEffect(() => {
    setSelected(new Set(defaultValues));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultsKey]);

  const emitChange = (next: Set<T>) => {
    onChange?.(Array.from(next));
  };

  const toggleAt = (idx: number) => {
    const item = items[idx];
    if (!item || item.disabled) return;
    const next = new Set(selected);
    if (next.has(item.value)) next.delete(item.value);
    else next.add(item.value);
    setSelected(next);
    emitChange(next);
  };

  const handleKey = (key: Key) => {
    if (!isFocused || isDisabled) return;

    if (key.name === 'escape') {
      onCancel?.();
      return;
    }

    if (key.name === 'return') {
      onSubmit(Array.from(selected));
      return;
    }

    if (key.name === 'up' || (key.sequence === 'k' && !key.ctrl && !key.meta)) {
      setActiveIndex((i) => (i > 0 ? i - 1 : items.length - 1));
      return;
    }

    if (
      key.name === 'down' ||
      (key.sequence === 'j' && !key.ctrl && !key.meta)
    ) {
      if (activeIndex === items.length - 1 && onDownFromLastItem) {
        onDownFromLastItem();
        return;
      }
      setActiveIndex((i) => (i < items.length - 1 ? i + 1 : 0));
      return;
    }

    // Space toggles current item.
    if (key.name === 'space' || key.sequence === ' ') {
      toggleAt(activeIndex);
      return;
    }

    // Numeric input — jump focus + toggle.
    if (
      showNumbers &&
      key.sequence &&
      /^[0-9]$/.test(key.sequence) &&
      !key.ctrl &&
      !key.meta
    ) {
      const state = numberInputRef.current;
      if (state.timer) clearTimeout(state.timer);
      const newBuf = state.buffer + key.sequence;
      const targetIdx = parseInt(newBuf, 10) - 1;
      if (targetIdx >= 0 && targetIdx < items.length) {
        setActiveIndex(targetIdx);
        // Debounce to allow multi-digit input.
        const potential = parseInt(newBuf + '0', 10);
        if (potential > items.length) {
          toggleAt(targetIdx);
          state.buffer = '';
        } else {
          state.buffer = newBuf;
          state.timer = setTimeout(() => {
            toggleAt(targetIdx);
            state.buffer = '';
          }, 350);
        }
      } else {
        state.buffer = '';
      }
      return;
    }
  };

  useKeypress(handleKey, { isActive: isFocused && !isDisabled });

  return (
    <Box flexDirection="column">
      {items.map((item, idx) => {
        const isActive = idx === activeIndex;
        const isChecked = selected.has(item.value);
        const checkbox = isChecked ? '[x]' : '[ ]';
        const numberPrefix = showNumbers ? `${idx + 1}.` : '';
        let labelColor = Colors.Foreground;
        if (item.disabled) labelColor = Colors.Gray;
        else if (isActive) labelColor = Colors.AccentGreen;
        else if (isChecked) labelColor = Colors.AccentGreen;

        return (
          <Box key={idx} flexDirection="row">
            <Box minWidth={2} flexShrink={0}>
              <Text color={isActive ? Colors.AccentGreen : Colors.Foreground}>
                {isActive ? '•' : ' '}
              </Text>
            </Box>
            {showNumbers && (
              <Box marginRight={1} flexShrink={0}>
                <Text color={isActive ? Colors.AccentGreen : Colors.Gray}>
                  {numberPrefix}
                </Text>
              </Box>
            )}
            <Box marginRight={1} flexShrink={0}>
              <Text color={isChecked ? Colors.AccentGreen : Colors.Gray}>
                {checkbox}
              </Text>
            </Box>
            <Text color={labelColor} wrap="truncate">
              {item.label}
              {item.description && (
                <Text color={Colors.Gray}> — {item.description}</Text>
              )}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
