/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useGoalWizard — Host-side glue for the /goal command.
 *
 * Responsibilities:
 *   - Own the wizard open/closed state.
 *   - On wizard complete:
 *       1. Auto-enable YOLO mode if not already on (with a notice in history).
 *       2. Assemble the goal-driven prompt.
 *       3. Submit the prompt to the model via submitQuery.
 *   - On wizard cancel: close silently with an info message.
 */

import { useCallback, useState } from 'react';
import { type Config } from 'otto-core';
import type { PartListUnion } from '@google/genai';
import { MessageType } from '../types.js';
import type { HistoryItem } from '../types.js';
import { type GoalWizardResult } from '../components/GoalWizard.js';
import { launchGoalMode } from './launchGoalMode.js';
import { t, tp } from '../utils/i18n.js';

interface UseGoalWizardArgs {
  config: Config | null;
  addItem: (item: Omit<HistoryItem, 'id'>, timestamp: number) => void;
  submitQuery: (
    query: PartListUnion,
    options?: { isContinuation?: boolean; silent?: boolean },
  ) => void;
}

interface UseGoalWizardReturn {
  isGoalWizardOpen: boolean;
  openGoalWizard: () => void;
  handleGoalWizardComplete: (result: GoalWizardResult) => void;
  handleGoalWizardCancel: () => void;
}

export function useGoalWizard(args: UseGoalWizardArgs): UseGoalWizardReturn {
  const { config, addItem, submitQuery } = args;
  const [isOpen, setIsOpen] = useState(false);

  const openGoalWizard = useCallback(() => {
    setIsOpen(true);
  }, []);

  const handleGoalWizardCancel = useCallback(() => {
    setIsOpen(false);
    addItem(
      {
        type: MessageType.INFO,
        text: t('goalWizard.cancelled'),
      },
      Date.now(),
    );
  }, [addItem]);

  const handleGoalWizardComplete = useCallback(
    (result: GoalWizardResult) => {
      setIsOpen(false);

      if (!config) {
        return;
      }

      // 启动目标模式（YOLO + buildGoalPrompt + setGoalContext）——与飞书共用同一内核。
      let outcome;
      try {
        outcome = launchGoalMode(config, result);
      } catch (err) {
        // 唯一会抛出的情况：开启 YOLO 失败。中止启动并提示。
        addItem(
          {
            type: MessageType.ERROR,
            text: tp('goalWizard.yolo_enable_failed', {
              error: err instanceof Error ? err.message : String(err),
            }),
          },
          Date.now(),
        );
        return;
      }

      // YOLO 自动开启提示（仅当本次确实开启了）。
      if (outcome.yoloWasEnabled) {
        addItem(
          {
            type: MessageType.INFO,
            text: t('goalWizard.yolo_auto_enabled'),
          },
          Date.now(),
        );
      }

      // 启动播报。
      const intensityLabel = t(`goalWizard.intensity.${result.intensity}`);
      addItem(
        {
          type: MessageType.INFO,
          text: tp('goalWizard.launched_announce', {
            hours: result.hours,
            intensity: intensityLabel,
          }),
        },
        Date.now(),
      );

      // 把 prompt 静默喂给 agent loop（prompt 内容含系统红线，不显示在历史里）。
      setTimeout(() => {
        submitQuery(outcome.prompt, { silent: true });
      }, 50);
    },
    [config, addItem, submitQuery],
  );

  return {
    isGoalWizardOpen: isOpen,
    openGoalWizard,
    handleGoalWizardComplete,
    handleGoalWizardCancel,
  };
}
