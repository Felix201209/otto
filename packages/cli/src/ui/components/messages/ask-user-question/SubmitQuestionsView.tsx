/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../../../colors.js';
import type { AskUserQuestion } from 'otto-core';
import {
  RadioButtonSelect,
  RadioSelectItem,
} from '../../shared/RadioButtonSelect.js';
import { QuestionNavigationBar } from './QuestionNavigationBar.js';

export interface SubmitQuestionsViewProps {
  questions: AskUserQuestion[];
  currentQuestionIndex: number;
  answers: Record<string, string>;
  allQuestionsAnswered: boolean;
  onFinalResponse: (value: 'submit' | 'cancel') => void;
  isFocused?: boolean;
}

/**
 * Review/submit screen shown after the last question in multi-question mode.
 * Lets the user confirm the collected answers or cancel.
 */
export function SubmitQuestionsView({
  questions,
  currentQuestionIndex,
  answers,
  allQuestionsAnswered,
  onFinalResponse,
  isFocused = true,
}: SubmitQuestionsViewProps): React.JSX.Element {
  const options: Array<RadioSelectItem<'submit' | 'cancel'>> = [
    { label: 'Submit answers', value: 'submit' },
    { label: 'Cancel', value: 'cancel' },
  ];

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={Colors.Gray}
        borderDimColor
        paddingTop={0}
        paddingX={1}
      >
        <QuestionNavigationBar
          questions={questions}
          currentQuestionIndex={currentQuestionIndex}
          answers={answers}
        />
        <Text bold>Review your answers</Text>

        <Box flexDirection="column" marginTop={1}>
          {!allQuestionsAnswered && (
            <Box marginBottom={1}>
              <Text color={Colors.AccentYellow}>
                ⚠ You have not answered all questions
              </Text>
            </Box>
          )}
          {Object.keys(answers).length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              {questions
                .filter((q) => q?.question && answers[q.question])
                .map((q) => {
                  const answer = answers[q.question];
                  return (
                    <Box key={q.question} flexDirection="column" marginLeft={1}>
                      <Text>• {q.question}</Text>
                      <Box marginLeft={2}>
                        <Text color={Colors.AccentGreen}>→ {answer}</Text>
                      </Box>
                    </Box>
                  );
                })}
            </Box>
          )}
          <Text color={Colors.Gray}>Ready to submit your answers?</Text>
          <Box marginTop={1}>
            <RadioButtonSelect
              items={options}
              onSelect={onFinalResponse}
              isFocused={isFocused}
              showNumbers
            />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
