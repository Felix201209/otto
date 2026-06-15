/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DebateWizard — interactive wizard for configuring a /debate session.
 *
 * Flow (with language selection if needed):
 *   Step 0 (PICK_PRESET)  - shown only if project has saved presets.
 *   Step 1 (PICK_LANGUAGE) - shown only if preferredLanguage is not set. User picks language, saves it.
 *   Step 2 (MODELS)       - multi-select 2-3 models.
 *   Step 3 (ROUNDS)       - single-select rounds per model (1/2).
 *   Step 4 (TOPIC)        - free-text topic input.
 *   Step 5 (CONFIRM)      - review summary, start or go back.
 *
 * Design notes:
 * - i18n support: UI language is automatically detected (Chinese/English).
 * - Language selection: Only if preferredLanguage not set, otherwise use it directly.
 * - Model list is provided by the caller (debateCommand) so this component
 *   stays pure/testable — it doesn't know how to enumerate models.
 */

import React, { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { SimpleTextInput } from './shared/SimpleTextInput.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { SelectMulti } from './shared/SelectMulti.js';
import { useKeypress, Key } from '../hooks/useKeypress.js';
import type { DebatePreset } from '../utils/debateStorage.js';
import { getDebateI18nTexts, type DebateLanguage } from '../utils/debateI18n.js';
import { detectUILanguage } from '../utils/debateLanguageUtils.js';

export interface DebateWizardResult {
  topic: string;
  models: string[];
  rounds: number;
  language: DebateLanguage;
}

export interface DebateWizardAvailableModel {
  /** Model ID used for switchModel() calls. */
  id: string;
  /** Human-readable label shown in the picker. */
  label: string;
  /** Optional secondary text (e.g. provider). */
  description?: string;
}

export interface DebateWizardProps {
  /** All models available for selection, in display order. */
  availableModels: DebateWizardAvailableModel[];
  /** Previously saved presets for this project, newest first. May be empty. */
  presets: DebatePreset[];
  /** User's preferred language setting (if any). Used to skip language step or set default. */
  preferredLanguage?: string;
  /** User accepted final config — host should start the debate. */
  onComplete: (result: DebateWizardResult) => void;
  /** User escaped out — no debate starts. */
  onCancel: () => void;
  /** Called when user selects a language to persist it in settings. */
  onLanguageSelected?: (language: DebateLanguage) => void;
}

enum Step {
  PICK_PRESET = 'pickPreset',
  PICK_LANGUAGE = 'pickLanguage',
  PICK_CUSTOM_LANG = 'pickCustomLang',
  MODELS = 'models',
  ROUNDS = 'rounds',
  TOPIC = 'topic',
  CONFIRM = 'confirm',
}

const MIN_MODELS = 2;
const MAX_MODELS = 3;

// Helper: format preset label with i18n support
function formatPresetLabel(
  p: DebatePreset,
  texts: ReturnType<typeof getDebateI18nTexts>,
): string {
  const ago = relativeTime(p.savedAt, texts);
  const modelsStr = p.models.join(' + ');
  const rounds = texts.presetRounds;
  return `${p.topic}  ·  ${modelsStr}, ${p.rounds}${rounds}  ·  ${ago}`;
}

// Helper: calculate relative time with i18n support
function relativeTime(iso: string, texts: ReturnType<typeof getDebateI18nTexts>): string {
  try {
    const then = new Date(iso).getTime();
    const delta = Date.now() - then;
    const m = Math.floor(delta / 60000);
    if (m < 1) return texts.agoJustNow;
    if (m < 60) return `${m}${texts.agoMinsAgo}`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}${texts.agoHoursAgo}`;
    const d = Math.floor(h / 24);
    return `${d}${texts.agoDaysAgo}`;
  } catch {
    return iso;
  }
}

// Helper: get step title with i18n support
function stepTitle(step: Step, texts: ReturnType<typeof getDebateI18nTexts>): string {
  switch (step) {
    case Step.PICK_PRESET:
      return texts.stepPickPreset;
    case Step.PICK_LANGUAGE:
      return texts.stepPickLang;
    case Step.PICK_CUSTOM_LANG:
      return texts.stepPickLang;
    case Step.MODELS:
      return texts.stepModels;
    case Step.ROUNDS:
      return texts.stepRounds;
    case Step.TOPIC:
      return texts.stepTopic;
    case Step.CONFIRM:
      return texts.stepConfirm;
    default:
      return '';
  }
}

// Helper: get step description with i18n support
function stepDescription(step: Step, texts: ReturnType<typeof getDebateI18nTexts>): string {
  switch (step) {
    case Step.PICK_PRESET:
      return texts.descPickPreset;
    case Step.PICK_LANGUAGE:
      return texts.descPickLang;
    case Step.PICK_CUSTOM_LANG:
      return texts.customLangDesc;
    case Step.MODELS:
      return texts.descModels;
    case Step.ROUNDS:
      return texts.descRounds;
    case Step.TOPIC:
      return texts.descTopic;
    case Step.CONFIRM:
      return texts.descConfirm;
    default:
      return '';
  }
}

export function DebateWizard({
  availableModels,
  presets,
  preferredLanguage,
  onComplete,
  onCancel,
  onLanguageSelected,
}: DebateWizardProps): React.JSX.Element {
  // Detect UI language for displaying wizard text
  const uiLang = detectUILanguage(preferredLanguage);
  const uiTexts = getDebateI18nTexts(uiLang);

  // Determine initial step based on whether user has presets and preferred language
  const needsLanguageSelection = !preferredLanguage;
  const initialStep = (() => {
    if (presets.length > 0) return Step.PICK_PRESET;
    if (needsLanguageSelection) return Step.PICK_LANGUAGE;
    return Step.MODELS;
  })();

  const [step, setStep] = useState<Step>(initialStep);
  const [chosenModels, setChosenModels] = useState<string[]>([]);
  const [chosenRounds, setChosenRounds] = useState<number>(2);
  const [chosenLanguage, setChosenLanguage] = useState<DebateLanguage>(
    preferredLanguage || 'en',
  );
  const [topic, setTopic] = useState<string>('');
  const [topicInput, setTopicInput] = useState<string>('');
  const [customLangInput, setCustomLangInput] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  // 标记：当前是否正从 preset 加载（此时已经有 models/rounds/topic，
  // 选完语言应直接去 CONFIRM，而不是再走 MODELS 向导）。
  const [fromPreset, setFromPreset] = useState<boolean>(false);

  // ---------- Step: PICK_PRESET ----------

  const presetItems = [
    ...presets.map((p, i) => ({
      label: formatPresetLabel(p, uiTexts),
      value: `preset:${i}`,
    })),
    { label: uiTexts.btnNewDebate, value: 'new' },
  ];

  const handlePresetSelect = useCallback(
    (value: string) => {
      if (value === 'new') {
        if (needsLanguageSelection) {
          setStep(Step.PICK_LANGUAGE);
        } else {
          setStep(Step.MODELS);
        }
        return;
      }
      const idx = Number(value.replace('preset:', ''));
      const p = presets[idx];
      if (!p) {
        if (needsLanguageSelection) {
          setStep(Step.PICK_LANGUAGE);
        } else {
          setStep(Step.MODELS);
        }
        return;
      }
      // Load preset into state.
      setChosenModels([...p.models]);
      setChosenRounds(p.rounds);
      setTopic(p.topic);
      setTopicInput(p.topic);
      setFromPreset(true);
      // 关键修复：即便使用历史设定，只要用户没配过 preferredLanguage
      // 就先走语言选择，把选择写入 settings，避免静默用 'en'。
      if (needsLanguageSelection) {
        setStep(Step.PICK_LANGUAGE);
      } else {
        setStep(Step.CONFIRM);
      }
    },
    [presets, needsLanguageSelection],
  );

  // ---------- Step: PICK_LANGUAGE ----------

  const languageItems = [
    { label: uiTexts.optChinese, value: 'zh' },
    { label: uiTexts.optEnglish, value: 'en' },
    { label: uiTexts.optCustom, value: 'custom' },
  ];

  const handleLanguageSelect = useCallback(
    (value: string) => {
      if (value === 'custom') {
        // Switch to custom language input step
        setError(null);
        setStep(Step.PICK_CUSTOM_LANG);
        return;
      }
      const lang = value as DebateLanguage;
      setChosenLanguage(lang);
      onLanguageSelected?.(lang);
      // 从 preset 进来的话，直接去 CONFIRM（已经有 models/rounds/topic）
      setStep(fromPreset ? Step.CONFIRM : Step.MODELS);
    },
    [onLanguageSelected, fromPreset],
  );

  const handleCustomLangSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        setError(uiTexts.msgEmptyCustomLang);
        return;
      }
      setError(null);
      setChosenLanguage(trimmed);
      onLanguageSelected?.(trimmed);
      setStep(fromPreset ? Step.CONFIRM : Step.MODELS);
    },
    [uiTexts, onLanguageSelected, fromPreset],
  );

  const handleCustomLangCancel = useCallback(() => {
    // ESC 回到语言选择页，而不是直接退出向导
    setError(null);
    setStep(Step.PICK_LANGUAGE);
  }, []);

  // ESC on certain steps cancels the whole wizard.
  // PICK_CUSTOM_LANG 有自己的 onCancel 回退到 PICK_LANGUAGE，不纳入这里。
  // PICK_LANGUAGE：如果存在 presets，ESC 应退回 PICK_PRESET 而不是直接退出向导。
  useKeypress(
    (key: Key) => {
      if (key.name === 'escape') {
        if (step === Step.PICK_LANGUAGE && presets.length > 0) {
          setStep(Step.PICK_PRESET);
        } else {
          onCancel();
        }
      }
    },
    {
      isActive:
        step === Step.PICK_PRESET ||
        step === Step.PICK_LANGUAGE ||
        step === Step.ROUNDS ||
        step === Step.CONFIRM,
    },
  );

  // ---------- Step: MODELS ----------

  const modelItems = availableModels.map((m) => ({
    label: m.label,
    value: m.id,
    description: m.description,
  }));

  const handleModelsSubmit = useCallback(
    (values: string[]) => {
      if (values.length < MIN_MODELS) {
        setError(uiTexts.msgMinModels);
        return;
      }
      if (values.length > MAX_MODELS) {
        setError(uiTexts.msgMaxModels);
        return;
      }
      setError(null);
      setChosenModels(values);
      setStep(Step.ROUNDS);
    },
    [uiTexts],
  );

  // ---------- Step: ROUNDS ----------

  const roundOptions = [
    { label: uiTexts.roundOption1, value: 1 },
    { label: uiTexts.roundOption2, value: 2 },
  ];

  const handleRoundsSelect = useCallback((value: number) => {
    setChosenRounds(value);
    setStep(Step.TOPIC);
  }, []);

  // ---------- Step: TOPIC ----------

  const handleTopicSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        setError(uiTexts.msgEmptyTopic);
        return;
      }
      setError(null);
      setTopic(trimmed);
      setStep(Step.CONFIRM);
    },
    [uiTexts],
  );

  const handleTopicCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  // ---------- Step: CONFIRM ----------

  const confirmItems = [
    { label: uiTexts.btnStart, value: 'start' },
    { label: uiTexts.btnBack, value: 'back' },
    { label: uiTexts.btnCancel, value: 'cancel' },
  ];

  const handleConfirm = useCallback(
    (value: string) => {
      if (value === 'start') {
        onComplete({
          topic,
          models: chosenModels,
          rounds: chosenRounds,
          language: chosenLanguage,
        });
      } else if (value === 'back') {
        // fromPreset 路径跳过了 MODELS/ROUNDS/TOPIC，back 应退回 PICK_PRESET
        setStep(fromPreset ? Step.PICK_PRESET : Step.MODELS);
      } else {
        onCancel();
      }
    },
    [chosenModels, chosenRounds, topic, chosenLanguage, fromPreset, onComplete, onCancel],
  );

  // ---------- Rendering ----------

  // Calculate steps order based on conditions
  let stepsOrder: Step[] = [];
  if (presets.length > 0) {
    stepsOrder.push(Step.PICK_PRESET);
  }
  if (needsLanguageSelection) {
    stepsOrder.push(Step.PICK_LANGUAGE);
  }
  stepsOrder.push(Step.MODELS, Step.ROUNDS, Step.TOPIC, Step.CONFIRM);

  const totalSteps = stepsOrder.length;
  // PICK_CUSTOM_LANG 视作 PICK_LANGUAGE 的延伸，显示同一步编号
  const effectiveStep = step === Step.PICK_CUSTOM_LANG ? Step.PICK_LANGUAGE : step;
  const currentStepIdx = stepsOrder.indexOf(effectiveStep);
  const displayStepNumber = currentStepIdx + 1;

  return (
    <Box
      borderStyle="round"
      borderColor={Colors.AccentCyan}
      flexDirection="column"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <Box marginBottom={1}>
        <Text color={Colors.AccentCyan} bold>
          {uiTexts.wizardTitle}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={Colors.Gray}>
          Step {displayStepNumber}/{totalSteps}: {stepTitle(step, uiTexts)}
        </Text>
      </Box>
      <Box marginBottom={1} flexDirection="column">
        <Text color={Colors.Comment}>{stepDescription(step, uiTexts)}</Text>
        {step === Step.CONFIRM && (
          <Text color={Colors.AccentYellow} bold>
            {uiTexts.descConfirmWarning}
          </Text>
        )}
      </Box>

      <Box
        borderStyle="single"
        borderColor={Colors.Gray}
        paddingX={1}
        paddingY={1}
        flexDirection="column"
      >
        {step === Step.PICK_PRESET && (
          <RadioButtonSelect
            items={presetItems}
            initialIndex={0}
            onSelect={handlePresetSelect}
            onHighlight={() => {}}
            isFocused
          />
        )}

        {step === Step.PICK_LANGUAGE && (
          <Box flexDirection="column">
            <RadioButtonSelect
              items={languageItems}
              initialIndex={1} // Default to English
              onSelect={handleLanguageSelect}
              onHighlight={() => {}}
              isFocused
            />
            {error && (
              <Box marginTop={1}>
                <Text color={Colors.AccentRed}>✗ {error}</Text>
              </Box>
            )}
          </Box>
        )}

        {step === Step.PICK_CUSTOM_LANG && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text color={Colors.Gray}>{uiTexts.customLangPrompt}</Text>
            </Box>
            <SimpleTextInput
              value={customLangInput}
              onChange={setCustomLangInput}
              onSubmit={handleCustomLangSubmit}
              onCancel={handleCustomLangCancel}
              isActive
            />
            {error && (
              <Box marginTop={1}>
                <Text color={Colors.AccentRed}>✗ {error}</Text>
              </Box>
            )}
            <Box marginTop={1}>
              <Text color={Colors.Gray}>
                {uiTexts.msgPressEnter}，{uiTexts.msgPressEsc}
              </Text>
            </Box>
          </Box>
        )}

        {step === Step.MODELS && (
          <Box flexDirection="column">
            {modelItems.length < MIN_MODELS ? (
              <Box flexDirection="column">
                <Text color={Colors.AccentRed}>{uiTexts.msgInsufficientModels}</Text>
                <Text color={Colors.Gray}>{uiTexts.msgConfigureModels}</Text>
                <Box marginTop={1}>
                  <Text color={Colors.Gray}>{uiTexts.msgPressEsc}</Text>
                </Box>
              </Box>
            ) : (
              <>
                <SelectMulti
                  items={modelItems}
                  onSubmit={handleModelsSubmit}
                  onCancel={onCancel}
                  isFocused
                />
                {error && (
                  <Box marginTop={1}>
                    <Text color={Colors.AccentRed}>✗ {error}</Text>
                  </Box>
                )}
              </>
            )}
          </Box>
        )}

        {step === Step.ROUNDS && (
          <RadioButtonSelect
            items={roundOptions.map((o) => ({
              label: o.label,
              value: String(o.value),
            }))}
            initialIndex={roundOptions.findIndex((o) => o.value === chosenRounds)}
            onSelect={(v) => handleRoundsSelect(Number(v))}
            onHighlight={() => {}}
            isFocused
          />
        )}

        {step === Step.TOPIC && (
          <Box flexDirection="column">
            <SimpleTextInput
              value={topicInput}
              onChange={setTopicInput}
              onSubmit={handleTopicSubmit}
              onCancel={handleTopicCancel}
              isActive
            />
            {error && (
              <Box marginTop={1}>
                <Text color={Colors.AccentRed}>✗ {error}</Text>
              </Box>
            )}
            <Box marginTop={1}>
              <Text color={Colors.Gray}>
                {uiTexts.msgPressEnter}，{uiTexts.msgPressEsc}
              </Text>
            </Box>
          </Box>
        )}

        {step === Step.CONFIRM && (
          <Box flexDirection="column">
            <Box flexDirection="column" marginBottom={1}>
              <Text>
                <Text color={Colors.AccentCyan} bold>
                  {uiTexts.labelLanguage}
                </Text>
                <Text> {chosenLanguage}</Text>
              </Text>
              <Text>
                <Text color={Colors.AccentCyan} bold>
                  {uiTexts.labelTopic}
                </Text>
                <Text>{topic}</Text>
              </Text>
              <Text>
                <Text color={Colors.AccentCyan} bold>
                  {uiTexts.labelModels}
                </Text>
                <Text>{chosenModels.join(' → ')}</Text>
              </Text>
              <Text>
                <Text color={Colors.AccentCyan} bold>
                  {uiTexts.labelRounds}
                </Text>
                <Text>{chosenRounds}</Text>
              </Text>
              <Text>
                <Text color={Colors.AccentCyan} bold>
                  {uiTexts.labelTotalTurns}
                </Text>
                <Text>{chosenModels.length * chosenRounds}</Text>
              </Text>
            </Box>
            <RadioButtonSelect
              items={confirmItems}
              initialIndex={0}
              onSelect={handleConfirm}
              onHighlight={() => {}}
              isFocused
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
