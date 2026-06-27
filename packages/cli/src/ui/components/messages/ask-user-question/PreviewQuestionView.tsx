/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 *
 * PreviewQuestionView — side-by-side question layout used when at least one
 * option has a `preview` field. Only supported for single-select questions.
 *
 *   ┌ Left (vertical option list) ─┐   ┌ Right (preview + notes) ─┐
 *   │ 1. Option A                  │   │ ┌─ PreviewBox ──────────┐ │
 *   │ 2. Option B  ◀ focused       │   │ │  markdown content      │ │
 *   │ 3. Option C                  │   │ └────────────────────────┘ │
 *   └──────────────────────────────┘   │ Notes: press n to add...   │
 *                                      └────────────────────────────┘
 */

import React, { useCallback, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../../../colors.js';
import type { AskUserQuestion } from 'otto-core';
import { useKeypress, Key } from '../../../hooks/useKeypress.js';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { SimpleTextInput } from '../../shared/SimpleTextInput.js';
import { PreviewBox } from './PreviewBox.js';
import { QuestionNavigationBar } from './QuestionNavigationBar.js';
import type { QuestionState } from './use-multiple-choice-state.js';

export interface PreviewQuestionViewProps {
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
  onAnswer: (
    questionText: string,
    label: string | string[],
    textInput?: string,
    shouldAdvance?: boolean,
  ) => void;
  onTextInputFocus: (isInInput: boolean) => void;
  onCancel: () => void;
  onTabPrev?: () => void;
  onTabNext?: () => void;
  onRespondToClaude: () => void;
  onFinishPlanInterview: () => void;
}

export function PreviewQuestionView({
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
  onTabPrev,
  onTabNext,
  onRespondToClaude,
  onFinishPlanInterview,
}: PreviewQuestionViewProps): React.JSX.Element {
  const questionText = question.question;
  const questionState = questionStates[questionText];
  const { columns } = useTerminalSize();

  const [focusedIndex, setFocusedIndex] = useState(0);
  const [isFooterFocused, setIsFooterFocused] = useState(false);
  const [footerIndex, setFooterIndex] = useState(0);
  const [isInNotes, setIsInNotes] = useState(false);

  // Reset on question switch.
  const prev = useRef(questionText);
  if (prev.current !== questionText) {
    prev.current = questionText;
    const sel = questionState?.selectedValue as string | undefined;
    const idx = sel ? question.options.findIndex((o) => o.label === sel) : -1;
    setFocusedIndex(idx >= 0 ? idx : 0);
    setIsFooterFocused(false);
    setIsInNotes(false);
  }

  const focusedOption = question.options[focusedIndex];
  const selectedValue = questionState?.selectedValue as string | undefined;
  const notesValue = questionState?.textInputValue ?? '';

  const selectAt = useCallback(
    (idx: number) => {
      const opt = question.options[idx];
      if (!opt) return;
      setFocusedIndex(idx);
      onUpdateQuestionState(
        questionText,
        { selectedValue: opt.label },
        false,
      );
      onAnswer(questionText, opt.label, undefined, true);
    },
    [question.options, questionText, onUpdateQuestionState, onAnswer],
  );

  const exitNotes = useCallback(() => {
    setIsInNotes(false);
    onTextInputFocus(false);
    if (selectedValue) {
      onAnswer(questionText, selectedValue, undefined, false);
    }
  }, [selectedValue, questionText, onAnswer, onTextInputFocus]);

  const handleKey = useCallback(
    (key: Key) => {
      if (!isFocused) return;

      if (isFooterFocused) {
        if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
          if (footerIndex === 0) setIsFooterFocused(false);
          else setFooterIndex(0);
          return;
        }
        if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
          if (isInPlanMode && footerIndex === 0) setFooterIndex(1);
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

      if (isInNotes) {
        if (key.name === 'escape') exitNotes();
        return;
      }

      if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
        if (focusedIndex > 0) setFocusedIndex(focusedIndex - 1);
        return;
      }
      if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
        if (focusedIndex === question.options.length - 1) {
          setIsFooterFocused(true);
          return;
        }
        setFocusedIndex(focusedIndex + 1);
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
        selectAt(focusedIndex);
        return;
      }
      if (
        key.sequence === 'n' &&
        !key.ctrl &&
        !key.meta &&
        !key.shift
      ) {
        setIsInNotes(true);
        onTextInputFocus(true);
        return;
      }
      if (key.name === 'escape') {
        onCancel();
        return;
      }
      if (
        key.sequence &&
        /^[1-9]$/.test(key.sequence) &&
        !key.ctrl &&
        !key.meta
      ) {
        const idx = parseInt(key.sequence, 10) - 1;
        if (idx < question.options.length) setFocusedIndex(idx);
      }
    },
    [
      isFocused,
      isFooterFocused,
      footerIndex,
      isInPlanMode,
      isInNotes,
      focusedIndex,
      question.options.length,
      selectAt,
      exitNotes,
      onRespondToClaude,
      onFinishPlanInterview,
      onCancel,
      onTabNext,
      onTabPrev,
      onTextInputFocus,
    ],
  );

  useKeypress(handleKey, { isActive: isFocused && !isInNotes });

  const LEFT_PANEL_WIDTH = 30;
  const GAP = 4;
  const previewMaxWidth = Math.max(20, columns - LEFT_PANEL_WIDTH - GAP - 4);

  return (
    <Box flexDirection="column">
      <QuestionNavigationBar
        questions={questions}
        currentQuestionIndex={currentQuestionIndex}
        answers={answers}
        hideSubmitTab={hideSubmitTab}
      />

      <Box marginBottom={1}>
        <Text bold>{question.question}</Text>
      </Box>

      <Box flexDirection="row" gap={4}>
        {/* Left: options */}
        <Box flexDirection="column" width={LEFT_PANEL_WIDTH}>
          {question.options.map((opt, idx) => {
            const isFocusedRow = focusedIndex === idx;
            const isSelected = selectedValue === opt.label;
            return (
              <Box key={opt.label} flexDirection="row">
                <Text
                  color={
                    isFocusedRow ? Colors.AccentGreen : Colors.Foreground
                  }
                >
                  {isFocusedRow ? '•' : ' '}
                </Text>
                <Text color={Colors.Gray}> {idx + 1}.</Text>
                <Text
                  color={
                    isSelected
                      ? Colors.AccentGreen
                      : isFocusedRow
                        ? Colors.AccentGreen
                        : Colors.Foreground
                  }
                  bold={isFocusedRow}
                >
                  {' '}
                  {opt.label}
                </Text>
                {isSelected && <Text color={Colors.AccentGreen}> ✓</Text>}
              </Box>
            );
          })}
        </Box>

        {/* Right: preview + notes */}
        <Box flexDirection="column" flexGrow={1}>
          <PreviewBox
            content={focusedOption?.preview || 'No preview available'}
            maxWidth={previewMaxWidth}
          />
          <Box marginTop={1} flexDirection="row">
            <Text color={Colors.AccentGreen}>Notes: </Text>
            {isInNotes ? (
              <Box flexGrow={1}>
                <SimpleTextInput
                  value={notesValue}
                  onChange={(v) =>
                    onUpdateQuestionState(
                      questionText,
                      { textInputValue: v },
                      false,
                    )
                  }
                  onSubmit={exitNotes}
                  onCancel={exitNotes}
                  placeholder="Add notes on this design…"
                  prompt=""
                  isActive
                />
              </Box>
            ) : (
              <Text color={Colors.Gray} italic>
                {notesValue || 'press n to add notes'}
              </Text>
            )}
          </Box>
        </Box>
      </Box>

      {/* Footer */}
      <Box flexDirection="column" marginTop={1}>
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

      <Box marginTop={1}>
        <Text color={Colors.Gray} dimColor>
          Enter to select · ↑/↓ to navigate · n to add notes
          {questions.length > 1 ? ' · Tab to switch questions' : ''} · Esc to
          cancel
        </Text>
      </Box>
    </Box>
  );
}
