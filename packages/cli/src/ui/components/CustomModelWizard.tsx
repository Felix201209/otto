/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box,Text } from 'ink';
import Spinner from 'ink-spinner';
import {
buildEasyRouterModelConfig,
classifyEasyRouterModel,
CustomModelConfig,
CustomModelProvider,
EASY_ROUTER_BASE_URL,
EASY_ROUTER_DEFAULT_MAX_TOKENS,
validateCustomModelConfig,
type EasyClawModelMetadata,
type EasyRouterModelEntry,
} from 'otto-core';
import React,{ useCallback,useEffect,useState } from 'react';
import { fetchEasyClawMetadata } from '../../config/easyClawMetadataClient.js';
import {
EasyRouterFetchError,
fetchEasyRouterModels,
} from '../../config/easyRouterClient.js';
import {
findProvider,
loadModelsDevCatalog,
type CatalogModel,
} from '../../config/modelsDevCatalog.js';
import { Colors } from '../colors.js';
import { Key,useKeypress } from '../hooks/useKeypress.js';
import { isChineseLocale } from '../utils/i18n.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { SelectMulti } from './shared/SelectMulti.js';
import { SimpleTextInput } from './shared/SimpleTextInput.js';

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
  PROVIDER_SEARCH = 'providerSearch', // 可搜索的全量供应商选择器（models.dev 121 家）
  DISPLAY_NAME = 'displayName',
  BASE_URL = 'baseUrl',
  API_KEY = 'apiKey',
  MODEL_SELECT = 'modelSelect', // 品牌预设：输完 key 后从 models.dev 拉模型列表交互选择
  MODEL_ID = 'modelId',
  MAX_TOKENS = 'maxTokens',
  CONFIRM = 'confirm',
}

/** 模型选择列表里"手动输入模型名"的哨兵值。 */
const MANUAL_MODEL_ENTRY = '__manual__';

/** 供应商菜单里"浏览全部供应商（可搜索）"的哨兵值。 */
const BROWSE_ALL_PROVIDERS = '__browse_all__';

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

type _ProviderOptionValue = CustomModelProvider | typeof EASY_ROUTER_PROVIDER_VALUE;

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
  /** models.dev 供应商 id；有则输完 key 后从 models.dev 拉模型列表交互选择。 */
  modelsDevId?: string;
}> = [
  {
    value: EASY_ROUTER_PROVIDER_VALUE,
    label: isChineseLocale()
      ? 'EasyRouter（推荐，贴 key 自动出模型列表）'
      : 'EasyRouter (recommended — paste key, get model list)',
    description: isChineseLocale()
      ? 'Otto 自带路由：只贴 API key，自动探测 base URL/协议并列出可选模型。官网：https://ezr.sh/'
      : "Otto's built-in router: just paste an API key — it auto-detects the base URL/protocol and lists available models. Site: https://ezr.sh/",
  },
  {
    value: BROWSE_ALL_PROVIDERS,
    label: isChineseLocale()
      ? '🌐 全部供应商（可搜索，models.dev 121 家）'
      : '🌐 All providers (searchable, 121 from models.dev)',
    description: isChineseLocale()
      ? '输入关键字筛选，从全部供应商里挑——接口地址自动补好，再从该供应商的模型清单里选。'
      : 'Type to filter and pick from every provider — the base URL is auto-filled, then choose from that provider’s model list.',
  },
  {
    value: 'glm',
    label: isChineseLocale() ? '智谱 GLM' : 'Zhipu GLM',
    description: isChineseLocale()
      ? 'glm-5.1 / glm-4.6 等，OpenAI 兼容（自动填接口地址 + 拉模型列表）'
      : 'glm-5.1 / glm-4.6 etc., OpenAI-compatible (auto base URL + model list)',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelsDevId: 'zhipuai',
  },
  {
    value: 'deepseek',
    label: isChineseLocale() ? 'DeepSeek 深度求索' : 'DeepSeek',
    description: isChineseLocale()
      ? 'deepseek-chat / deepseek-reasoner（自动填接口地址 + 拉模型列表）'
      : 'deepseek-chat / deepseek-reasoner (auto base URL + model list)',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    modelsDevId: 'deepseek',
  },
  {
    value: 'moonshot',
    label: 'Moonshot Kimi',
    description: isChineseLocale()
      ? 'Kimi 系列，OpenAI 兼容（自动填接口地址 + 拉模型列表）'
      : 'Kimi family, OpenAI-compatible (auto base URL + model list)',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    modelsDevId: 'moonshotai',
  },
  {
    value: 'siliconflow',
    label: isChineseLocale() ? '硅基流动 SiliconFlow' : 'SiliconFlow',
    description: isChineseLocale()
      ? 'DeepSeek / Qwen 等聚合（自动填接口地址 + 拉模型列表）'
      : 'Aggregates DeepSeek / Qwen etc. (auto base URL + model list)',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    modelsDevId: 'siliconflow',
  },
  {
    value: 'openai-official',
    label: isChineseLocale() ? 'OpenAI 官方' : 'OpenAI (official)',
    description: isChineseLocale()
      ? 'gpt-4o / gpt-5 等（已自动填好接口地址）'
      : 'gpt-4o / gpt-5 etc. (base URL pre-filled)',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    modelsDevId: 'openai',
  },
  {
    value: 'openrouter',
    label: isChineseLocale() ? 'OpenRouter（多家聚合）' : 'OpenRouter (multi-provider)',
    description: isChineseLocale()
      ? '一个 key 访问多家模型（自动填接口地址 + 拉模型列表）'
      : 'One key, many providers (auto base URL + model list)',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelsDevId: 'openrouter',
  },
  {
    value: 'openai-compat',
    label: isChineseLocale()
      ? 'OpenAI 兼容（自定义接口地址）'
      : 'OpenAI-compatible (custom base URL)',
    description: isChineseLocale()
      ? '任意 OpenAI 兼容服务：Azure / Ollama / LM Studio / vLLM 等，手动填 base URL'
      : 'Any OpenAI-compatible service: Azure / Ollama / LM Studio / vLLM etc. — enter base URL manually',
    protocol: 'openai',
  },
  {
    value: 'openai-responses',
    label: isChineseLocale()
      ? 'OpenAI Responses API（自定义）'
      : 'OpenAI Responses API (custom)',
    description: isChineseLocale()
      ? 'POST /responses（Codex / gpt-5.x），手动填 base URL'
      : 'POST /responses (Codex / gpt-5.x) — enter base URL manually',
    protocol: 'openai-responses',
  },
  {
    value: 'anthropic',
    label: isChineseLocale() ? 'Anthropic Claude（自定义）' : 'Anthropic Claude (custom)',
    description: isChineseLocale()
      ? 'Claude API，手动填 base URL'
      : 'Claude API — enter base URL manually',
    protocol: 'anthropic',
  },
  {
    value: 'gemini',
    label: isChineseLocale() ? 'Google Gemini（自定义）' : 'Google Gemini (custom)',
    description: isChineseLocale()
      ? '原生 GenAI API，手动填 base URL'
      : 'Native GenAI API — enter base URL manually',
    protocol: 'gemini',
  },
];

const isManualStep = (step: WizardStep): step is ManualStep =>
  Object.values(ManualStep).includes(step as ManualStep);

/** 按关键字筛选供应商（id / 名称，大小写不敏感）。空查询返回全部。 */
function filterProviders<T extends { id: string; name: string }>(
  all: T[],
  query: string,
): T[] {
  const s = query.trim().toLowerCase();
  if (!s) return all;
  return all.filter(
    (p) => p.id.toLowerCase().includes(s) || p.name.toLowerCase().includes(s),
  );
}

export function CustomModelWizard({ onComplete, onCancel }: CustomModelWizardProps): React.JSX.Element {
  const [currentStep, setCurrentStep] = useState<WizardStep>(ManualStep.PROVIDER);
  const [selectedProviderIndex, setSelectedProviderIndex] = useState(0);
  const [config, setConfig] = useState<Partial<CustomModelConfig>>({
    enabled: true,
  });
  const [inputValue, setInputValue] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  // ---- models.dev 模型选择相关状态 ---------------------------------------
  /** 选中品牌预设时记下其 models.dev id；为空表示该预设不走模型选择列表。 */
  const [selectedModelsDevId, setSelectedModelsDevId] = useState<string | null>(null);
  const [catalogModels, setCatalogModels] = useState<CatalogModel[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // ---- 可搜索的全量供应商选择器状态 --------------------------------------
  const [allProviders, setAllProviders] = useState<
    Array<{ id: string; name: string; api?: string; protocol: CustomModelProvider }>
  >([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerQuery, setProviderQuery] = useState('');
  const [providerSearchIndex, setProviderSearchIndex] = useState(0);

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
      } else if (opt.value === BROWSE_ALL_PROVIDERS) {
        // 打开可搜索的全量供应商选择器。
        setProviderQuery('');
        setProviderSearchIndex(0);
        setCurrentStep(ManualStep.PROVIDER_SEARCH);
      } else if (opt.baseUrl) {
        // 品牌预设：自动补好接口地址与协议，跳过手输 base URL 与命名，直接填 key。
        // displayName 留空，到选模型/填模型步自动用模型名填充（避免同供应商多模型重名）。
        // 记下 models.dev id：输完 key 后据此拉取该供应商的模型列表交互选择。
        setSelectedModelsDevId(opt.modelsDevId ?? null);
        setCatalogModels([]);
        setCatalogError(null);
        setConfig(prev => ({
          ...prev,
          provider: opt.protocol!,
          baseUrl: opt.baseUrl!,
          displayName: '',
        }));
        setCurrentStep(ManualStep.API_KEY);
      } else {
        // 自定义/手动：走原流程（先命名，再手输 base URL）。
        setSelectedModelsDevId(null);
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
    { label: isChineseLocale() ? '✓ 保存配置' : '✓ Save config', value: 'save' },
    { label: isChineseLocale() ? '✗ 取消' : '✗ Cancel', value: 'cancel' },
  ];

  const handleInputSubmit = useCallback((value: string) => {
    const trimmedValue = value.trim();

    switch (currentStep) {
      case ManualStep.DISPLAY_NAME:
        if (!trimmedValue) {
          setValidationError(isChineseLocale() ? '显示名不能为空' : 'Display name cannot be empty');
          return;
        }
        setConfig(prev => ({ ...prev, displayName: trimmedValue }));
        setInputValue('');
        setValidationError(null);
        setCurrentStep(ManualStep.BASE_URL);
        break;

      case ManualStep.BASE_URL:
        if (!trimmedValue) {
          setValidationError(isChineseLocale() ? '接口地址不能为空' : 'Base URL cannot be empty');
          return;
        }
        if (!trimmedValue.startsWith('http://') && !trimmedValue.startsWith('https://')) {
          setValidationError(
            isChineseLocale()
              ? '接口地址要以 http:// 或 https:// 开头'
              : 'Base URL must start with http:// or https://',
          );
          return;
        }
        setConfig(prev => ({ ...prev, baseUrl: trimmedValue.replace(/\/+$/, '') }));
        setInputValue('');
        setValidationError(null);
        setCurrentStep(ManualStep.API_KEY);
        break;

      case ManualStep.API_KEY:
        if (!trimmedValue) {
          setValidationError(isChineseLocale() ? 'API key 不能为空' : 'API key cannot be empty');
          return;
        }
        setConfig(prev => ({ ...prev, apiKey: trimmedValue }));
        setInputValue('');
        setValidationError(null);
        // 品牌预设（有 models.dev id）→ 拉模型列表交互选择；否则沿用手输模型名。
        setCurrentStep(
          selectedModelsDevId ? ManualStep.MODEL_SELECT : ManualStep.MODEL_ID,
        );
        break;

      case ManualStep.MODEL_ID:
        if (!trimmedValue) {
          setValidationError(isChineseLocale() ? '模型名不能为空' : 'Model name cannot be empty');
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
            setValidationError(
              isChineseLocale() ? '最大上下文必须是正整数' : 'Max context must be a positive integer',
            );
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
          setValidationError(isChineseLocale() ? 'API key 不能为空' : 'API key cannot be empty');
          return;
        }
        setEasyRouterApiKey(trimmedValue);
        setInputValue('');
        setValidationError(null);
        setEasyRouterFetchError(null);
        setCurrentStep(EasyRouterStep.FETCHING);
        break;

      default:
        break;
    }
  }, [currentStep, selectedModelsDevId]);

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
            isChineseLocale()
              ? '这个 API key 在 EasyRouter 下没有可用模型。'
              : 'EasyRouter returned no usable models for this API key.',
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

  // ---- 可搜索供应商：进入 PROVIDER_SEARCH 步时加载全量供应商清单 ----------
  useEffect(() => {
    if (currentStep !== ManualStep.PROVIDER_SEARCH) return;
    if (allProviders.length > 0) return;
    let cancelled = false;
    setProvidersLoading(true);
    (async () => {
      try {
        const provs = await loadModelsDevCatalog();
        if (cancelled) return;
        setAllProviders(
          provs.map((p) => ({
            id: p.id,
            name: p.name,
            api: p.api,
            protocol: p.protocol as CustomModelProvider,
          })),
        );
      } catch {
        /* 加载失败：列表为空，用户可 Esc 返回选预设 */
      } finally {
        if (!cancelled) setProvidersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentStep, allProviders.length]);

  // ---- 可搜索供应商：键盘处理（输入筛选 / ↑↓ 选择 / Enter 确认 / Esc 返回） --
  const handleProviderSearchKeypress = useCallback(
    (key: Key) => {
      if (key.name === 'escape') {
        setCurrentStep(ManualStep.PROVIDER);
        return;
      }
      const filtered = filterProviders(allProviders, providerQuery);
      if (key.name === 'up') {
        setProviderSearchIndex((i) =>
          i > 0 ? i - 1 : Math.max(0, filtered.length - 1),
        );
        return;
      }
      if (key.name === 'down') {
        setProviderSearchIndex((i) => (i < filtered.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.name === 'return') {
        const prov = filtered[providerSearchIndex];
        if (!prov || !prov.api) return;
        setSelectedModelsDevId(prov.id);
        setCatalogModels([]);
        setCatalogError(null);
        setConfig((prev) => ({
          ...prev,
          provider: prov.protocol,
          baseUrl: prov.api!.replace(/\/+$/, ''),
          displayName: '',
        }));
        setInputValue('');
        setValidationError(null);
        setCurrentStep(ManualStep.API_KEY);
        return;
      }
      if (key.name === 'backspace') {
        setProviderQuery((q) => q.slice(0, -1));
        setProviderSearchIndex(0);
        return;
      }
      // 可打印字符 → 追加到筛选词（支持粘贴：去掉换行）
      if (key.sequence && !key.ctrl && !key.meta) {
        const code = key.sequence.codePointAt(0);
        if (code !== undefined && code >= 32) {
          setProviderQuery((q) => q + key.sequence.replace(/[\r\n]+/g, ' '));
          setProviderSearchIndex(0);
        }
      }
    },
    [allProviders, providerQuery, providerSearchIndex],
  );
  useKeypress(handleProviderSearchKeypress, {
    isActive: currentStep === ManualStep.PROVIDER_SEARCH,
  });

  // ---- models.dev: 进入 MODEL_SELECT 步时拉取该供应商的模型列表 ----------
  useEffect(() => {
    if (currentStep !== ManualStep.MODEL_SELECT) return;
    if (!selectedModelsDevId) {
      // 没有 models.dev id（理论不会到这）→ 退回手输模型名。
      setCurrentStep(ManualStep.MODEL_ID);
      return;
    }
    if (catalogModels.length > 0) return; // 已有缓存结果，不重复拉取
    let cancelled = false;
    setCatalogLoading(true);
    setCatalogError(null);
    (async () => {
      try {
        const providers = await loadModelsDevCatalog();
        if (cancelled) return;
        const prov = findProvider(providers, selectedModelsDevId);
        if (!prov || prov.models.length === 0) {
          setCatalogError(
            isChineseLocale()
              ? '没拉到该供应商的模型列表（可手动输入模型名）'
              : "Couldn't fetch this provider's model list (you can enter a model name manually)",
          );
          setCatalogModels([]);
        } else {
          setCatalogModels(prov.models);
        }
      } catch (e) {
        if (cancelled) return;
        setCatalogError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentStep, selectedModelsDevId, catalogModels.length]);

  // ---- models.dev: 选中某个模型（或选"手动输入"） ------------------------
  const handleModelSelect = useCallback(
    (value: string) => {
      if (value === MANUAL_MODEL_ENTRY) {
        setInputValue('');
        setValidationError(null);
        setCurrentStep(ManualStep.MODEL_ID);
        return;
      }
      setConfig(prev => ({
        ...prev,
        modelId: value,
        displayName:
          prev.displayName && prev.displayName.trim() ? prev.displayName : value,
        maxTokens: prev.maxTokens ?? 128000,
      }));
      setValidationError(null);
      setCurrentStep(ManualStep.CONFIRM);
    },
    [],
  );

  // 模型选择步允许 Esc 取消（RadioButtonSelect 本身不处理 Esc）。
  const handleModelSelectKeypress = useCallback(
    (key: Key) => {
      if (key.name === 'escape') onCancel();
    },
    [onCancel],
  );
  useKeypress(handleModelSelectKeypress, {
    isActive: currentStep === ManualStep.MODEL_SELECT,
  });

  // ---- EasyRouter: SELECT_MODELS handlers --------------------------------
  const handleEasyRouterSubmit = useCallback(
    (selectedIds: string[]) => {
      if (selectedIds.length === 0) {
        setValidationError(
          isChineseLocale() ? '请至少选择一个模型。' : 'Please select at least one model.',
        );
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
    const zh = isChineseLocale();
    switch (step) {
      case ManualStep.PROVIDER:
        return zh ? '选择供应商' : 'Choose a provider';
      case ManualStep.PROVIDER_SEARCH:
        return zh ? '搜索供应商' : 'Search providers';
      case ManualStep.DISPLAY_NAME:
        return zh ? '起个显示名' : 'Pick a display name';
      case ManualStep.BASE_URL:
        return zh ? '填写接口地址' : 'Enter the base URL';
      case ManualStep.API_KEY:
        return zh ? '填写 API Key' : 'Enter your API Key';
      case ManualStep.MODEL_SELECT:
        return zh ? '选择模型' : 'Choose a model';
      case ManualStep.MODEL_ID:
        return zh ? '填写模型名' : 'Enter the model name';
      case ManualStep.MAX_TOKENS:
        return zh ? '最大上下文（可选）' : 'Max context (optional)';
      case ManualStep.CONFIRM:
        return zh ? '确认配置' : 'Confirm config';
      case EasyRouterStep.API_KEY:
        return zh ? '填写 EasyRouter API Key' : 'Enter your EasyRouter API Key';
      case EasyRouterStep.FETCHING:
        return zh ? '正在加载可用模型…' : 'Loading available models…';
      case EasyRouterStep.SELECT_MODELS:
        return zh ? '勾选要添加的模型' : 'Select models to add';
      case EasyRouterStep.CONFIRM:
        return zh ? '确认 EasyRouter 模型' : 'Confirm EasyRouter models';
      default:
        return '';
    }
  };

  const getStepDescription = (step: WizardStep): string => {
    const zh = isChineseLocale();
    switch (step) {
      case ManualStep.PROVIDER:
        return zh
          ? '选一个供应商；带「拉模型列表」的会自动补接口地址并让你挑模型。'
          : 'Pick a provider; ones with a model list auto-fill the base URL and let you choose a model.';
      case ManualStep.PROVIDER_SEARCH:
        return zh
          ? '输入关键字（如 glm / kimi / qwen / openrouter）筛选，↑↓ 选择，Enter 进入下一步选模型。'
          : 'Type a keyword (e.g. glm / kimi / qwen / openrouter) to filter, ↑↓ to select, Enter to continue to model selection.';
      case ManualStep.DISPLAY_NAME:
        return zh
          ? '这个名字会显示在模型选择列表里（也是唯一标识）。'
          : 'This name shows up in the model picker (and is the unique identifier).';
      case ManualStep.BASE_URL:
        return zh
          ? '接口地址（例：https://api.openai.com/v1）。'
          : 'Base URL (e.g. https://api.openai.com/v1).';
      case ManualStep.API_KEY:
        return zh
          ? '你的 API key，直接粘贴即可；也可填 ${环境变量} 或 {file:文件路径} 引用。'
          : 'Your API key — paste it directly, or use ${ENV_VAR} or {file:path} references.';
      case ManualStep.MODEL_SELECT:
        return zh
          ? '从该供应商的实时模型清单（models.dev）里选一个；列表里没有就选「手动输入」。'
          : "Choose from this provider's live model list (models.dev); if it's not there, pick \"enter manually\".";
      case ManualStep.MODEL_ID:
        return zh
          ? 'API 使用的模型名（例：gpt-4-turbo）。'
          : 'The model name used by the API (e.g. gpt-4-turbo).';
      case ManualStep.MAX_TOKENS:
        return zh
          ? '最大上下文长度（直接回车跳过用默认）。'
          : 'Max context length (press Enter to skip and use the default).';
      case ManualStep.CONFIRM:
        return zh ? '核对一下配置，确认保存。' : 'Review the config and confirm to save.';
      case EasyRouterStep.API_KEY:
        return zh
          ? `粘贴你的 EasyRouter key。接口地址固定为 ${EASY_ROUTER_BASE_URL}。`
          : `Paste your EasyRouter key. The base URL is fixed at ${EASY_ROUTER_BASE_URL}.`;
      case EasyRouterStep.FETCHING:
        return zh
          ? '正在从 EasyRouter 拉取实时模型清单，并过滤掉图像 / 向量 / 视频类模型。'
          : 'Fetching the live model list from EasyRouter and filtering out image / embedding / video models.';
      case EasyRouterStep.SELECT_MODELS:
        return zh
          ? '↑/↓ 移动，空格勾选，Enter 确认。默认全选。'
          : '↑/↓ to move, Space to toggle, Enter to confirm. All selected by default.';
      case EasyRouterStep.CONFIRM:
        return zh
          ? `将保存这 ${easyRouterSelected.length} 个模型，协议自动识别。`
          : `Will save these ${easyRouterSelected.length} models, with protocols auto-detected.`;
      default:
        return '';
    }
  };

  const getStepExample = (step: WizardStep): string | null => {
    const zh = isChineseLocale();
    const eg = zh ? '例：' : 'e.g. ';
    switch (step) {
      case ManualStep.DISPLAY_NAME:
        return zh ? `${eg}我的 GPT-4 Turbo` : `${eg}My GPT-4 Turbo`;
      case ManualStep.BASE_URL:
        if (config.provider === 'openai') return `${eg}https://api.openai.com/v1`;
        if (config.provider === 'openai-responses') return `${eg}https://api.openai.com/v1`;
        if (config.provider === 'anthropic') return `${eg}https://api.anthropic.com`;
        if (config.provider === 'gemini') return `${eg}https://generativelanguage.googleapis.com/v1beta`;
        return `${eg}http://localhost:1234/v1`;
      case ManualStep.API_KEY:
        return `${eg}sk-... ${zh ? '或' : 'or'} \${OPENAI_API_KEY} ${zh ? '或' : 'or'} {file:~/.otto-user/secrets/glm}`;
      case ManualStep.MODEL_ID:
        if (config.provider === 'openai') return `${eg}gpt-4-turbo`;
        if (config.provider === 'openai-responses') return zh ? `${eg}gpt-4o、o3` : `${eg}gpt-4o, o3`;
        if (config.provider === 'anthropic') return `${eg}claude-sonnet-4-5`;
        if (config.provider === 'gemini')
          return zh
            ? `${eg}gemini-2.5-pro、<模型id，如 gemini-2.5-flash>`
            : `${eg}gemini-2.5-pro, <model id, e.g. gemini-2.5-flash>`;
        return `${eg}llama-3-70b`;
      case ManualStep.MAX_TOKENS:
        return `${eg}128000`;
      case EasyRouterStep.API_KEY:
        return zh ? `${eg}sk-...（你从 EasyRouter 拿到的 key）` : `${eg}sk-... (the key you got from EasyRouter)`;
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
          {isChineseLocale()
            ? '↑/↓ 或 k/j 选择，Enter 确认，Esc 取消'
            : '↑/↓ or k/j to select, Enter to confirm, Esc to cancel'}
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
    const zh = isChineseLocale();
    const placeholder = isApiKeyStep
      ? (zh ? '在此粘贴 API key…' : 'Paste your API key here…')
      : currentStep === ManualStep.MAX_TOKENS
        ? (zh ? '回车跳过用默认' : 'Press Enter to skip (use default)')
        : (zh ? '在此输入…' : 'Type here…');
    return (
      <Box flexDirection="column">
        <SimpleTextInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleInputSubmit}
          onCancel={handleTextInputCancel}
          isActive={isTextInputStep}
          mask={isApiKeyStep ? '*' : undefined}
          placeholder={placeholder}
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
              ? (zh
                  ? 'Enter 确认 · Esc 取消 · Ctrl+V 从剪贴板粘贴（⌘V 粘不进时用它）'
                  : 'Enter to confirm · Esc to cancel · Ctrl+V to paste from clipboard (use it when ⌘V won\'t paste)')
              : (zh
                  ? 'Enter 确认 · Esc 取消 · Ctrl+V 从剪贴板粘贴'
                  : 'Enter to confirm · Esc to cancel · Ctrl+V to paste from clipboard')}
          </Text>
        </Box>
      </Box>
    );
  };

  const renderProviderSearch = () => {
    const filtered = filterProviders(allProviders, providerQuery);
    const VISIBLE = 10;
    let start = 0;
    if (filtered.length > VISIBLE) {
      start = Math.min(
        Math.max(providerSearchIndex - 5, 0),
        filtered.length - VISIBLE,
      );
    }
    const visible = filtered.slice(start, start + VISIBLE);
    const zh = isChineseLocale();
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={Colors.AccentCyan}>🔎 </Text>
          <Text>{providerQuery}</Text>
          <Text inverse> </Text>
          <Text color={Colors.Gray}>
            {zh
              ? `   ${filtered.length}/${allProviders.length} 家`
              : `   ${filtered.length}/${allProviders.length} providers`}
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {providersLoading && allProviders.length === 0 ? (
            <Box>
              <Text color={Colors.AccentCyan}>
                <Spinner type="dots" />
              </Text>
              <Text>{zh ? ' 正在加载供应商清单（models.dev）…' : ' Loading provider list (models.dev)…'}</Text>
            </Box>
          ) : filtered.length === 0 ? (
            <Text color={Colors.Gray}>
              {zh
                ? '没有匹配的供应商，换个关键字试试（Esc 返回选预设）'
                : 'No matching providers — try another keyword (Esc to go back to presets)'}
            </Text>
          ) : (
            visible.map((p, i) => {
              const realIndex = start + i;
              const sel = realIndex === providerSearchIndex;
              return (
                <Box key={p.id}>
                  <Box width={2}>
                    <Text color={sel ? Colors.AccentGreen : Colors.Gray}>
                      {sel ? '▶' : ' '}
                    </Text>
                  </Box>
                  <Text
                    color={sel ? Colors.AccentGreen : Colors.Foreground}
                    bold={sel}
                  >
                    {p.name}
                  </Text>
                  <Text color={Colors.Gray}>{`  ${p.id}`}</Text>
                </Box>
              );
            })
          )}
        </Box>
        <Box marginTop={1}>
          <Text color={Colors.Gray}>
            {zh
              ? '输入筛选 · ↑/↓ 选择 · Enter 确认 · Esc 返回'
              : 'Type to filter · ↑/↓ to select · Enter to confirm · Esc to go back'}
          </Text>
        </Box>
      </Box>
    );
  };

  const renderModelSelect = () => {
    const zh = isChineseLocale();
    if (catalogLoading) {
      return (
        <Box>
          <Text color={Colors.AccentCyan}>
            <Spinner type="dots" />
          </Text>
          <Text>{zh ? ' 正在从 models.dev 拉取模型列表…' : ' Fetching model list from models.dev…'}</Text>
        </Box>
      );
    }

    // 列表项：模型清单 + 末尾「手动输入」兜底。
    const items = [
      ...catalogModels.map((m) => {
        const tags =
          (m.reasoning ? (zh ? '推理 ' : 'reasoning ') : '') +
          (m.toolCall ? (zh ? '工具' : 'tools') : '');
        return {
          label:
            m.name && m.name !== m.id ? `${m.id}  —  ${m.name}` : m.id,
          value: m.id,
          rightText: tags.trim() || undefined,
        };
      }),
      {
        label: zh
          ? '✏️  手动输入模型名（列表里没有时）'
          : "✏️  Enter model name manually (if it's not listed)",
        value: MANUAL_MODEL_ENTRY,
      },
    ];

    return (
      <Box flexDirection="column">
        {catalogError && (
          <Box marginBottom={1}>
            <Text color={Colors.AccentYellow}>⚠ {catalogError}</Text>
          </Box>
        )}
        <RadioButtonSelect
          items={items}
          initialIndex={0}
          onSelect={handleModelSelect}
          onHighlight={() => {}}
          isFocused={currentStep === ManualStep.MODEL_SELECT}
          maxItemsToShow={10}
          showNumbers
        />
        <Box marginTop={1}>
          <Text color={Colors.Gray}>
            {zh
              ? `↑/↓ 选择 · Enter 确认 · Esc 取消${catalogModels.length > 0 ? ` · 共 ${catalogModels.length} 个模型` : ''}`
              : `↑/↓ to select · Enter to confirm · Esc to cancel${catalogModels.length > 0 ? ` · ${catalogModels.length} models` : ''}`}
          </Text>
        </Box>
      </Box>
    );
  };

  const renderConfirmation = () => {
    const zh = isChineseLocale();
    return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={Colors.AccentYellow} bold>
          {zh ? '核对一下配置：' : 'Review your config:'}
        </Text>
      </Box>

      <Box marginLeft={2} flexDirection="column">
        <Text>
          <Text color={Colors.AccentCyan} bold>{zh ? '协议    ' : 'Protocol    '}</Text>
          <Text>{config.provider}</Text>
        </Text>
        <Text>
          <Text color={Colors.AccentCyan} bold>{zh ? '显示名  ' : 'Name        '}</Text>
          <Text>{config.displayName}</Text>
        </Text>
        <Text>
          <Text color={Colors.AccentCyan} bold>{zh ? '接口    ' : 'Base URL    '}</Text>
          <Text>{config.baseUrl}</Text>
        </Text>
        <Text>
          <Text color={Colors.AccentCyan} bold>{zh ? 'Key     ' : 'Key         '}</Text>
          <Text>{config.apiKey?.includes('${') || config.apiKey?.includes('{file:') || config.apiKey?.includes('{env:') ? config.apiKey : '***' + config.apiKey?.slice(-4)}</Text>
        </Text>
        <Text>
          <Text color={Colors.AccentCyan} bold>{zh ? '模型    ' : 'Model       '}</Text>
          <Text>{config.modelId}</Text>
        </Text>
        {config.maxTokens && (
          <Text>
            <Text color={Colors.AccentCyan} bold>{zh ? '上下文  ' : 'Context     '}</Text>
            <Text>{config.maxTokens}</Text>
          </Text>
        )}
      </Box>

      {validationError && (
        <Box marginTop={1}>
          <Text color={Colors.AccentRed}>{zh ? `✗ 配置有误：${validationError}` : `✗ Invalid config: ${validationError}`}</Text>
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
  };

  // ---- EasyRouter renders -------------------------------------------------
  const renderEasyRouterFetching = () => {
    const zh = isChineseLocale();
    return (
    <Box flexDirection="column">
      {!easyRouterFetchError ? (
        <Box>
          <Text color={Colors.AccentCyan}>
            <Spinner type="dots" />
          </Text>
          <Text>
            {zh
              ? ` 正在连接 EasyRouter 获取模型清单（${EASY_ROUTER_BASE_URL}/models）…`
              : ` Connecting to EasyRouter to fetch the model list (${EASY_ROUTER_BASE_URL}/models)…`}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text color={Colors.AccentRed}>✗ {easyRouterFetchError}</Text>
          <Box marginTop={1}>
            <Text color={Colors.Gray}>{zh ? '按 Esc 取消后重试。' : 'Press Esc to cancel, then try again.'}</Text>
          </Box>
        </Box>
      )}
    </Box>
    );
  };

  const renderEasyRouterSelectModels = () => {
    const zh = isChineseLocale();
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
        : `${protoLabel} · ${formatTokenCount(EASY_ROUTER_DEFAULT_MAX_TOKENS)} ctx (${zh ? '默认' : 'default'})`;
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
            {zh
              ? `已选 ${easyRouterSelected.length}/${easyRouterModels.length} 个 · 空格勾选 · Enter 确认 · Esc 取消`
              : `${easyRouterSelected.length}/${easyRouterModels.length} selected · Space to toggle · Enter to confirm · Esc to cancel`}
          </Text>
          <Text color={Colors.Gray}>
            {zh
              ? `元数据：${matched}/${easyRouterModels.length} 个已匹配（其余按默认 ${formatTokenCount(EASY_ROUTER_DEFAULT_MAX_TOKENS)} 上下文）。`
              : `Metadata: ${matched}/${easyRouterModels.length} matched (the rest default to ${formatTokenCount(EASY_ROUTER_DEFAULT_MAX_TOKENS)} context).`}
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
    const zh = isChineseLocale();
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color={Colors.AccentYellow} bold>
            {zh
              ? `将添加 ${easyRouterSelected.length} 个 EasyRouter 模型：`
              : `Adding ${easyRouterSelected.length} EasyRouter models:`}
          </Text>
        </Box>
        <Box marginLeft={2} flexDirection="column">
          <Text>
            <Text color={Colors.AccentCyan} bold>{zh ? '接口地址：' : 'Base URL: '}</Text>
            <Text>{EASY_ROUTER_BASE_URL}</Text>
          </Text>
          <Text>
            <Text color={Colors.AccentCyan} bold>{zh ? 'API Key： ' : 'API Key:  '}</Text>
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
                        {isDefault ? (zh ? ' 默认' : ' default') : ''})
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

  // Step counter — manual人工映射 to avoid跳号:
  //   品牌预设路径 (selectedModelsDevId 非空): 4 步
  //     PROVIDER → API_KEY → MODEL_SELECT → CONFIRM
  //     (自动补好 baseUrl、跳过命名与 maxTokens,故对用户只有 4 步)
  //   纯手动路径 (selectedModelsDevId 为空): 6 步
  //     PROVIDER(选供应商) → DISPLAY_NAME(命名) → BASE_URL(接口) → API_KEY(Key)
  //     → MODEL_ID(模型) → MAX_TOKENS+CONFIRM(上下文+确认合并为一步,与下面 EasyRouter
  //       把 fetch+select 合并的做法一致)
  //   easy-router: 4 步 (provider, apiKey, fetch+select, confirm) — fetch+select 合并。
  // 枚举下标(含 PROVIDER_SEARCH 这种过场态、且两条路径跳过的步骤)不能直接当 step 号,
  // 否则品牌预设流会显示 1/9 → 5/9 跳号。改为按 currentStep 手动映射出 {stepNumber, totalSteps}。
  let stepNumber = 1;
  let totalSteps = 6;
  if (isManualStep(currentStep)) {
    if (selectedModelsDevId) {
      // 品牌预设:4 步
      totalSteps = 4;
      switch (currentStep) {
        case ManualStep.PROVIDER:
        case ManualStep.PROVIDER_SEARCH:
          stepNumber = 1;
          break;
        case ManualStep.API_KEY:
          stepNumber = 2;
          break;
        case ManualStep.MODEL_SELECT:
        case ManualStep.MODEL_ID:
          stepNumber = 3;
          break;
        case ManualStep.CONFIRM:
          stepNumber = 4;
          break;
        default:
          stepNumber = 1;
          break;
      }
    } else {
      // 纯手动:6 步(上下文与确认合并为第 6 步)
      totalSteps = 6;
      switch (currentStep) {
        case ManualStep.PROVIDER:
        case ManualStep.PROVIDER_SEARCH:
          stepNumber = 1;
          break;
        case ManualStep.DISPLAY_NAME:
          stepNumber = 2;
          break;
        case ManualStep.BASE_URL:
          stepNumber = 3;
          break;
        case ManualStep.API_KEY:
          stepNumber = 4;
          break;
        case ManualStep.MODEL_SELECT:
        case ManualStep.MODEL_ID:
          stepNumber = 5;
          break;
        case ManualStep.MAX_TOKENS:
        case ManualStep.CONFIRM:
          stepNumber = 6;
          break;
        default:
          stepNumber = 1;
          break;
      }
    }
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
      {/* Header：品牌 + 当前步骤标题同一行，清爽 */}
      <Box marginBottom={1}>
        <Text color={Colors.AccentCyan} bold>
          {isChineseLocale() ? '✨ Otto 模型配置' : '✨ Otto model setup'}
        </Text>
        <Text color={Colors.Gray}>{isChineseLocale() ? `   第 ${stepNumber}/${totalSteps} 步 · ` : `   Step ${stepNumber}/${totalSteps} · `}</Text>
        <Text color={Colors.Foreground} bold>
          {getStepTitle(currentStep)}
        </Text>
      </Box>

      {/* Description */}
      <Box marginBottom={1}>
        <Text color={Colors.Comment}>
          {getStepDescription(currentStep)}
        </Text>
      </Box>

      <Box paddingX={1}>
        {currentStep === ManualStep.PROVIDER && renderProviderSelection()}
        {currentStep === ManualStep.PROVIDER_SEARCH && renderProviderSearch()}
        {currentStep === ManualStep.MODEL_SELECT && renderModelSelect()}
        {isTextInputStep && renderTextInput()}
        {currentStep === ManualStep.CONFIRM && renderConfirmation()}
        {currentStep === EasyRouterStep.FETCHING && renderEasyRouterFetching()}
        {currentStep === EasyRouterStep.SELECT_MODELS && renderEasyRouterSelectModels()}
        {currentStep === EasyRouterStep.CONFIRM && renderEasyRouterConfirm()}
      </Box>
    </Box>
  );
}
