/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../../../colors.js';
import type { AskUserQuestion } from 'otto-core';

export interface QuestionNavigationBarProps {
  questions: AskUserQuestion[];
  currentQuestionIndex: number;
  answers: Record<string, string>;
  /** Hide the "✓ Submit" tab when only a single single-select question. */
  hideSubmitTab?: boolean;
}

/**
 * Tab-style bar showing all questions with progress indicators.
 * Single-question single-select mode hides the bar entirely.
 */
export function QuestionNavigationBar({
  questions,
  currentQuestionIndex,
  answers,
  hideSubmitTab = false,
}: QuestionNavigationBarProps): React.JSX.Element | null {
  // Do not render for the trivial single-question single-select case.
  if (questions.length === 1 && hideSubmitTab) {
    return null;
  }

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Text color={currentQuestionIndex === 0 ? Colors.Gray : Colors.Foreground}>
        ←{' '}
      </Text>
      {questions.map((q, idx) => {
        const isSelected = idx === currentQuestionIndex;
        const isAnswered = q?.question && !!answers[q.question];
        const checkbox = isAnswered ? '☑' : '☐';
        const header = q?.header || `Q${idx + 1}`;
        if (isSelected) {
          return (
            <Box key={q.question || idx}>
              <Text backgroundColor={Colors.AccentBlue} color={Colors.Background}>
                {' '}
                {checkbox} {header}{' '}
              </Text>
            </Box>
          );
        }
        return (
          <Box key={q.question || idx}>
            <Text>
              {' '}
              {checkbox} {header}{' '}
            </Text>
          </Box>
        );
      })}
      {!hideSubmitTab && (
        <Box>
          {currentQuestionIndex === questions.length ? (
            <Text backgroundColor={Colors.AccentBlue} color={Colors.Background}>
              {' '}
              ✓ Submit{' '}
            </Text>
          ) : (
            <Text> ✓ Submit </Text>
          )}
        </Box>
      )}
      <Text
        color={
          currentQuestionIndex === questions.length ||
          (questions.length === 1 && hideSubmitTab)
            ? Colors.Gray
            : Colors.Foreground
        }
      >
        {' '}
        →
      </Text>
    </Box>
  );
}
