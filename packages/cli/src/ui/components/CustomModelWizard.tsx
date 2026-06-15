/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { Colors } from '../colors.js';
import { SimpleTextInput } from './shared/SimpleTextInput.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { SelectMulti } from './shared/SelectMulti.js';
import { useKeypress, Key } from '../hooks/useKeypress.js';
import {
  CustomModelConfig,
  CustomModelProvider,
  validateCustomModelConfig,
  buildEasyRouterModelConfig,
  EASY_ROUTER_BASE_URL,
  EASY_ROUTER_DEFAULT_MAX_TOKENS,
  classifyEasyRouterModel,
  type EasyRouterModelEntry,
  type EasyClawModelMetadata,
} from 'otto-core';
import {
  fetchEasyRouterModels,
  EasyRouterFetchError,
} from '../../config/easyRouterClient.js';
import { fetchEasyClawMetadata } from '../../config/easyClawMetadataClient.js';
import { t } from '../utils/i18n.js';

interface CustomModelWizardProps {
  /**
   * Called when the user finishes the wizard with one or more model configs.
   * The hook layer is responsible for persisting them.
   */
  onComplete: (configs: CustomModelConfig | CustomModelConfig[]) => void;
  onCancel: () => void;
}

/**
 * "Manual" wizard step set (the original flow, unchanged).
 */
enum ManualStep {
  PROVIDER = 'provider',
  DISPLAY_NAME = 'displayName',
  BASE_URL = 'baseUrl',
  API_KEY = 'apiKey',
  MODEL_ID = 'modelId',
  MAX_TOKENS = 'maxTokens',
  CONFIRM = 'confirm',
}

/**
 * EasyRouter step set — the user only enters an API key, picks models from
 * the live list, and confirms.
 */
enum EasyRouterStep {
  PROVIDER = 'provider', // shared first step with manual flow
  API_KEY = 'er_apiKey',
  FETCHING = 'er_fetching',
  SELECT_MODELS = 'er_selectModels',
  CONFIRM = 'er_confirm',
}

type WizardStep = ManualStep | EasyRouterStep;

/**
 * Special provider value for the EasyRouter shortcut. We don't store
 * `easy-router` in CustomModelConfig — we expand it into a list of real
 * configs whose provider is one of openai / openai-responses / anthropic.
 */
const EASY_ROUTER_PROVIDER_VALUE = 'easy-router' as const;

type ProviderOptionValue = CustomModelProvider | typeof EASY_ROUTER_PROVIDER_VALUE;

/**
 * Render a token count as a compact human-readable string ("1M" / "200K" / "8192").
 * Used in the EasyRouter wizard's model picker to surface metadata at a glance.
 */
function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '?';
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m >= 10 ? Math.round(m) : Number(m.toFixed(1))}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${k >= 100 ? Math.round(k) : Number(k.toFixed(0))}K`;
  }
  return String(tokens);
}

// 供应商选项。带 baseUrl 的是"品牌预设":选中即自动补好接口地址与协议，
// 直接跳到填 API Key（省去手输一长串 base URL）。不带 baseUrl 的走手动填写。
const PROVIDER_OPTIONS: Array<{
  value: string;
  label: string;
  description: string;
  /** 实际写入配置的协议；EasyRouter 自动探测，无需此项。 */
  protocol?: CustomModelProvider;
  /** 预设接口地址；有则自动补、跳过手输 base URL。 */
  baseUrl?: string;
}> = [
  {
    value: EASY_ROUTER_PROVIDER_VALUE,
    label: 'EasyRouter（推荐，贴 key 自动出模型列表）',
    description:
      'Otto 自带路由：只贴 API key，自动探测 base URL/协议并列出可选模型。官网：https://ezr.sh/',
  },
  {
    value: 'glm',
    label: '智谱 GLM',
    description: 'glm-4.6 / glm-4-plus 等，OpenAI 兼容（已自动填好接口地址）',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  },
  {
    value: 'deepseek',
    label: 'DeepSeek 深度求索',
    description: 'deepseek-chat / deepseek-reasoner（已自动填好接口地址）',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
  },
  {
    value: 'moonshot',
    label: 'Moonshot Kimi',
    description: 'Kimi 系列，OpenAI 兼容（已自动填好接口地址）',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
  },
  {
    value: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    description: 'DeepSeek / Qwen 等 200+ 模型聚合（已自动填好接口地址）',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
  },
  {
    value: 'openai-official',
    label: 'OpenAI 官方',
    description: 'gpt-4o / gpt-5 等（已自动填好接口地址）',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter（多家聚合）',
    description: '一个 key 访问多家模型（已自动填好接口地址）',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    value: 'openai-compat',
    label: 'OpenAI 兼容（自定义接口地址）',
    description: '任意 OpenAI 兼容服务：Azure / Ollama / LM Studio / vLLM 等，手动填 base URL',
    protocol: 'openai',
  },
  {
    value: 'openai-responses',
    label: 'OpenAI Responses API（自定义）',
    description: 'POST /responses（Codex / gpt-5.x），手动填 base URL',
    protocol: 'openai-responses',
  },
  {
    value: 'anthropic',
    label: 'Anthropic Claude（自定义）',
    description: 'Claude API，手动填 base URL',
    protocol: 'anthropic',
  },
  {
    value: 'gemini',
    label: 'Google Gemini（自定义）',
    description: '原生 GenAI API，手动填 base URL',
    protocol: 'gemini',
  },
];

const isManualStep = (step: WizardStep): step is ManualStep =>
  Object.values(ManualStep).includes(step as ManualStep);

export function CustomModelWizard({ onComplete, onCancel }: CustomModelWizardProps): React.JSX.Element {
  const [currentStep, setCurrentStep] = useState<WizardStep>(ManualStep.PROVIDER);
  const [selectedProviderIndex, setSelectedProviderIndex] = useState(0);
  const [config, setConfig] = useState<Partial<CustomModelConfig>>({
    enabled: true,
  });
  const [inputValue, setInputValue] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  // ---- EasyRouter-specific state -----------------------------------------
  const [easyRouterApiKey, setEasyRouterApiKey] = useState('');
  const [easyRouterModels, setEasyRouterModels] = useState<EasyRouterModelEntry[]>([]);
  const [easyRouterFetchError, setEasyRouterFetchError] = useState<string | null>(null);
  const [easyRouterSelected, setEasyRouterSelected] = useState<string[]>([]);
  /**
   * Optional `model_id → EasyClaw metadata` cache, populated alongside the
   * EasyRouter models list. Missing entries simply fall back to
   * {@link EASY_ROUTER_DEFAULT_MAX_TOKENS} (200K) when persisted.
   */
  const [easyRouterMetadata, setEasyRouterMetadata] = useState<
    Map<string, EasyClawModelMetadata>
  >(new Map());

  // 处理提供商选择
  const handleProviderKeypress = useCallback((key: Key) => {
    if (key.name === 'up' || key.sequence === 'k') {
      setSelectedProviderIndex(prev =>
        prev > 0 ? prev - 1 : PROVIDER_OPTIONS.length - 1
      );
    } else if (key.name === 'down' || key.sequence === 'j') {
      setSelectedProviderIndex(prev =>
        prev < PROVIDER_OPTIONS.length - 1 ? prev + 1 : 0
      );
    } else if (key.name === 'return') {
      const opt = PROVIDER_OPTIONS[selectedProviderIndex];
      if (opt.value === EASY_ROUTER_PROVIDER_VALUE) {
        // Pre-fill baseUrl so confirmation/preview still has something useful.
        setConfig((prev) => ({ ...prev, baseUrl: EASY_ROUTER_BASE_URL }));
        setCurrentStep(EasyRouterStep.API_KEY);
      } else if (opt.baseUrl) {
        // 品牌预设：自动补好接口地址与协议，跳过手输 base URL 与命名，直接填 key。
        // displayName 留空，到 MODEL_ID 步自动用模型名填充（避免同供应商多模型重名）。
        setConfig(prev => ({
          ...prev,
          provider: opt.protocol!,
          baseUrl: opt.baseUrl!,
          displayName: '',
        }));
        setCurrentStep(ManualStep.API_KEY);
      } else {
        // 自定义/手动：走原流程（先命名，再手输 base URL）。
        setConfig(prev => ({ ...prev, provider: opt.protocol! }));
        setCurrentStep(ManualStep.DISPLAY_NAME);
      }
      setInputValue('');
      setValidationError(null);
    } else if (key.name === 'escape') {
      onCancel();
    }
  }, [selectedProviderIndex, onCancel]);

  useKeypress(handleProviderKeypress, { isActive: currentStep === ManualStep.PROVIDER });

  // 处理确认步骤的选择
  const handleConfirmSelect = useCallback((value: string) => {
    if (value === 'save') {
      const fullConfig: CustomModelConfig = {
        displayName: config.displayName!,
        provider: config.provider!,
        baseUrl: config.baseUrl!,
        apiKey: config.apiKey!,
        modelId: config.modelId!,
        maxTokens: config.maxTokens,
        enabled: true,
      };

      const errors = validateCustomModelConfig(fullConfig);
      if (errors.length > 0) {
        setValidationError(errors.join(', '));
        return;
      }

      onComplete(fullConfig);
    } else {
      onCancel();
    }
  }, [config, onComplete, onCancel]);

  // 确认步骤的菜单选项
  const confirmMenuItems = [
    { label: '✓ Save configuration', value: 'save' },
    { label: '✗ Cancel', value: 'cancel' },
  ];

  const handleInputSubmit = useCallback((value: string) => {
    const trimmedValue = value.trim();

    switch (currentStep) {
      case ManualStep.DISPLAY_NAME:
        if (!trimmedValue) {
          setValidationError('Display name cannot be empty');
          return;
        }
        setConfig(prev => ({ ...prev, displayName: trimmedValue }));
        setInputValue('');
        setValidationError(null);
        setCurrentStep(ManualStep.BASE_URL);
        break;

      case ManualStep.BASE_URL:
        if (!trimmedValue) {
          setValidationError('Base URL cannot be empty');
          return;
        }
        if (!trimmedValue.startsWith('http://') && !trimmedValue.startsWith('https://')) {
          setValidationError('Base URL must start with http:// or https://');
          return;
        }
        setConfig(prev => ({ ...prev, baseUrl: trimmedValue.replace(/\/+$/, '') }));
        setInputValue('');
        setValidationError(null);
        setCurrentStep(ManualStep.API_KEY);
        break;

      case ManualStep.API_KEY:
        if (!trimmedValue) {
          setValidationError('API key cannot be empty');
          return;
        }
        setConfig(prev => ({ ...prev, apiKey: trimmedValue }));
        setInputValue('');
        setValidationError(null);
        setCurrentStep(ManualStep.MODEL_ID);
        break;

      case ManualStep.MODEL_ID:
        if (!trimmedValue) {
          setValidationError('Model ID cannot be empty');
          return;
        }
        // 预设供应商跳过了命名步骤：displayName 为空时用模型名自动填充。
        setConfig(prev => ({
          ...prev,
          modelId: trimmedValue,
          displayName: prev.displayName && prev.displayName.trim() ? prev.displayName : trimmedValue,
        }));
        setInputValue('');
        setValidationError(null);
        setCurrentStep(ManualStep.MAX_TOKENS);
        break;

      case ManualStep.MAX_TOKENS:
        if (trimmedValue) {
          const maxTokens = parseInt(trimmedValue, 10);
          if (isNaN(maxTokens) || maxTokens <= 0) {
            setValidationError('Max tokens must be a positive number');
            return;
          }
          setConfig(prev => ({ ...prev, maxTokens }));
        }
        setInputValue('');
        setValidationError(null);
        setCurrentStep(ManualStep.CONFIRM);
        break;

      case EasyRouterStep.API_KEY:
        if (!trimmedValue) {
          setValidationError('API key cannot be empty');
          return;
        }
        setEasyRouterApiKey(trimmedValue);
        setInputValue('');
        setValidationError(null);
        setEasyRouterFetchError(null);
        setCurrentStep(EasyRouterStep.FETCHING);
        break;
    }
  }, [currentStep]);

  // ---- EasyRouter: trigger fetch when entering FETCHING step --------------
  useEffect(() => {
    if (currentStep !== EasyRouterStep.FETCHING) return;
    let cancelled = false;
    (async () => {
      try {
        // Fetch the auth-gated EasyRouter list AND the public EasyClaw
        // metadata catalogue in parallel. Metadata is best-effort; failures
        // are swallowed inside fetchEasyClawMetadata (returns an empty Map),
        // so we only need to handle EasyRouter errors here.
        const [list, metadata] = await Promise.all([
          fetchEasyRouterModels(easyRouterApiKey),
          fetchEasyClawMetadata(),
        ]);
        if (cancelled) return;
        setEasyRouterModels(list);
        setEasyRouterMetadata(metadata);
        if (list.length === 0) {
          setEasyRouterFetchError(
            'EasyRouter returned no usable models for this API key.',
          );
          // Stay on the fetching screen so the user sees the error and can press Esc.
        } else {
          // Default-select all models for convenience.
          setEasyRouterSelected(list.map((m) => m.id));
          setCurrentStep(EasyRouterStep.SELECT_MODELS);
        }
      } catch (e) {
        if (cancelled) return;
        const message =
          e instanceof EasyRouterFetchError
            ? `${e.message}${e.status ? ` (HTTP ${e.status})` : ''}`
            : e instanceof Error
              ? e.message
              : String(e);
        setEasyRouterFetchError(message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentStep, easyRouterApiKey]);

  // ---- EasyRouter: SELECT_MODELS handlers --------------------------------
  const handleEasyRouterSubmit = useCallback(
    (selectedIds: string[]) => {
      if (selectedIds.length === 0) {
        setValidationError('Please select at least one model.');
        return;
      }
      setValidationError(null);
      setEasyRouterSelected(selectedIds);
      setCurrentStep(EasyRouterStep.CONFIRM);
    },
    [],
  );

  // ---- EasyRouter: CONFIRM action ----------------------------------------
  const handleEasyRouterConfirm = useCallback(
    (value: string) => {
      if (value !== 'save') {
        onCancel();
        return;
      }
      const configs: CustomModelConfig[] = easyRouterSelected.map((id) =>
        buildEasyRouterModelConfig(id, easyRouterApiKey, {
          displayName: id,
          metadata: easyRouterMetadata.get(id),
        }),
      );
      // Sanity check — every config must validate.
      for (const cfg of configs) {
        const errors = validateCustomModelConfig(cfg);
        if (errors.length > 0) {
          setValidationError(
            `Internal error generating config for "${cfg.modelId}": ${errors.join(
              ', ',
            )}`,
          );
          return;
        }
      }
      onComplete(configs);
    },
    [easyRouterApiKey, easyRouterSelected, easyRouterMetadata, onComplete, onCancel],
  );

  // ---- Allow Esc to cancel during FETCHING (otherwise the user is stuck) --
  const handleFetchingKeypress = useCallback(
    (key: Key) => {
      if (key.name === 'escape') onCancel();
    },
    [onCancel],
  );
  useKeypress(handleFetchingKeypress, {
    isActive: currentStep === EasyRouterStep.FETCHING,
  });

  const getStepTitle = (step: WizardStep): string => {
    switch (step) {
      case ManualStep.PROVIDER:
        return 'Select Provider Type';
      case ManualStep.DISPLAY_NAME:
        return 'Enter Display Name';
      case ManualStep.BASE_URL:
        return 'Enter API Base URL';
      case ManualStep.API_KEY:
        return 'Enter API Key';
      case ManualStep.MODEL_ID:
        return 'Enter Model Name';
      case ManualStep.MAX_TOKENS:
        return 'Enter Max Tokens (Optional)';
      case ManualStep.CONFIRM:
        return 'Confirm Configuration';
      case EasyRouterStep.API_KEY:
        return 'Enter EasyRouter API Key';
      case EasyRouterStep.FETCHING:
        return 'Loading available models…';
      case EasyRouterStep.SELECT_MODELS:
        return 'Select Models to Add';
      case EasyRouterStep.CONFIRM:
        return 'Confirm EasyRouter Models';
      default:
        return '';
    }
  };

  const getStepDescription = (step: WizardStep): string => {
    switch (step) {
      case ManualStep.PROVIDER:
        return 'Choose the API format for your custom model';
      case ManualStep.DISPLAY_NAME:
        return 'This name will appear in the model selection dialog (also used as unique identifier)';
      case ManualStep.BASE_URL:
        return 'API endpoint base URL (e.g., https://api.openai.com/v1)';
      case ManualStep.API_KEY:
        return 'Your API key (or use ${ENV_VAR} for environment variable)';
      case ManualStep.MODEL_ID:
        return 'The model name to use with the API (e.g., gpt-4-turbo)';
      case ManualStep.MAX_TOKENS:
        return 'Maximum context window size (press Enter to skip)';
      case ManualStep.CONFIRM:
        return 'Review your configuration and confirm';
      case EasyRouterStep.API_KEY:
        return `Paste your EasyRouter key. Base URL is fixed at ${EASY_ROUTER_BASE_URL}.`;
      case EasyRouterStep.FETCHING:
        return 'Fetching the live model catalog from EasyRouter and filtering out image / embedding / video models.';
      case EasyRouterStep.SELECT_MODELS:
        return 'Use ↑/↓ to move, Space to toggle, Enter to confirm. All models are selected by default.';
      case EasyRouterStep.CONFIRM:
        return `These ${easyRouterSelected.length} model(s) will be saved with the appropriate protocol auto-detected.`;
      default:
        return '';
    }
  };

  const getStepExample = (step: WizardStep): string | null => {
    switch (step) {
      case ManualStep.DISPLAY_NAME:
        return 'Example: My GPT-4 Turbo';
      case ManualStep.BASE_URL:
        if (config.provider === 'openai') return 'Example: https://api.openai.com/v1';
        if (config.provider === 'openai-responses') return 'Example: https://api.openai.com/v1';
        if (config.provider === 'anthropic') return 'Example: https://api.anthropic.com';
        if (config.provider === 'gemini') return 'Example: https://generativelanguage.googleapis.com/v1beta';
        return 'Example: http://localhost:1234/v1';
      case ManualStep.API_KEY:
        return 'Example: ${OPENAI_API_KEY} or sk-...';
      case ManualStep.MODEL_ID:
        if (config.provider === 'openai') return 'Example: gpt-4-turbo';
        if (config.provider === 'openai-responses') return 'Example: gpt-4o, o3';
        if (config.provider === 'anthropic') return 'Example: claude-sonnet-4-5';
        if (config.provider === 'gemini') return 'Example: gemini-2.5-pro, gemini-3.5-flash';
        return 'Example: llama-3-70b';
      case ManualStep.MAX_TOKENS:
        return 'Example: 128000';
      case EasyRouterStep.API_KEY:
        return 'Example: sk-... (the key you got from EasyRouter)';
      default:
        return null;
    }
  };

  const renderProviderSelection = () => (
    <Box flexDirection="column">
      {PROVIDER_OPTIONS.map((option, index) => {
        const isSelected = index === selectedProviderIndex;
        // 紧凑列表：每项一行（标记 + 名称）；仅选中项展开一行描述，避免长列表撑屏。
        return (
          <Box key={option.value} flexDirection="column">
            <Box>
              <Box width={2}>
                <Text color={isSelected ? Colors.AccentGreen : Colors.Gray}>
                  {isSelected ? '▶' : ' '}
                </Text>
              </Box>
              <Text color={isSelected ? Colors.AccentGreen : Colors.Foreground} bold={isSelected}>
                {option.label}
              </Text>
            </Box>
            {isSelected && (
              <Box marginLeft={2}>
                <Text color={Colors.Gray}>{option.description}</Text>
              </Box>
            )}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          ↑/↓ 或 k/j 选择，Enter 确认，Esc 取消
        </Text>
      </Box>
    </Box>
  );

  // Handle Escape key for text input steps
  const handleTextInputCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  // Determine if we're in a text input step
  const isTextInputStep =
    currentStep === ManualStep.DISPLAY_NAME ||
    currentStep === ManualStep.BASE_URL ||
    currentStep === ManualStep.API_KEY ||
    currentStep === ManualStep.MODEL_ID ||
    currentStep === ManualStep.MAX_TOKENS ||
    currentStep === EasyRouterStep.API_KEY;

  const renderTextInput = () => {
    const example = getStepExample(currentStep);
    const isApiKeyStep =
      currentStep === ManualStep.API_KEY || currentStep === EasyRouterStep.API_KEY;
    return (
      <Box flexDirection="column">
        <SimpleTextInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleInputSubmit}
          onCancel={handleTextInputCancel}
          isActive={isTextInputStep}
          mask={isApiKeyStep ? '*' : undefined}
        />
        {example && (
          <Box marginTop={1}>
            <Text color={Colors.Gray}>
              {example}
            </Text>
          </Box>
        )}
        {validationError && (
          <Box marginTop={1}>
            <Text color={Colors.AccentRed}>✗ {validationError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={Colors.Gray}>
            {isApiKeyStep
              ? 'Enter 确认 · Esc 取消 · Ctrl+V 从剪贴板粘贴（⌘V 粘不进时用它）'
              : 'Enter 确认 · Esc 取消 · Ctrl+V 从剪贴板粘贴'}
          </Text>
        </Box>
      </Box>
    );
  };

  const renderConfirmation = () => (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={Colors.AccentYellow} bold>
          Please review your configuration:
        </Text>
      </Box>

      <Box marginLeft={2} flexDirection="column">
        <Text>
          <Text color={Colors.AccentCyan} bold>Provider:     </Text>
          <Text>{PROVIDER_OPTIONS.find(p => p.value === config.provider)?.label}</Text>
        </Text>
        <Text>
          <Text color={Colors.AccentCyan} bold>Display Name: </Text>
          <Text>{config.displayName}</Text>
        </Text>
        <Text>
          <Text color={Colors.AccentCyan} bold>Base URL:     </Text>
          <Text>{config.baseUrl}</Text>
        </Text>
        <Text>
          <Text color={Colors.AccentCyan} bold>API Key:      </Text>
          <Text>{config.apiKey?.includes('${') ? config.apiKey : '***' + config.apiKey?.slice(-4)}</Text>
        </Text>
        <Text>
          <Text color={Colors.AccentCyan} bold>Model ID:     </Text>
          <Text>{config.modelId}</Text>
        </Text>
        {config.maxTokens && (
          <Text>
            <Text color={Colors.AccentCyan} bold>Max Tokens:   </Text>
            <Text>{config.maxTokens}</Text>
          </Text>
        )}
      </Box>

      {validationError && (
        <Box marginTop={1}>
          <Text color={Colors.AccentRed}>✗ Validation Error: {validationError}</Text>
        </Box>
      )}

      <Box marginTop={2}>
        <RadioButtonSelect
          items={confirmMenuItems}
          initialIndex={0}
          onSelect={handleConfirmSelect}
          onHighlight={() => {}}
          isFocused={currentStep === ManualStep.CONFIRM}
        />
      </Box>
    </Box>
  );

  // ---- EasyRouter renders -------------------------------------------------
  const renderEasyRouterFetching = () => (
    <Box flexDirection="column">
      {!easyRouterFetchError ? (
        <Box>
          <Text color={Colors.AccentCyan}>
            <Spinner type="dots" />
          </Text>
          <Text> Talking to {EASY_ROUTER_BASE_URL}/models …</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text color={Colors.AccentRed}>✗ {easyRouterFetchError}</Text>
          <Box marginTop={1}>
            <Text color={Colors.Gray}>Press Esc to cancel and try again.</Text>
          </Box>
        </Box>
      )}
    </Box>
  );

  const renderEasyRouterSelectModels = () => {
    const items = easyRouterModels.map((m) => {
      const proto = classifyEasyRouterModel(m.id);
      const protoLabel =
        proto === 'openai-responses'
          ? 'Responses'
          : proto === 'anthropic'
            ? 'Anthropic'
            : proto === 'gemini'
              ? 'Gemini'
              : 'OpenAI';
      const meta = easyRouterMetadata.get(m.id);
      const ctx =
        typeof meta?.max_context_length === 'number' && meta.max_context_length > 0
          ? formatTokenCount(meta.max_context_length)
          : undefined;
      const description = ctx
        ? `${protoLabel} · ${ctx} ctx`
        : `${protoLabel} · ${formatTokenCount(EASY_ROUTER_DEFAULT_MAX_TOKENS)} ctx (default)`;
      return {
        label: m.id,
        value: m.id,
        description,
      };
    });
    const matched = easyRouterModels.filter((m) =>
      easyRouterMetadata.has(m.id),
    ).length;
    return (
      <Box flexDirection="column">
        <SelectMulti
          items={items}
          defaultValues={easyRouterSelected}
          onChange={setEasyRouterSelected}
          onSubmit={handleEasyRouterSubmit}
          onCancel={onCancel}
          isFocused={currentStep === EasyRouterStep.SELECT_MODELS}
          showNumbers
        />
        {validationError && (
          <Box marginTop={1}>
            <Text color={Colors.AccentRed}>✗ {validationError}</Text>
          </Box>
        )}
        <Box marginTop={1} flexDirection="column">
          <Text color={Colors.Gray}>
            Selected: {easyRouterSelected.length} / {easyRouterModels.length}.
            Space toggles, Enter confirms, Esc cancels.
          </Text>
          <Text color={Colors.Gray}>
            Metadata: {matched}/{easyRouterModels.length} matched (others use{' '}
            {formatTokenCount(EASY_ROUTER_DEFAULT_MAX_TOKENS)} default).
          </Text>
        </Box>
      </Box>
    );
  };

  const renderEasyRouterConfirm = () => {
    // Group selected models by detected protocol for a compact preview.
    const grouped = easyRouterSelected.reduce<Record<CustomModelProvider, string[]>>(
      (acc, id) => {
        const proto = classifyEasyRouterModel(id);
        (acc[proto] ||= []).push(id);
        return acc;
      },
      { openai: [], 'openai-responses': [], anthropic: [], gemini: [] } as Record<
        CustomModelProvider,
        string[]
      >,
    );
    const protoLabel: Record<CustomModelProvider, string> = {
      openai: 'OpenAI Chat Completions',
      'openai-responses': 'OpenAI Responses (/responses)',
      anthropic: 'Anthropic Messages',
      gemini: 'Gemini',
    };
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color={Colors.AccentYellow} bold>
            About to add {easyRouterSelected.length} EasyRouter model(s):
          </Text>
        </Box>
        <Box marginLeft={2} flexDirection="column">
          <Text>
            <Text color={Colors.AccentCyan} bold>Base URL:     </Text>
            <Text>{EASY_ROUTER_BASE_URL}</Text>
          </Text>
          <Text>
            <Text color={Colors.AccentCyan} bold>API Key:      </Text>
            <Text>***{easyRouterApiKey.slice(-4)}</Text>
          </Text>
          {(Object.keys(grouped) as CustomModelProvider[]).map((p) => {
            const list = grouped[p];
            if (!list || list.length === 0) return null;
            return (
              <Box key={p} marginTop={1} flexDirection="column">
                <Text color={Colors.AccentCyan} bold>
                  {protoLabel[p]} ({list.length})
                </Text>
                {list.map((id) => {
                  const meta = easyRouterMetadata.get(id);
                  const ctxTokens =
                    typeof meta?.max_context_length === 'number' &&
                    meta.max_context_length > 0
                      ? meta.max_context_length
                      : EASY_ROUTER_DEFAULT_MAX_TOKENS;
                  const isDefault = !easyRouterMetadata.has(id);
                  return (
                    <Text key={id} color={Colors.Foreground}>
                      {'  • '}
                      {id}{' '}
                      <Text color={Colors.Gray}>
                        ({formatTokenCount(ctxTokens)}
                        {isDefault ? ' default' : ''})
                      </Text>
                    </Text>
                  );
                })}
              </Box>
            );
          })}
        </Box>
        {validationError && (
          <Box marginTop={1}>
            <Text color={Colors.AccentRed}>✗ {validationError}</Text>
          </Box>
        )}
        <Box marginTop={2}>
          <RadioButtonSelect
            items={confirmMenuItems}
            initialIndex={0}
            onSelect={handleEasyRouterConfirm}
            onHighlight={() => {}}
            isFocused={currentStep === EasyRouterStep.CONFIRM}
          />
        </Box>
      </Box>
    );
  };

  const isEasyRouterFlow =
    currentStep === EasyRouterStep.API_KEY ||
    currentStep === EasyRouterStep.FETCHING ||
    currentStep === EasyRouterStep.SELECT_MODELS ||
    currentStep === EasyRouterStep.CONFIRM;

  // Step counter:
  //   manual: 7 steps (provider, displayName, baseUrl, apiKey, modelId, maxTokens, confirm)
  //   easy-router: 4 steps (provider, apiKey, fetch+select, confirm) — collapse fetch+select into one for the user's mental model.
  let stepNumber = 1;
  let totalSteps = 7;
  if (isManualStep(currentStep)) {
    stepNumber = Object.values(ManualStep).indexOf(currentStep) + 1;
    totalSteps = Object.values(ManualStep).length;
  } else if (isEasyRouterFlow) {
    totalSteps = 4;
    if (currentStep === EasyRouterStep.API_KEY) stepNumber = 2;
    else if (
      currentStep === EasyRouterStep.FETCHING ||
      currentStep === EasyRouterStep.SELECT_MODELS
    )
      stepNumber = 3;
    else if (currentStep === EasyRouterStep.CONFIRM) stepNumber = 4;
  }

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
      {/* Header */}
      <Box marginBottom={1}>
        <Text color={Colors.AccentCyan} bold>
          ✨ Custom Model Configuration Wizard
        </Text>
      </Box>

      {/* Progress */}
      <Box marginBottom={1}>
        <Text color={Colors.Gray}>
          Step {stepNumber}/{totalSteps}: {getStepTitle(currentStep)}
        </Text>
      </Box>

      {/* Description */}
      <Box marginBottom={1}>
        <Text color={Colors.Comment}>
          {getStepDescription(currentStep)}
        </Text>
      </Box>

      <Box borderStyle="single" borderColor={Colors.Gray} paddingX={1} paddingY={1}>
        {currentStep === ManualStep.PROVIDER && renderProviderSelection()}
        {isTextInputStep && renderTextInput()}
        {currentStep === ManualStep.CONFIRM && renderConfirmation()}
        {currentStep === EasyRouterStep.FETCHING && renderEasyRouterFetching()}
        {currentStep === EasyRouterStep.SELECT_MODELS && renderEasyRouterSelectModels()}
        {currentStep === EasyRouterStep.CONFIRM && renderEasyRouterConfirm()}
      </Box>
    </Box>
  );
}
