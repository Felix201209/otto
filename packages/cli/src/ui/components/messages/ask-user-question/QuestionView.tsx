/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 *
 * QuestionView — single-question renderer, supports single- and multi-select,
 * auto-appends an "Other" free-text option, and exposes a footer with
 * "Chat about this" (and plan-mode "Skip interview and plan immediately").
 *
 * Focus lives in one of three places at any time:
 *   1. the option list (default, navigated with ↑/↓ or j/k)
 *   2. the "Other" text input (entered by pressing Enter on the Other row)
 *   3. the footer (entered by pressing ↓ from the last option)
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../../../colors.js';
import type { AskUserQuestion } from 'otto-core';
import { useKeypress, Key } from '../../../hooks/useKeypress.js';
import { SimpleTextInput } from '../../shared/SimpleTextInput.js';
import { SelectMulti } from '../../shared/SelectMulti.js';
import { QuestionNavigationBar } from './QuestionNavigationBar.js';
import type { QuestionState } from './use-multiple-choice-state.js';

export interface QuestionViewProps {
  question: AskUserQuestion;
  questions: AskUserQuestion[];
  currentQuestionIndex: number;
  answers: Record<string, string>;
  questionStates: Record<string, QuestionState>;
  hideSubmitTab?: boolean;
  isInPlanMode?: boolean;
  isFocused?: boolean;
  onUpdateQuestionState: (
    questionText: string,
    updates: Partial<QuestionState>,
    isMultiSelect: boolean,
  ) => void;
  /**
   * Set an answer for this question.
   * @param label  - for single-select: the selected option label, or "__other__"
   *                 for multi-select: an array of labels
   * @param textInput - for single-select "Other": raw user text
   * @param shouldAdvance - whether to auto-advance to the next question
   */
  onAnswer: (
    questionText: string,
    label: string | string[],
    textInput?: string,
    shouldAdvance?: boolean,
  ) => void;
  onTextInputFocus: (isInInput: boolean) => void;
  onCancel: () => void;
  onSubmit: () => void;
  onTabPrev?: () => void;
  onTabNext?: () => void;
  onRespondToClaude: () => void;
  onFinishPlanInterview: () => void;
}

const OTHER_SENTINEL = '__other__';

export function QuestionView({
  question,
  questions,
  currentQuestionIndex,
  answers,
  questionStates,
  hideSubmitTab = false,
  isInPlanMode = false,
  isFocused = true,
  onUpdateQuestionState,
  onAnswer,
  onTextInputFocus,
  onCancel,
  onSubmit,
  onTabPrev,
  onTabNext,
  onRespondToClaude,
  onFinishPlanInterview,
}: QuestionViewProps): React.JSX.Element {
  const questionText = question.question;
  const questionState = questionStates[questionText];
  const isMultiSelect = !!question.multiSelect;

  // Which row is currently focused in the option list (including the Other row).
  const [focusedIndex, setFocusedIndex] = useState(0);
  // Whether user is typing inside the Other input.
  const [isInOtherInput, setIsInOtherInput] = useState(false);
  // Whether footer has keyboard focus.
  const [isFooterFocused, setIsFooterFocused] = useState(false);
  // 0 = "Chat about this", 1 = "Skip interview..." (plan mode only).
  const [footerIndex, setFooterIndex] = useState(0);

  // Reset focus when switching questions.
  const prevQuestionText = useRef(questionText);
  if (prevQuestionText.current !== questionText) {
    prevQuestionText.current = questionText;
    setFocusedIndex(0);
    setIsInOtherInput(false);
    setIsFooterFocused(false);
    setFooterIndex(0);
  }

  // Options list: real options + the auto-appended Other row.
  const totalRows = question.options.length + 1; // +1 for Other
  const isLastRow = focusedIndex === totalRows - 1;
  const isOtherRowFocused = isLastRow;

  const otherTextValue = questionState?.textInputValue ?? '';

  // Inactive while any subcomponent (Other input, footer) has focus.
  const listActive =
    isFocused && !isInOtherInput && !isFooterFocused && !isMultiSelect;

  /** Pick an option by index (real option only, not Other). */
  const pickOption = useCallback(
    (idx: number) => {
      const opt = question.options[idx];
      if (!opt) return;
      onUpdateQuestionState(
        questionText,
        { selectedValue: opt.label },
        isMultiSelect,
      );
      onAnswer(questionText, opt.label, undefined, true);
    },
    [question.options, questionText, isMultiSelect, onUpdateQuestionState, onAnswer],
  );

  /** Enter the Other free-text mode. */
  const enterOtherInput = useCallback(() => {
    setIsInOtherInput(true);
    onTextInputFocus(true);
  }, [onTextInputFocus]);

  /** Exit Other input mode (submit or escape). */
  const exitOtherInput = useCallback(
    (submit: boolean) => {
      setIsInOtherInput(false);
      onTextInputFocus(false);
      if (submit && otherTextValue.trim()) {
        onUpdateQuestionState(
          questionText,
          { selectedValue: OTHER_SENTINEL, textInputValue: otherTextValue },
          isMultiSelect,
        );
        onAnswer(questionText, OTHER_SENTINEL, otherTextValue, true);
      }
    },
    [otherTextValue, questionText, isMultiSelect, onUpdateQuestionState, onAnswer, onTextInputFocus],
  );

  /** Keyboard handling for the single-select option list + footer nav. */
  const handleKey = useCallback(
    (key: Key) => {
      if (!isFocused) return;

      // Footer takes priority when focused.
      if (isFooterFocused) {
        if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
          if (footerIndex === 0) {
            setIsFooterFocused(false);
          } else {
            setFooterIndex(0);
          }
          return;
        }
        if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
          if (isInPlanMode && footerIndex === 0) {
            setFooterIndex(1);
          }
          return;
        }
        if (key.name === 'return') {
          if (footerIndex === 0) onRespondToClaude();
          else onFinishPlanInterview();
          return;
        }
        if (key.name === 'escape') onCancel();
        return;
      }

      // Option list navigation (single-select only — multi handles itself).
      if (isMultiSelect || isInOtherInput) return;

      if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
        setFocusedIndex((i) => (i > 0 ? i - 1 : totalRows - 1));
        return;
      }
      if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
        if (focusedIndex === totalRows - 1) {
          setIsFooterFocused(true);
          return;
        }
        setFocusedIndex((i) => i + 1);
        return;
      }
      if (key.name === 'tab' && !key.shift) {
        onTabNext?.();
        return;
      }
      if (key.name === 'tab' && key.shift) {
        onTabPrev?.();
        return;
      }
      if (key.name === 'return') {
        if (isOtherRowFocused) {
          enterOtherInput();
        } else {
          pickOption(focusedIndex);
        }
        return;
      }
      if (key.name === 'escape') {
        onCancel();
        return;
      }
      // Numeric shortcut (single digit only for simplicity).
      if (
        key.sequence &&
        /^[1-9]$/.test(key.sequence) &&
        !key.ctrl &&
        !key.meta
      ) {
        const idx = parseInt(key.sequence, 10) - 1;
        if (idx < question.options.length) {
          pickOption(idx);
        } else if (idx === question.options.length) {
          setFocusedIndex(idx);
          enterOtherInput();
        }
      }
    },
    [
      isFocused,
      isFooterFocused,
      footerIndex,
      isInPlanMode,
      isMultiSelect,
      isInOtherInput,
      totalRows,
      focusedIndex,
      isOtherRowFocused,
      question.options.length,
      enterOtherInput,
      pickOption,
      onRespondToClaude,
      onFinishPlanInterview,
      onCancel,
      onTabNext,
      onTabPrev,
    ],
  );

  useKeypress(handleKey, {
    isActive: isFocused && !isInOtherInput,
  });

  // ==========================================================================
  // Multi-select mode: delegate to SelectMulti. "Other" becomes a special row
  // that, when toggled + has text, contributes the text to the selection set.
  // ==========================================================================
  const multiItems = useMemo(() => {
    const items = question.options.map((o) => ({
      label: o.label,
      value: o.label,
      description: o.description,
    }));
    items.push({
      label: otherTextValue
        ? `Other — ${otherTextValue}`
        : 'Other (type something)',
      value: OTHER_SENTINEL,
      description: '',
    });
    return items;
  }, [question.options, otherTextValue]);

  const handleMultiChange = useCallback(
    (values: string[]) => {
      onUpdateQuestionState(
        questionText,
        { selectedValue: values },
        true,
      );
      // Don't advance on change; only on submit.
      const resolved = values
        .map((v) =>
          v === OTHER_SENTINEL
            ? otherTextValue.trim() || null
            : v,
        )
        .filter((v): v is string => !!v);
      onAnswer(questionText, resolved, undefined, false);
    },
    [questionText, otherTextValue, onUpdateQuestionState, onAnswer],
  );

  const handleMultiSubmit = useCallback(
    (values: string[]) => {
      const resolved = values
        .map((v) =>
          v === OTHER_SENTINEL
            ? otherTextValue.trim() || null
            : v,
        )
        .filter((v): v is string => !!v);
      onUpdateQuestionState(
        questionText,
        { selectedValue: values },
        true,
      );
      onAnswer(questionText, resolved, undefined, true);
      onSubmit();
    },
    [questionText, otherTextValue, onUpdateQuestionState, onAnswer, onSubmit],
  );

  // ==========================================================================
  // Render
  // ==========================================================================
  return (
    <Box flexDirection="column">
      <QuestionNavigationBar
        questions={questions}
        currentQuestionIndex={currentQuestionIndex}
        answers={answers}
        hideSubmitTab={hideSubmitTab}
      />

      {/* Question text */}
      <Box marginBottom={1}>
        <Text bold>{question.question}</Text>
      </Box>

      {/* Options */}
      <Box flexDirection="column" marginBottom={1}>
        {isMultiSelect ? (
          <SelectMulti
            items={multiItems}
            defaultValues={
              Array.isArray(questionState?.selectedValue)
                ? (questionState!.selectedValue as string[])
                : []
            }
            onChange={handleMultiChange}
            onSubmit={handleMultiSubmit}
            onCancel={onCancel}
            isFocused={isFocused && !isFooterFocused}
            showNumbers
            isDisabled={isFooterFocused}
            onDownFromLastItem={() => setIsFooterFocused(true)}
          />
        ) : (
          <SingleSelectRows
            options={question.options}
            focusedIndex={focusedIndex}
            selectedLabel={
              typeof questionState?.selectedValue === 'string'
                ? (questionState!.selectedValue as string)
                : undefined
            }
            isActive={listActive}
            isInOtherInput={isInOtherInput}
            otherText={otherTextValue}
            onOtherChange={(v) =>
              onUpdateQuestionState(
                questionText,
                { textInputValue: v },
                isMultiSelect,
              )
            }
            onOtherSubmit={() => exitOtherInput(true)}
            onOtherCancel={() => exitOtherInput(false)}
          />
        )}
      </Box>

      {/* Footer: Chat about this / Skip interview */}
      <Box flexDirection="column">
        <Box
          borderStyle="single"
          borderColor={Colors.Gray}
          borderDimColor
          borderTop
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
        />
        <Box flexDirection="row">
          <Text
            color={
              isFooterFocused && footerIndex === 0
                ? Colors.AccentGreen
                : Colors.Gray
            }
          >
            {isFooterFocused && footerIndex === 0 ? '▶ ' : '  '}
            Chat about this
          </Text>
        </Box>
        {isInPlanMode && (
          <Box flexDirection="row">
            <Text
              color={
                isFooterFocused && footerIndex === 1
                  ? Colors.AccentGreen
                  : Colors.Gray
              }
            >
              {isFooterFocused && footerIndex === 1 ? '▶ ' : '  '}
              Skip interview and plan immediately
            </Text>
          </Box>
        )}
      </Box>

      {/* Help line */}
      <Box marginTop={1}>
        <Text color={Colors.Gray} dimColor>
          Enter to select ·{' '}
          {questions.length === 1 ? '↑/↓ to navigate' : 'Tab/↑↓ to navigate'}
          {isMultiSelect ? ' · Space to toggle' : ''}
          {isInOtherInput ? ' · Esc to exit input' : ''} · Esc to cancel
        </Text>
      </Box>
    </Box>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

interface SingleSelectRowsProps {
  options: AskUserQuestion['options'];
  focusedIndex: number;
  selectedLabel?: string;
  isActive: boolean;
  isInOtherInput: boolean;
  otherText: string;
  onOtherChange: (v: string) => void;
  onOtherSubmit: () => void;
  onOtherCancel: () => void;
}

function SingleSelectRows({
  options,
  focusedIndex,
  selectedLabel,
  isActive: _isActive,
  isInOtherInput,
  otherText,
  onOtherChange,
  onOtherSubmit,
  onOtherCancel,
}: SingleSelectRowsProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {options.map((opt, idx) => {
        const isFocused = focusedIndex === idx;
        const isSelected = selectedLabel === opt.label;
        return (
          <Box key={opt.label} flexDirection="row">
            <Box minWidth={2} flexShrink={0}>
              <Text color={isFocused ? Colors.AccentGreen : Colors.Foreground}>
                {isFocused ? '•' : ' '}
              </Text>
            </Box>
            <Box marginRight={1} flexShrink={0}>
              <Text color={isFocused ? Colors.AccentGreen : Colors.Gray}>
                {idx + 1}.
              </Text>
            </Box>
            <Text
              color={
                isSelected
                  ? Colors.AccentGreen
                  : isFocused
                    ? Colors.AccentGreen
                    : Colors.Foreground
              }
              bold={isFocused}
              wrap="truncate"
            >
              {opt.label}
              {opt.description && (
                <Text color={Colors.Gray}> — {opt.description}</Text>
              )}
            </Text>
            {isSelected && <Text color={Colors.AccentGreen}> ✓</Text>}
          </Box>
        );
      })}

      {/* Other row */}
      <Box flexDirection="row">
        <Box minWidth={2} flexShrink={0}>
          <Text
            color={
              focusedIndex === options.length
                ? Colors.AccentGreen
                : Colors.Foreground
            }
          >
            {focusedIndex === options.length ? '•' : ' '}
          </Text>
        </Box>
        <Box marginRight={1} flexShrink={0}>
          <Text
            color={
              focusedIndex === options.length
                ? Colors.AccentGreen
                : Colors.Gray
            }
          >
            {options.length + 1}.
          </Text>
        </Box>
        {isInOtherInput ? (
          <Box flexGrow={1}>
            <SimpleTextInput
              value={otherText}
              onChange={onOtherChange}
              onSubmit={onOtherSubmit}
              onCancel={onOtherCancel}
              placeholder="Type something"
              prompt=""
              isActive
            />
          </Box>
        ) : (
          <Text
            color={
              focusedIndex === options.length
                ? Colors.AccentGreen
                : Colors.Foreground
            }
            bold={focusedIndex === options.length}
          >
            Other
            {otherText ? (
              <Text color={Colors.Gray}> — {otherText}</Text>
            ) : (
              <Text color={Colors.Gray}> (type something)</Text>
            )}
          </Text>
        )}
      </Box>
    </Box>
  );
}
