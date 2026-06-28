/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * setup / BYO-key 图形引导（Issue #7）。
 *
 * 真实向导：品牌供应商下拉 → API key（掩码 + 粘贴）→ 模型 id → 显示名，
 * 本地实时校验，产出与 CLI/server 完全一致的 CustomModelConfig
 * （落盘 `~/.otto-user/custom-models.json`，结构 `{ models, _metadata }`）。
 *
 * 落盘闭环（固定契约，protocol.ts SaveCustomModelMsg）：
 *   submit() → 上层 onSave(payload) 发 `save_custom_model` 帧 →
 *   server 校验 + 原子写盘 → 广播最新 `models_list`（=成功，App 关面板）
 *   或广播 `error(save_failed)`（=失败，App 把文案经 saveError 传回，面板内提示）。
 *   面板本身只负责采集 + 校验 + 提交 + 反映 saving/saveError 态，不直接碰 transport。
 *
 * 仍保留「复制 custom-models.json / 复制 CLI 命令」作为离线兜底路径（不依赖 server）。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelInfo } from 'otto-server';
import {
  PROVIDER_PRESETS,
  PROVIDER_OPTIONS,
  findPreset,
  buildConfig,
  buildSavePayload,
  validateForm,
  buildModelsFileJson,
  buildCliCommand,
  type CustomModelProvider,
  type SetupFormState,
  type SaveCustomModelPayload,
} from './presets.js';

export interface SetupPanelProps {
  /** server 已知的现有模型（get_models 回包），用于展示「已配置」态。 */
  models: ModelInfo[];
  /** 落盘进行中（已发帧、等 models_list / error 裁决）。 */
  saving?: boolean;
  /** 落盘失败文案（save_failed）。null = 无错误。 */
  saveError?: string | null;
  /** 关闭面板。 */
  onClose: () => void;
  /** 提交一个自定义模型（发 `save_custom_model` 帧，由上层裁决成功/失败）。 */
  onSave: (payload: SaveCustomModelPayload) => void;
}

const DEFAULT_PRESET = PROVIDER_PRESETS[0];

function initialForm(): SetupFormState {
  return {
    presetId: DEFAULT_PRESET.id,
    provider: DEFAULT_PRESET.provider,
    baseUrl: DEFAULT_PRESET.baseUrl,
    apiKey: '',
    modelId: '',
    displayName: '',
  };
}

export function SetupPanel({
  models,
  saving = false,
  saveError = null,
  onClose,
  onSave,
}: SetupPanelProps): React.JSX.Element {
  const [form, setForm] = useState<SetupFormState>(initialForm);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [revealKey, setRevealKey] = useState(false);
  const [copied, setCopied] = useState<'json' | 'cli' | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);

  const preset = findPreset(form.presetId) ?? DEFAULT_PRESET;
  const errors = useMemo(() => validateForm(form), [form]);
  const valid = Object.keys(errors).length === 0;
  const cfg = useMemo(() => buildConfig(form), [form]);

  // Esc 关闭。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const patch = (next: Partial<SetupFormState>): void => {
    setForm((f) => ({ ...f, ...next }));
  };

  const selectPreset = (id: string): void => {
    const p = findPreset(id);
    if (!p) return;
    patch({
      presetId: id,
      provider: p.provider,
      // 锁定 baseUrl 的预设直接填官方端点；custom 清空让用户填。
      baseUrl: p.baseUrlLocked ? p.baseUrl : '',
    });
  };

  const markTouched = (field: string): void => {
    setTouched((t) => ({ ...t, [field]: true }));
  };

  // 粘贴：input 原生即支持 Cmd/Ctrl+V；额外提供「从剪贴板粘贴」按钮兜底
  // （某些环境右键菜单缺失时）。
  const pasteKey = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        patch({ apiKey: text.trim() });
        markTouched('apiKey');
      }
    } catch {
      // 剪贴板权限被拒：聚焦输入框让用户手动 Cmd+V。
      keyRef.current?.focus();
    }
  };

  const copy = async (kind: 'json' | 'cli'): Promise<void> => {
    const text =
      kind === 'json' ? buildModelsFileJson(cfg) : buildCliCommand(form);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      // 复制失败静默；用户仍可手动选中文本框。
    }
  };

  const openConsole = (): void => {
    if (preset.keyConsoleUrl) {
      void window.otto?.openExternal?.(preset.keyConsoleUrl);
    }
  };

  const submit = (): void => {
    setTouched({
      modelId: true,
      baseUrl: true,
      apiKey: true,
      displayName: true,
    });
    if (!valid || saving) return;
    // 按固定契约发 `save_custom_model` 帧；成功/失败由上层监听 models_list / error 裁决。
    onSave(buildSavePayload(form));
  };

  const showErr = (field: string): string | undefined =>
    touched[field] ? errors[field] : undefined;

  return (
    <div className="otto-setup-overlay" role="dialog" aria-modal="true">
      <div className="otto-setup">
        <header className="otto-setup__head">
          <div className="otto-setup__brand">
            <span className="otto-setup__wordmark">otto</span>
            <span className="otto-setup__spark" aria-hidden>
              ✦
            </span>
          </div>
          <div className="otto-setup__titles">
            <h2 className="otto-setup__title">配置你的模型</h2>
            <p className="otto-setup__subtitle">
              Otto 自带密钥（BYO-key）：选供应商、粘贴 API key、填模型即可。
            </p>
          </div>
          <button
            type="button"
            className="otto-setup__close"
            onClick={onClose}
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        {models.length > 0 ? (
          <div className="otto-setup__existing">
            <span className="otto-setup__existing-dot" aria-hidden />
            已配置 {models.length} 个模型：
            {models.slice(0, 3).map((m) => (
              <code key={m.id} className="otto-setup__chip">
                {m.displayName}
              </code>
            ))}
            {models.length > 3 ? <span>等</span> : null}
          </div>
        ) : null}

        <div className="otto-setup__body">
          {/* —— 供应商预设 —— */}
          <label className="otto-setup__label">供应商</label>
          <div className="otto-setup__presets">
            {PROVIDER_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={
                  'otto-setup__preset' +
                  (p.id === form.presetId ? ' is-active' : '')
                }
                onClick={() => selectPreset(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset.note ? (
            <p className="otto-setup__hint">{preset.note}</p>
          ) : null}

          {/* —— 协议（仅 custom 暴露）—— */}
          {!preset.baseUrlLocked ? (
            <>
              <label className="otto-setup__label">协议</label>
              <select
                className="otto-setup__select"
                value={form.provider}
                onChange={(e) =>
                  patch({ provider: e.target.value as CustomModelProvider })
                }
              >
                {PROVIDER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </>
          ) : null}

          {/* —— base URL —— */}
          <label className="otto-setup__label">
            接口地址 (base URL)
            {preset.baseUrlLocked ? (
              <span className="otto-setup__locked">官方端点 · 已锁定</span>
            ) : null}
          </label>
          <input
            className={
              'otto-setup__input' + (showErr('baseUrl') ? ' is-error' : '')
            }
            type="text"
            value={form.baseUrl}
            placeholder="https://api.example.com/v1"
            readOnly={preset.baseUrlLocked}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => patch({ baseUrl: e.target.value })}
            onBlur={() => markTouched('baseUrl')}
          />
          {showErr('baseUrl') ? (
            <p className="otto-setup__err">{showErr('baseUrl')}</p>
          ) : null}

          {/* —— API key（掩码 + 粘贴 + 显隐）—— */}
          <label className="otto-setup__label">
            API key
            {preset.keyConsoleUrl ? (
              <button
                type="button"
                className="otto-setup__linkbtn"
                onClick={openConsole}
              >
                去获取 ↗
              </button>
            ) : null}
          </label>
          <div className="otto-setup__keyrow">
            <input
              ref={keyRef}
              className={
                'otto-setup__input otto-setup__keyinput' +
                (showErr('apiKey') ? ' is-error' : '')
              }
              type={revealKey ? 'text' : 'password'}
              value={form.apiKey}
              placeholder={preset.keyHint}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              onChange={(e) => patch({ apiKey: e.target.value })}
              onBlur={() => markTouched('apiKey')}
            />
            <button
              type="button"
              className="otto-setup__iconbtn"
              onClick={() => setRevealKey((v) => !v)}
              aria-label={revealKey ? '隐藏' : '显示'}
              title={revealKey ? '隐藏' : '显示'}
            >
              {revealKey ? '🙈' : '👁'}
            </button>
            <button
              type="button"
              className="otto-setup__iconbtn"
              onClick={() => void pasteKey()}
              title="从剪贴板粘贴"
            >
              粘贴
            </button>
          </div>
          {showErr('apiKey') ? (
            <p className="otto-setup__err">{showErr('apiKey')}</p>
          ) : (
            <p className="otto-setup__hint">
              key 仅写入本机 `~/.otto-user`，不上传任何服务器。
            </p>
          )}

          {/* —— 模型 id —— */}
          <label className="otto-setup__label">模型 id</label>
          <input
            className={
              'otto-setup__input' + (showErr('modelId') ? ' is-error' : '')
            }
            type="text"
            value={form.modelId}
            placeholder={preset.modelHint}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => patch({ modelId: e.target.value })}
            onBlur={() => markTouched('modelId')}
          />
          {preset.exampleModels.length > 0 ? (
            <div className="otto-setup__examples">
              {preset.exampleModels.map((m) => (
                <button
                  key={m}
                  type="button"
                  className="otto-setup__example"
                  onClick={() => patch({ modelId: m })}
                >
                  {m}
                </button>
              ))}
            </div>
          ) : null}
          {showErr('modelId') ? (
            <p className="otto-setup__err">{showErr('modelId')}</p>
          ) : null}

          {/* —— 显示名（可选）—— */}
          <label className="otto-setup__label">显示名（可选）</label>
          <input
            className="otto-setup__input"
            type="text"
            value={form.displayName}
            placeholder={cfg.displayName || '在模型菜单里怎么称呼它'}
            spellCheck={false}
            onChange={(e) => patch({ displayName: e.target.value })}
          />
        </div>

        {/* —— 落盘失败提示（save_failed）—— */}
        {saveError ? (
          <div className="otto-setup__savefail" role="alert">
            <span className="otto-setup__warn" aria-hidden>
              ⚠
            </span>
            <span>{saveError}</span>
          </div>
        ) : null}

        {/* —— 离线兜底：不依赖 server 也能落盘的两条路径 —— */}
        <div className="otto-setup__persist">
          <p className="otto-setup__persist-title">离线兜底（可选）</p>
          <p className="otto-setup__persist-body">
            「完成配置」会直接写入
            <code>~/.otto-user/custom-models.json</code>。若需在别处手动落盘，也可复制：
          </p>
          <div className="otto-setup__copyrow">
            <button
              type="button"
              className="otto-setup__copybtn"
              disabled={!valid}
              onClick={() => void copy('json')}
            >
              {copied === 'json' ? '已复制 JSON ✓' : '复制 custom-models.json'}
            </button>
            <button
              type="button"
              className="otto-setup__copybtn"
              disabled={!valid}
              onClick={() => void copy('cli')}
            >
              {copied === 'cli' ? '已复制命令 ✓' : '复制 otto setup 命令'}
            </button>
          </div>
        </div>

        <footer className="otto-setup__foot">
          <button
            type="button"
            className="otto-setup__btn otto-setup__btn--ghost"
            onClick={onClose}
          >
            稍后
          </button>
          <button
            type="button"
            className="otto-setup__btn otto-setup__btn--primary"
            disabled={!valid || saving}
            onClick={submit}
            title={
              valid ? '保存并启用该模型' : '请先补全必填项'
            }
          >
            {saving ? (
              <>
                <span className="otto-setup__spinner" aria-hidden />
                保存中…
              </>
            ) : (
              '完成配置'
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}
