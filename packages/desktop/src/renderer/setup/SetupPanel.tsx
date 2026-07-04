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
  effectiveModelIds,
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
    selectedModels: [],
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
  /** 对话框根容器（焦点陷阱以它为边界）。 */
  const dialogRef = useRef<HTMLDivElement>(null);
  /** 打开前的焦点元素，关闭时还回。 */
  const triggerRef = useRef<HTMLElement | null>(null);

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

  // 焦点管理（无障碍：role=dialog aria-modal 的语义承诺）：
  //   1. 打开时把焦点移进对话框（API key 输入框），并记住触发它的元素。
  //   2. 背景内容（.otto-app 下除本 overlay 外的兄弟）加 inert + aria-hidden，
  //      让 Tab/读屏都困在对话框内（焦点陷阱在 onKeyDown 里补 Tab 循环）。
  //   3. 卸载时撤销 inert/aria-hidden，并把焦点还回触发元素。
  useEffect(() => {
    triggerRef.current = (document.activeElement as HTMLElement | null) ?? null;
    // 首个可交互元素：API key 输入框（向导核心动作）。
    keyRef.current?.focus();

    const overlay = dialogRef.current?.closest('.otto-setup-overlay');
    const appRoot = overlay?.parentElement ?? null;
    const hidden: HTMLElement[] = [];
    if (appRoot) {
      for (const child of Array.from(appRoot.children)) {
        if (child === overlay || !(child instanceof HTMLElement)) continue;
        child.setAttribute('inert', '');
        child.setAttribute('aria-hidden', 'true');
        hidden.push(child);
      }
    }

    return () => {
      for (const el of hidden) {
        el.removeAttribute('inert');
        el.removeAttribute('aria-hidden');
      }
      // 焦点还回触发元素（若仍在文档内）。
      const trigger = triggerRef.current;
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, []);

  // 焦点陷阱：Tab/Shift+Tab 在对话框可聚焦元素间循环，不穿出去。
  const onDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const focusables = Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !root.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };

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
      // 换供应商 → 清空已选模型（不同家的模型 id 不通用）。
      selectedModels: [],
      modelId: '',
    });
  };

  /** 勾选 / 取消一个示例模型（进出 selectedModels）。 */
  const toggleModel = (id: string): void => {
    setForm((f) => ({
      ...f,
      selectedModels: f.selectedModels.includes(id)
        ? f.selectedModels.filter((m) => m !== id)
        : [...f.selectedModels, id],
    }));
    markTouched('modelId');
  };

  /** 把输入框里的自定义模型 id 加入已选集合，并清空输入框。 */
  const addTypedModel = (): void => {
    const id = form.modelId.trim();
    if (!id) return;
    setForm((f) => ({
      ...f,
      modelId: '',
      selectedModels: f.selectedModels.includes(id)
        ? f.selectedModels
        : [...f.selectedModels, id],
    }));
    markTouched('modelId');
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
      <div className="otto-setup" ref={dialogRef} onKeyDown={onDialogKeyDown}>
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

          {/* —— 模型（可多选：填一次 key 批量加入）—— */}
          <label className="otto-setup__label">
            模型
            <span className="otto-setup__locked">
              可多选 · 填一次 key 全部加入
            </span>
          </label>

          {/* 示例模型：点击勾选 / 取消 */}
          {preset.exampleModels.length > 0 ? (
            <div className="otto-setup__examples">
              {preset.exampleModels.map((m) => {
                const on = form.selectedModels.includes(m);
                return (
                  <button
                    key={m}
                    type="button"
                    className={
                      'otto-setup__example' + (on ? ' is-selected' : '')
                    }
                    onClick={() => toggleModel(m)}
                  >
                    {on ? '✓ ' : '+ '}
                    {m}
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* 自定义模型 id：输入 + 添加（回车也可） */}
          <div className="otto-setup__keyrow">
            <input
              className={
                'otto-setup__input' + (showErr('modelId') ? ' is-error' : '')
              }
              type="text"
              value={form.modelId}
              placeholder={`${preset.modelHint}（回车或点添加）`}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => patch({ modelId: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTypedModel();
                }
              }}
              onBlur={() => markTouched('modelId')}
            />
            <button
              type="button"
              className="otto-setup__iconbtn"
              onClick={addTypedModel}
              disabled={!form.modelId.trim()}
            >
              添加
            </button>
          </div>

          {/* 已选模型 chips（可删） */}
          {form.selectedModels.length > 0 ? (
            <div className="otto-setup__chosen">
              {form.selectedModels.map((m) => (
                <span key={m} className="otto-setup__chosen-chip">
                  {m}
                  <button
                    type="button"
                    className="otto-setup__chosen-x"
                    onClick={() => toggleModel(m)}
                    aria-label={`移除 ${m}`}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {showErr('modelId') ? (
            <p className="otto-setup__err">{showErr('modelId')}</p>
          ) : null}

          {/* —— 显示名（仅当最终恰好 1 个模型时）—— */}
          {effectiveModelIds(form).length <= 1 ? (
            <>
              <label className="otto-setup__label">显示名（可选）</label>
              <input
                className="otto-setup__input"
                type="text"
                value={form.displayName}
                placeholder={cfg.displayName || '在模型菜单里怎么称呼它'}
                spellCheck={false}
                onChange={(e) => patch({ displayName: e.target.value })}
              />
            </>
          ) : (
            <p className="otto-setup__hint">
              已选 {effectiveModelIds(form).length} 个模型，将各自以模型 id
              命名、共用这一个 key 一次性加入。
            </p>
          )}
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
          <p className="otto-setup__hint">
            已用占位符代替 API Key，粘贴后请自行填入。
          </p>
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
