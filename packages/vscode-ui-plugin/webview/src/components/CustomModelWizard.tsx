/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Custom Model Wizard (webview / DOM port)
 * --------------------------------------------------------------------------
 * Multi-step modal mirrors the CLI's `CustomModelWizard.tsx` (Ink) but uses
 * plain DOM controls so it runs inside the VSCode webview iframe.
 *
 * Two flows share the first "provider" step:
 *   1. EasyRouter (recommended) — paste API key → fetch live model catalogue
 *      → multi-select → confirm. Auto-classifies each id into the right
 *      protocol (openai / openai-responses / anthropic / gemini) and
 *      auto-fills max-context from the EasyClaw metadata catalogue.
 *   2. Manual — provider → displayName → baseUrl → apiKey → modelId →
 *      maxTokens → confirm. Same fields the CLI wizard collects.
 *
 * Persistence + hot-reload is delegated to the extension host through
 * `customModelsService.addCustomModels()`.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CustomModelConfig,
  CustomModelProvider,
  validateCustomModelConfig,
  buildEasyRouterModelConfig,
  classifyEasyRouterModel,
  EASY_ROUTER_BASE_URL,
  EASY_ROUTER_DEFAULT_MAX_TOKENS,
  type EasyRouterModelEntry,
  type EasyClawModelMetadata,
} from '../types/customModel';
import { customModelsService } from '../services/customModelsService';
import { getGlobalMessageService } from '../services/globalMessageService';
import './CustomModelWizard.css';

interface CustomModelWizardProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called after configs are persisted by the extension host. */
  onSaved?: (saved: CustomModelConfig[]) => void;
}

const EASY_ROUTER_PROVIDER_VALUE = 'easy-router' as const;

type ProviderOptionValue =
  | CustomModelProvider
  | typeof EASY_ROUTER_PROVIDER_VALUE;

interface ProviderOption {
  value: ProviderOptionValue;
  label: string;
  description: string;
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    value: EASY_ROUTER_PROVIDER_VALUE,
    label: 'EasyRouter (Recommended)',
    description:
      "Otto's own router. Just paste your API key and pick which models to add — no base URL or protocol setup required.",
  },
  {
    value: 'openai',
    label: 'OpenAI Compatible',
    description: 'OpenAI API, Azure OpenAI, LM Studio, Ollama, Groq, Together AI, etc.',
  },
  {
    value: 'openai-responses',
    label: 'OpenAI (Responses API)',
    description: 'OpenAI Responses API (POST /responses), recommended for new projects',
  },
  {
    value: 'anthropic',
    label: 'Anthropic Claude',
    description: 'Claude API (claude.ai)',
  },
  {
    value: 'gemini',
    label: 'Google Gemini (GenAI)',
    description:
      'Native Google GenAI API (POST /v1beta/models/{id}:streamGenerateContent). Full support for thinkingConfig + thoughts.',
  },
];

type Step =
  | 'provider'
  // manual flow
  | 'displayName'
  | 'baseUrl'
  | 'apiKey'
  | 'modelId'
  | 'maxTokens'
  | 'confirm'
  // EasyRouter flow
  | 'er_apiKey'
  | 'er_fetching'
  | 'er_select'
  | 'er_confirm';

const MANUAL_STEPS: Step[] = [
  'provider',
  'displayName',
  'baseUrl',
  'apiKey',
  'modelId',
  'maxTokens',
  'confirm',
];

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

function getStepTitle(step: Step): string {
  switch (step) {
    case 'provider':
      return 'Select Provider Type';
    case 'displayName':
      return 'Enter Display Name';
    case 'baseUrl':
      return 'Enter API Base URL';
    case 'apiKey':
      return 'Enter API Key';
    case 'modelId':
      return 'Enter Model Name';
    case 'maxTokens':
      return 'Enter Max Tokens (Optional)';
    case 'confirm':
      return 'Confirm Configuration';
    case 'er_apiKey':
      return 'Enter EasyRouter API Key';
    case 'er_fetching':
      return 'Loading available models…';
    case 'er_select':
      return 'Select Models to Add';
    case 'er_confirm':
      return 'Confirm EasyRouter Models';
  }
}

function getStepDescription(step: Step, selectedCount?: number): string {
  switch (step) {
    case 'provider':
      return 'Choose the API format for your custom model.';
    case 'displayName':
      return 'This name appears in the model picker. It also serves as the unique identifier — picking an existing name overwrites that entry.';
    case 'baseUrl':
      return 'API endpoint base URL (e.g. https://api.openai.com/v1).';
    case 'apiKey':
      return 'API key — supports environment variable references like ${OPENAI_API_KEY}.';
    case 'modelId':
      return 'Upstream model name to use (e.g. gpt-4-turbo, claude-sonnet-4-5, gemini-2.5-pro).';
    case 'maxTokens':
      return 'Optional context-window size in tokens. Leave blank to skip — UI will assume a 200K default.';
    case 'confirm':
      return 'Review your configuration and confirm.';
    case 'er_apiKey':
      return 'Paste your EasyRouter API key. The router endpoint is auto-configured.';
    case 'er_fetching':
      return 'Fetching the live model catalogue from EasyRouter and filtering out image / embedding / video models.';
    case 'er_select':
      return 'Pick which models to add. They are auto-classified into the correct protocol; thinking is enabled where supported.';
    case 'er_confirm':
      return `These ${selectedCount ?? 0} model(s) will be saved with the appropriate protocol auto-detected.`;
  }
}

function getStepExample(
  step: Step,
  provider?: CustomModelProvider,
): string | null {
  switch (step) {
    case 'displayName':
      return 'Example: My GPT-4 Turbo';
    case 'baseUrl':
      if (provider === 'openai') return 'Example: https://api.openai.com/v1';
      if (provider === 'openai-responses') return 'Example: https://api.openai.com/v1';
      if (provider === 'anthropic') return 'Example: https://api.anthropic.com';
      if (provider === 'gemini') return 'Example: https://generativelanguage.googleapis.com/v1beta';
      return 'Example: http://localhost:1234/v1';
    case 'apiKey':
      return 'Example: ${OPENAI_API_KEY} or sk-...';
    case 'modelId':
      if (provider === 'openai') return 'Example: gpt-4-turbo';
      if (provider === 'openai-responses') return 'Example: gpt-4o, o3';
      if (provider === 'anthropic') return 'Example: claude-sonnet-4-5';
      if (provider === 'gemini') return 'Example: gemini-2.5-pro, gemini-3.5-flash';
      return 'Example: llama-3-70b';
    case 'maxTokens':
      return 'Example: 128000';
    case 'er_apiKey':
      return 'Example: sk-... (the key you got from EasyRouter)';
    default:
      return null;
  }
}

const PROTO_LABEL: Record<CustomModelProvider, string> = {
  openai: 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
};

export const CustomModelWizard: React.FC<CustomModelWizardProps> = ({
  isOpen,
  onClose,
  onSaved,
}) => {
  const [step, setStep] = useState<Step>('provider');
  const [config, setConfig] = useState<Partial<CustomModelConfig>>({ enabled: true });
  const [providerIndex, setProviderIndex] = useState(0);
  const [inputValue, setInputValue] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // EasyRouter-specific state.
  const [erApiKey, setErApiKey] = useState('');
  const [erModels, setErModels] = useState<EasyRouterModelEntry[]>([]);
  const [erMetadata, setErMetadata] = useState<Map<string, EasyClawModelMetadata>>(new Map());
  const [erSelected, setErSelected] = useState<Set<string>>(new Set());
  const [erFetchError, setErFetchError] = useState<string | null>(null);
  const [erFilter, setErFilter] = useState('');

  // Reset everything whenever the dialog re-opens — important if the user
  // cancels mid-flow and reopens the wizard later.
  useEffect(() => {
    if (!isOpen) return;
    setStep('provider');
    setConfig({ enabled: true });
    setProviderIndex(0);
    setInputValue('');
    setValidationError(null);
    setIsSaving(false);
    setErApiKey('');
    setErModels([]);
    setErMetadata(new Map());
    setErSelected(new Set());
    setErFetchError(null);
    setErFilter('');
  }, [isOpen]);

  // ESC-to-close at any step (unless saving).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isSaving) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isSaving, onClose]);

  // EasyRouter fetch trigger when entering the fetching step.
  useEffect(() => {
    if (step !== 'er_fetching') return;
    let cancelled = false;
    (async () => {
      try {
        const [list, metadata] = await Promise.all([
          customModelsService.fetchEasyRouterModels(erApiKey),
          customModelsService.fetchEasyClawMetadata(),
        ]);
        if (cancelled) return;
        setErModels(list);
        setErMetadata(metadata);
        if (list.length === 0) {
          setErFetchError('EasyRouter returned no usable models for this API key.');
        } else {
          setErSelected(new Set(list.map((m) => m.id))); // default-select all
          setStep('er_select');
        }
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        const status = (e as any)?.status ? ` (HTTP ${(e as any).status})` : '';
        setErFetchError(`${msg}${status}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, erApiKey]);

  const handleProviderConfirm = () => {
    const chosen = PROVIDER_OPTIONS[providerIndex].value;
    setValidationError(null);
    setInputValue('');
    if (chosen === EASY_ROUTER_PROVIDER_VALUE) {
      setConfig((prev) => ({ ...prev, baseUrl: EASY_ROUTER_BASE_URL }));
      setStep('er_apiKey');
    } else {
      setConfig((prev) => ({ ...prev, provider: chosen as CustomModelProvider }));
      setStep('displayName');
    }
  };

  // ---- Manual flow: text-input step submit ---------------------------------
  const handleManualSubmit = () => {
    const value = inputValue.trim();
    setValidationError(null);

    switch (step) {
      case 'displayName':
        if (!value) {
          setValidationError('Display name cannot be empty');
          return;
        }
        setConfig((prev) => ({ ...prev, displayName: value }));
        setInputValue('');
        setStep('baseUrl');
        break;
      case 'baseUrl':
        if (!value) {
          setValidationError('Base URL cannot be empty');
          return;
        }
        if (!value.startsWith('http://') && !value.startsWith('https://')) {
          setValidationError('Base URL must start with http:// or https://');
          return;
        }
        setConfig((prev) => ({ ...prev, baseUrl: value.replace(/\/+$/, '') }));
        setInputValue('');
        setStep('apiKey');
        break;
      case 'apiKey':
        if (!value) {
          setValidationError('API key cannot be empty');
          return;
        }
        setConfig((prev) => ({ ...prev, apiKey: value }));
        setInputValue('');
        setStep('modelId');
        break;
      case 'modelId':
        if (!value) {
          setValidationError('Model ID cannot be empty');
          return;
        }
        setConfig((prev) => ({ ...prev, modelId: value }));
        setInputValue('');
        setStep('maxTokens');
        break;
      case 'maxTokens':
        if (value) {
          const n = parseInt(value, 10);
          if (Number.isNaN(n) || n <= 0) {
            setValidationError('Max tokens must be a positive number');
            return;
          }
          setConfig((prev) => ({ ...prev, maxTokens: n }));
        }
        setInputValue('');
        setStep('confirm');
        break;
      case 'er_apiKey':
        if (!value) {
          setValidationError('API key cannot be empty');
          return;
        }
        setErApiKey(value);
        setErFetchError(null);
        setInputValue('');
        setStep('er_fetching');
        break;
      default:
        break;
    }
  };

  // ---- Manual confirm: persist single config -------------------------------
  const handleManualConfirm = async () => {
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
    try {
      setIsSaving(true);
      const merged = await customModelsService.addCustomModels([fullConfig]);
      setIsSaving(false);
      onSaved?.([fullConfig]);
      onClose();
      void merged;
    } catch (e) {
      setIsSaving(false);
      setValidationError(e instanceof Error ? e.message : String(e));
    }
  };

  // ---- EasyRouter confirm: persist all selected configs --------------------
  const handleEasyRouterConfirm = async () => {
    const selectedIds = Array.from(erSelected);
    if (selectedIds.length === 0) {
      setValidationError('Please select at least one model.');
      return;
    }
    const configs: CustomModelConfig[] = selectedIds.map((id) =>
      buildEasyRouterModelConfig(id, erApiKey, {
        displayName: id,
        metadata: erMetadata.get(id),
      }),
    );
    for (const cfg of configs) {
      const errors = validateCustomModelConfig(cfg);
      if (errors.length > 0) {
        setValidationError(`Internal error generating config for "${cfg.modelId}": ${errors.join(', ')}`);
        return;
      }
    }
    try {
      setIsSaving(true);
      await customModelsService.addCustomModels(configs);
      setIsSaving(false);
      onSaved?.(configs);
      onClose();
    } catch (e) {
      setIsSaving(false);
      setValidationError(e instanceof Error ? e.message : String(e));
    }
  };

  // ---- Step counter for the progress label ---------------------------------
  const { stepNumber, totalSteps } = useMemo(() => {
    if (MANUAL_STEPS.includes(step)) {
      return {
        stepNumber: MANUAL_STEPS.indexOf(step) + 1,
        totalSteps: MANUAL_STEPS.length,
      };
    }
    // EasyRouter flow: 4 logical steps.
    if (step === 'er_apiKey') return { stepNumber: 2, totalSteps: 4 };
    if (step === 'er_fetching' || step === 'er_select')
      return { stepNumber: 3, totalSteps: 4 };
    if (step === 'er_confirm') return { stepNumber: 4, totalSteps: 4 };
    return { stepNumber: 1, totalSteps: 4 };
  }, [step]);

  if (!isOpen) return null;

  // ---- Renders -------------------------------------------------------------
  const renderProvider = () => {
    /**
     * Open EasyRouter's homepage in the user's external browser via the
     * extension host. We can't use a plain <a target="_blank"> because the
     * webview iframe blocks unrecognised navigations — this matches what
     * PPTGeneratorDialog / NanoBananaDialog already do for outbound links.
     */
    const openEasyRouterSite = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        (getGlobalMessageService() as any).openExternalUrl?.('https://ezr.sh/');
      } catch {
        // best-effort — no-op if openExternalUrl isn't wired in this build.
      }
    };

    return (
      <div className="cmw-step-body">
        <div className="cmw-provider-list" role="radiogroup">
          {PROVIDER_OPTIONS.map((opt, idx) => (
            <label
              key={opt.value}
              className={`cmw-provider-item ${idx === providerIndex ? 'selected' : ''}`}
              onClick={() => setProviderIndex(idx)}
            >
              <input
                type="radio"
                name="provider"
                checked={idx === providerIndex}
                onChange={() => setProviderIndex(idx)}
              />
              <div className="cmw-provider-text">
                <div className="cmw-provider-label">{opt.label}</div>
                <div className="cmw-provider-desc">
                  {opt.description}
                  {opt.value === EASY_ROUTER_PROVIDER_VALUE && (
                    <>
                      {' '}
                      <a
                        href="https://ezr.sh/"
                        className="cmw-link"
                        onClick={openEasyRouterSite}
                      >
                        Get an API key →
                      </a>
                    </>
                  )}
                </div>
              </div>
            </label>
          ))}
        </div>
        <div className="cmw-actions">
          <button className="cmw-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="cmw-btn-primary" onClick={handleProviderConfirm}>
            Continue
          </button>
        </div>
      </div>
    );
  };

  const renderTextInput = () => {
    const example = getStepExample(step, config.provider);
    const isApiKeyStep = step === 'apiKey' || step === 'er_apiKey';
    const isMaxTokensStep = step === 'maxTokens';
    return (
      <div className="cmw-step-body">
        <input
          autoFocus
          className="cmw-input"
          type={isApiKeyStep ? 'password' : 'text'}
          inputMode={isMaxTokensStep ? 'numeric' : undefined}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleManualSubmit();
            }
          }}
          placeholder={example ?? ''}
        />
        {example && <div className="cmw-example">{example}</div>}
        {validationError && <div className="cmw-error">✗ {validationError}</div>}
        <div className="cmw-actions">
          <button className="cmw-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="cmw-btn-primary" onClick={handleManualSubmit}>
            Continue
          </button>
        </div>
      </div>
    );
  };

  const renderConfirm = () => {
    const providerLabel =
      PROVIDER_OPTIONS.find((p) => p.value === config.provider)?.label || config.provider;
    return (
      <div className="cmw-step-body">
        <div className="cmw-summary">
          <div className="cmw-summary-row">
            <span className="cmw-summary-label">Provider</span>
            <span>{providerLabel}</span>
          </div>
          <div className="cmw-summary-row">
            <span className="cmw-summary-label">Display Name</span>
            <span>{config.displayName}</span>
          </div>
          <div className="cmw-summary-row">
            <span className="cmw-summary-label">Base URL</span>
            <span>{config.baseUrl}</span>
          </div>
          <div className="cmw-summary-row">
            <span className="cmw-summary-label">API Key</span>
            <span>
              {config.apiKey?.includes('${')
                ? config.apiKey
                : '***' + (config.apiKey || '').slice(-4)}
            </span>
          </div>
          <div className="cmw-summary-row">
            <span className="cmw-summary-label">Model ID</span>
            <span>{config.modelId}</span>
          </div>
          {config.maxTokens && (
            <div className="cmw-summary-row">
              <span className="cmw-summary-label">Max Tokens</span>
              <span>{config.maxTokens}</span>
            </div>
          )}
        </div>
        {validationError && <div className="cmw-error">✗ {validationError}</div>}
        <div className="cmw-actions">
          <button className="cmw-btn-secondary" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button className="cmw-btn-primary" onClick={handleManualConfirm} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    );
  };

  const renderErFetching = () => (
    <div className="cmw-step-body">
      {!erFetchError ? (
        <div className="cmw-loading">
          <div className="cmw-spinner" />
          <span>Loading available models from EasyRouter…</span>
        </div>
      ) : (
        <>
          <div className="cmw-error">✗ {erFetchError}</div>
          <div className="cmw-hint">Press Cancel to try again with a different key.</div>
        </>
      )}
      <div className="cmw-actions">
        <button className="cmw-btn-secondary" onClick={onClose}>
          Cancel
        </button>
        {erFetchError && (
          <button className="cmw-btn-primary" onClick={() => setStep('er_apiKey')}>
            Retry
          </button>
        )}
      </div>
    </div>
  );

  const renderErSelect = () => {
    const matched = erModels.filter((m) => erMetadata.has(m.id)).length;
    const filterLower = erFilter.trim().toLowerCase();
    const visible = filterLower
      ? erModels.filter((m) => m.id.toLowerCase().includes(filterLower))
      : erModels;
    const allVisibleSelected =
      visible.length > 0 && visible.every((m) => erSelected.has(m.id));

    const toggle = (id: string) => {
      setErSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    };

    const toggleAll = () => {
      setErSelected((prev) => {
        const next = new Set(prev);
        if (allVisibleSelected) {
          for (const m of visible) next.delete(m.id);
        } else {
          for (const m of visible) next.add(m.id);
        }
        return next;
      });
    };

    return (
      <div className="cmw-step-body cmw-step-body-tall">
        <div className="cmw-er-toolbar">
          <input
            className="cmw-input cmw-input-inline"
            placeholder="Filter models…"
            value={erFilter}
            onChange={(e) => setErFilter(e.target.value)}
          />
          <button
            className="cmw-btn-link"
            onClick={toggleAll}
            type="button"
          >
            {allVisibleSelected ? 'Deselect all (visible)' : 'Select all (visible)'}
          </button>
        </div>
        <div className="cmw-er-list">
          {visible.map((m) => {
            const proto = classifyEasyRouterModel(m.id);
            const meta = erMetadata.get(m.id);
            const ctxTokens =
              typeof meta?.max_context_length === 'number' && meta.max_context_length > 0
                ? meta.max_context_length
                : EASY_ROUTER_DEFAULT_MAX_TOKENS;
            const isDefault = !erMetadata.has(m.id);
            const checked = erSelected.has(m.id);
            return (
              <label
                key={m.id}
                className={`cmw-er-item ${checked ? 'selected' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(m.id)}
                />
                <div className="cmw-er-item-text">
                  <div className="cmw-er-item-id">{m.id}</div>
                  <div className="cmw-er-item-meta">
                    {PROTO_LABEL[proto]} · {formatTokenCount(ctxTokens)}
                    {isDefault ? ' default' : ''} ctx
                  </div>
                </div>
              </label>
            );
          })}
          {visible.length === 0 && (
            <div className="cmw-er-empty">No models match the filter.</div>
          )}
        </div>
        <div className="cmw-er-counter">
          Selected: {erSelected.size} / {erModels.length}. Metadata matched: {matched}/
          {erModels.length} (others use {formatTokenCount(EASY_ROUTER_DEFAULT_MAX_TOKENS)} default).
        </div>
        {validationError && <div className="cmw-error">✗ {validationError}</div>}
        <div className="cmw-actions">
          <button className="cmw-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="cmw-btn-primary"
            onClick={() => {
              if (erSelected.size === 0) {
                setValidationError('Please select at least one model.');
                return;
              }
              setValidationError(null);
              setStep('er_confirm');
            }}
          >
            Review {erSelected.size} model{erSelected.size === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    );
  };

  const renderErConfirm = () => {
    const grouped: Record<CustomModelProvider, string[]> = {
      openai: [],
      'openai-responses': [],
      anthropic: [],
      gemini: [],
    };
    for (const id of erSelected) {
      grouped[classifyEasyRouterModel(id)].push(id);
    }
    return (
      <div className="cmw-step-body">
        <div className="cmw-summary">
          <div className="cmw-summary-row">
            <span className="cmw-summary-label">Provider</span>
            <span>EasyRouter</span>
          </div>
          <div className="cmw-summary-row">
            <span className="cmw-summary-label">API Key</span>
            <span>***{erApiKey.slice(-4)}</span>
          </div>
          {(Object.keys(grouped) as CustomModelProvider[]).map((p) => {
            const list = grouped[p];
            if (!list.length) return null;
            return (
              <div key={p} className="cmw-er-group">
                <div className="cmw-er-group-title">
                  {PROTO_LABEL[p]} ({list.length})
                </div>
                {list.map((id) => {
                  const meta = erMetadata.get(id);
                  const ctxTokens =
                    typeof meta?.max_context_length === 'number' && meta.max_context_length > 0
                      ? meta.max_context_length
                      : EASY_ROUTER_DEFAULT_MAX_TOKENS;
                  const isDefault = !erMetadata.has(id);
                  return (
                    <div key={id} className="cmw-er-group-item">
                      <span>{id}</span>
                      <span className="cmw-muted">
                        {formatTokenCount(ctxTokens)}
                        {isDefault ? ' default' : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {validationError && <div className="cmw-error">✗ {validationError}</div>}
        <div className="cmw-actions">
          <button
            className="cmw-btn-secondary"
            onClick={() => setStep('er_select')}
            disabled={isSaving}
          >
            Back
          </button>
          <button
            className="cmw-btn-primary"
            onClick={handleEasyRouterConfirm}
            disabled={isSaving}
          >
            {isSaving ? 'Saving…' : `Save ${erSelected.size} model${erSelected.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    );
  };

  // ---- Outer modal shell ---------------------------------------------------
  return (
    <div className="cmw-overlay" role="dialog" aria-modal="true">
      <div className="cmw-container">
        <div className="cmw-header">
          <div>
            <div className="cmw-title">✨ Custom Model Configuration</div>
            <div className="cmw-progress">
              Step {stepNumber}/{totalSteps}: {getStepTitle(step)}
            </div>
          </div>
          <button className="cmw-close" onClick={onClose} aria-label="Close" disabled={isSaving}>
            ✕
          </button>
        </div>
        <div className="cmw-description">
          {getStepDescription(step, erSelected.size)}
        </div>

        {step === 'provider' && renderProvider()}
        {(step === 'displayName' ||
          step === 'baseUrl' ||
          step === 'apiKey' ||
          step === 'modelId' ||
          step === 'maxTokens' ||
          step === 'er_apiKey') &&
          renderTextInput()}
        {step === 'confirm' && renderConfirm()}
        {step === 'er_fetching' && renderErFetching()}
        {step === 'er_select' && renderErSelect()}
        {step === 'er_confirm' && renderErConfirm()}
      </div>
    </div>
  );
};
