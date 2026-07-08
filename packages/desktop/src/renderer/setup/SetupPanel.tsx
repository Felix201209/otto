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
  IconClose,
  IconEye,
  IconEyeOff,
  IconSparkle,
  IconWarning,
  IconChevron,
} from '../components/icons.js';
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
  /** 「离线兜底」高级块折叠态：默认收起（对新手是噪音），点击展开。 */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** 「本地测试模式」块折叠态：默认收起；面向开发者，折叠对普通用户无干扰。 */
  const [localTestOpen, setLocalTestOpen] = useState(false);
  /**
   * 本地测试代理地址（不落盘，仅当前会话生效）。
   * 用途：无需连接组织服务器，直接把 customProxyServerUrl 指向本机 localhost otto-server
   * 的 HTTP 端口，配合 BYO-key 自定义模型本地测试整条链路。
   *
   * 使用步骤：
   *   1. 先在终端起本地 server：  OTTO_SERVER_MOCK=1 node packages/server/dist/bin.js start
   *      （或用真实 BYO-key 不加 MOCK=1 也可）
   *   2. 在此处填入 http://127.0.0.1:7637  并点「应用本地地址」
   *   3. 重新打开对话，请求将走本地 server 而非远程组织服务器
   *   4. 测试完毕后点「清除」即可恢复默认
   */
  const [localTestUrl, setLocalTestUrl] = useState<string>(() => {
    try {
      return sessionStorage.getItem('otto:local-test-url') || '';
    } catch {
      return '';
    }
  });
  const [localTestApplied, setLocalTestApplied] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem('otto:local-test-applied') === '1';
    } catch {
      return false;
    }
  });
  const keyRef = useRef<HTMLInputElement>(null);

  const preset = findPreset(form.presetId) ?? DEFAULT_PRESET;

  // ── 飞书一键连接控制（桌面端暂未接管 daemon）──
  // 诚实说明来自 main 的 feishuStatus handler（返回「桌面端暂不支持、请用 CLI」）。
  // 桌面端并未托管进程，因此不提供启停按钮、不假报「运行中」；仅展示这段说明。
  const [fsStatus, setFsStatus] = useState<string>(
    '桌面端暂不支持在此一键启停飞书守护进程，请在终端使用：otto feishu daemon start / stop / status。',
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await window.otto?.feishuStatus();
        if (!cancelled && res?.text) setFsStatus(res.text);
      } catch {
        // 读取失败保留默认诚实说明。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  // 打开设置页即把焦点落到 API key 输入框（向导核心动作）。
  // 页面化后不再需要遮罩焦点陷阱 / inert 隐藏兄弟节点。
  useEffect(() => {
    keyRef.current?.focus();
  }, []);

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

  /** 应用本地测试地址：通知 app→server 用 customProxyServerUrl 郤盖默认连接。 */
  const applyLocalTestUrl = (): void => {
    const url = localTestUrl.trim().replace(/\/+$/, '');
    if (!url || !/^https?:\/\//i.test(url)) return;
    try {
      sessionStorage.setItem('otto:local-test-url', url);
      sessionStorage.setItem('otto:local-test-applied', '1');
    } catch {
      /* storage 不可用时静默 */
    }
    setLocalTestApplied(true);
    // 通过 IPC 通知主进程把 customProxyServerUrl 和 OTTO_SERVER_URL 郤盖到 localTestUrl
    void window.otto?.setLocalTestUrl?.(url);
  };

  /** 清除本地测试：恢复默认连接。 */
  const clearLocalTestUrl = (): void => {
    try {
      sessionStorage.removeItem('otto:local-test-url');
      sessionStorage.removeItem('otto:local-test-applied');
    } catch {
      /* storage 不可用时静默 */
    }
    setLocalTestApplied(false);
    void window.otto?.setLocalTestUrl?.('');
  };

  const showErr = (field: string): string | undefined =>
    touched[field] ? errors[field] : undefined;

  return (
    <section className="otto-setup-page" aria-label="配置你的模型">
      <div className="otto-setup">
        <header className="otto-setup__head">
          <div className="otto-setup__brand">
            <span className="otto-setup__wordmark">otto</span>
            <span className="otto-setup__spark" aria-hidden>
              <IconSparkle size={10} />
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
            aria-label="返回对话"
            title="返回对话"
          >
            <IconClose size={15} />
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
              className="otto-setup__iconbtn otto-setup__iconbtn--icon"
              onClick={() => setRevealKey((v) => !v)}
              aria-label={revealKey ? '隐藏' : '显示'}
              title={revealKey ? '隐藏' : '显示'}
            >
              {revealKey ? <IconEyeOff size={15} /> : <IconEye size={15} />}
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
                    <IconClose size={10} />
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
              <IconWarning size={15} />
            </span>
            <span>{saveError}</span>
          </div>
        ) : null}


        {/* —— 飞书一键控制面板（桌面端暂未接管 daemon，诚实禁用）—— */}
        <div className="otto-setup__section" style={{ marginTop: '24px', padding: '16px', background: 'var(--otto-sidebar-bg)', borderRadius: 'var(--otto-radius)' }}>
          <label className="otto-setup__label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span>飞书双向控制与常驻守护</span>
            <span className="otto-badge otto-badge--feishu" style={{ fontSize: '11px' }}>
              即将支持
            </span>
          </label>
          <p className="otto-setup__hint" style={{ marginBottom: '14px', whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>
            {fsStatus}
          </p>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              type="button"
              disabled
              className="otto-setup__btn otto-setup__btn--ghost"
              title="桌面端暂不支持一键启停，请在终端使用 otto feishu daemon"
              style={{ flex: 1, padding: '10px', height: '38px', borderRadius: 'var(--otto-radius-sm)', fontWeight: 600, fontSize: '12px', opacity: 0.6, cursor: 'not-allowed' }}
            >
              飞书一键控制（即将支持）
            </button>
            <button
              type="button"
              className="otto-setup__btn otto-setup__btn--ghost"
              style={{ flex: 1, padding: '10px', height: '38px', borderRadius: 'var(--otto-radius-sm)', fontWeight: 600, fontSize: '12px' }}
              onClick={() => void window.otto?.openExternal('https://open.feishu.cn')}
            >
              飞书开发者平台 ↗
            </button>
          </div>
        </div>

        {/* ——「本地测试模式」区块：默认折叠，面向开发者 —— */}
        <div className="otto-setup__advanced" style={{ marginTop: '8px' }}>
          <button
            type="button"
            className="otto-setup__advanced-toggle"
            onClick={() => setLocalTestOpen((v) => !v)}
            aria-expanded={localTestOpen}
          >
            <IconChevron
              size={13}
              className={
                'otto-setup__advanced-chev' +
                (localTestOpen ? ' otto-setup__advanced-chev--open' : '')
              }
            />
            本地测试模式（开发者）
            {localTestApplied ? (
              <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--otto-accent)', fontWeight: 700 }}>
                • 已应用
              </span>
            ) : null}
          </button>
          {localTestOpen ? (
            <div className="otto-setup__persist" style={{ marginTop: '8px' }}>
              <p className="otto-setup__persist-body" style={{ marginBottom: '10px', lineHeight: '1.6' }}>
                无需连接远程组织服务器，把请求指向本机运行的 otto-server。
                <br />
                <span style={{ color: 'var(--otto-text-secondary)', fontSize: '11px' }}>
                  先在终端起本地 server：　
                  <code style={{ fontFamily: 'var(--otto-font-mono)', fontSize: '10.5px', background: 'var(--otto-surface)', padding: '1px 4px', borderRadius: '3px' }}>
                    OTTO_SERVER_MOCK=1 node packages/server/dist/bin.js start
                  </code>
                </span>
                <br />
                <span style={{ color: 'var(--otto-text-secondary)', fontSize: '11px' }}>
                  单配了 BYO-key 模型时去掉　
                  <code style={{ fontFamily: 'var(--otto-font-mono)', fontSize: '10.5px', background: 'var(--otto-surface)', padding: '1px 4px', borderRadius: '3px' }}>
                    OTTO_SERVER_MOCK=1
                  </code>
                  可测真实推理。
                </span>
              </p>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <input
                  className="otto-setup__input"
                  type="text"
                  value={localTestUrl}
                  placeholder="本地 server 地址，如 http://127.0.0.1:7637"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(e) => {
                    setLocalTestUrl(e.target.value);
                    if (localTestApplied) setLocalTestApplied(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); applyLocalTestUrl(); }
                  }}
                  style={{ flex: 1, fontSize: '12px' }}
                />
                <button
                  type="button"
                  className="otto-setup__iconbtn"
                  onClick={applyLocalTestUrl}
                  disabled={!localTestUrl.trim()}
                  style={{ whiteSpace: 'nowrap', fontSize: '12px' }}
                >
                  应用地址
                </button>
                {localTestApplied ? (
                  <button
                    type="button"
                    className="otto-setup__iconbtn"
                    onClick={clearLocalTestUrl}
                    style={{ whiteSpace: 'nowrap', fontSize: '12px', color: 'var(--otto-text-secondary)' }}
                  >
                    清除
                  </button>
                ) : null}
              </div>
              {localTestApplied ? (
                <p className="otto-setup__hint" style={{ marginTop: '8px', color: 'var(--otto-accent)' }}>
                  ✅ 已应用本地测试地址：{localTestUrl}，下次对话请求将走本机 server。
                </p>
              ) : (
                <p className="otto-setup__hint" style={{ marginTop: '6px' }}>
                  应用后下次对话请求将通过本机 server（而非连接远程组织服务器）。清除即可恢复默认。
                </p>
              )}
            </div>
          ) : null}
        </div>

        {/* —— 离线兜底：默认折叠成一行「高级」，对新手隐去噪音；展开才露两条复制路径 —— */}
        <div className="otto-setup__advanced">
          <button
            type="button"
            className="otto-setup__advanced-toggle"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
          >
            <IconChevron
              size={13}
              className={
                'otto-setup__advanced-chev' +
                (advancedOpen ? ' otto-setup__advanced-chev--open' : '')
              }
            />
            高级：手动落盘方式
          </button>
          {advancedOpen ? (
            <div className="otto-setup__persist">
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
                  {copied === 'json'
                    ? '已复制 JSON ✓'
                    : '复制 custom-models.json'}
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
          ) : null}
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
    </section>
  );
}
