/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 底部输入区。spec §底部输入区：
 *   圆角输入框（占位「给 Otto 发送消息...」）+ model 选择器 pill（反映真实生效模型 ▾）
 *   + 回形针附件 + amber 圆形发送（↑），生成中发送按钮变「停止」。
 *
 * model pill 点击弹出可用模型菜单（来自协议 models_list）。pill 文字取 currentModel
 * （models_list/currentModel 帧）对应名，无则回退首个可用模型，不硬编码模型名。
 * Enter 发送、Shift+Enter 换行。slash 命令在 SetupPanel 路由的命令面板里（Issue #7）。
 */

import React, { useRef, useState } from 'react';
import type { ModelInfo } from 'otto-server';
import {
  IconChevronDown,
  IconPaperclip,
  IconArrowUp,
  IconCheck,
  IconSettings,
  IconStop,
} from './icons.js';

interface ComposerProps {
  models: ModelInfo[];
  currentModel: string | null;
  /** 当前选中会话 id：切换会话后据此自动聚焦 textarea，避免手动再点一下。 */
  sessionId?: string | null;
  /** 整体禁用（无选中会话）：textarea 与发送按钮都禁用。 */
  disabled?: boolean;
  /**
   * 流式生成中。busy 时 textarea 仍可输入下一条，发送按钮变「停止」按钮调 onCancel。
   * 与 disabled 解耦：disabled 锁全部，busy 只改发送按钮形态。
   */
  busy?: boolean;
  onSend: (text: string) => void;
  /** 中止当前流式生成（busy 时停止按钮调用）。 */
  onCancel?: () => void;
  onSetModel: (model: string) => void;
  /** 受控初值（空态示例胶囊点击后注入草稿）。 */
  draft?: string;
  /** 注入序号：每次递增触发再注入（支持连点同一胶囊）。 */
  draftNonce?: number;
  /** 「在设置里管理模型」入口（接 Issue #7）。未传则不渲染该入口。 */
  onManageModels?: () => void;
}

export function Composer({
  models,
  currentModel,
  sessionId,
  disabled,
  busy = false,
  onSend,
  onCancel,
  onSetModel,
  draft,
  draftNonce,
  onManageModels,
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 空态示例胶囊注入草稿：填入并聚焦、自适应高度。draftNonce 递增触发再注入。
  React.useEffect(() => {
    if (draft == null || draft === '') return;
    setText(draft);
    const el = taRef.current;
    if (el) {
      el.focus();
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftNonce]);

  // 切换/新建会话就绪后自动聚焦 textarea，省去手动再点一下。
  // 仅在有会话（sessionId）且未禁用时聚焦；不依赖 busy，避免打断发送流。
  React.useEffect(() => {
    if (disabled || sessionId == null) return;
    taRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, disabled]);

  // 生成中（busy）不发送，但 textarea 仍可输入下一条；无会话（disabled）才整体锁死。
  const canSend = text.trim().length > 0 && !disabled && !busy;

  const submit = () => {
    if (!canSend) return;
    onSend(text);
    setText('');
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const autoGrow = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };

  // 反映真实生效模型：优先 currentModel（来自 models_list/currentModel 帧）对应的 displayName，
  // 否则回退到首个可用模型的名字，最后才用「选择模型」占位。
  // 不再硬编码具体模型名（如 'claude-opus-4'）——BYO-key 用户可能根本没配 Claude。
  const modelLabel =
    models.find((m) => m.id === currentModel)?.displayName ??
    currentModel ??
    models[0]?.displayName ??
    '选择模型';

  return (
    <div className={`otto-composer${disabled ? ' is-disabled' : ''}`}>
      <div className="otto-composer__inner">
        <textarea
          ref={taRef}
          className="otto-composer__textarea"
          placeholder="给 Otto 发送消息..."
          rows={1}
          value={text}
          onChange={autoGrow}
          onKeyDown={onKeyDown}
          // 生成中仍可输入下一条；仅无会话（disabled）时锁死。
          disabled={disabled}
        />
        <div className="otto-composer__bar">
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="otto-modelpill"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
            >
              {modelLabel}
              <IconChevronDown size={14} className="otto-modelpill__chev" />
            </button>
            {menuOpen ? (
              <ModelMenu
                models={models}
                current={currentModel}
                onPick={(id) => {
                  onSetModel(id);
                  setMenuOpen(false);
                }}
                onClose={() => setMenuOpen(false)}
                onManage={onManageModels}
              />
            ) : null}
          </div>

          <button
            type="button"
            className="otto-attach"
            title="附件（暂未支持）"
            aria-label="附件（暂未支持）"
            disabled
          >
            <IconPaperclip size={17} />
          </button>

          {busy && onCancel ? (
            <button
              type="button"
              className="otto-send otto-send--stop"
              title="停止生成"
              aria-label="停止生成"
              onClick={onCancel}
            >
              <IconStop size={15} />
            </button>
          ) : (
            <button
              type="button"
              className="otto-send"
              title="发送"
              aria-label="发送"
              disabled={!canSend}
              onClick={submit}
            >
              <IconArrowUp size={17} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ModelMenu({
  models,
  current,
  onPick,
  onClose,
  onManage,
}: {
  models: ModelInfo[];
  current: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
  onManage?: () => void;
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击菜单外关闭 + Esc 关闭。
  React.useEffect(() => {
    const onDoc = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 方向键在选项间移动焦点（role=listbox 名副其实）。
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '.otto-modelmenu__item',
      ) ?? [],
    );
    if (items.length === 0) return;
    const idx = items.findIndex((el) => el === document.activeElement);
    const next =
      e.key === 'ArrowDown'
        ? items[(idx + 1 + items.length) % items.length]
        : items[(idx - 1 + items.length) % items.length];
    next?.focus();
  };

  return (
    <div
      ref={menuRef}
      className="otto-modelmenu"
      role="listbox"
      aria-label="选择模型"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onMenuKeyDown}
    >
      {models.length === 0 ? (
        <div className="otto-modelmenu__empty">
          暂无可用模型，先在「设置」里配置 BYO-key
        </div>
      ) : (
        models.map((m) => {
          const active = m.id === current;
          return (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={active}
              className={`otto-modelmenu__item${
                active ? ' otto-modelmenu__item--active' : ''
              }`}
              onClick={() => onPick(m.id)}
            >
              <span className="otto-modelmenu__check">
                {active ? <IconCheck size={15} /> : null}
              </span>
              <span className="otto-modelmenu__text">
                <span className="otto-modelmenu__name">{m.displayName}</span>
                {m.provider ? (
                  <span className="otto-modelmenu__provider">{m.provider}</span>
                ) : null}
              </span>
            </button>
          );
        })
      )}
      {onManage ? (
        <>
          <div className="otto-modelmenu__sep" />
          <button
            type="button"
            className="otto-modelmenu__manage"
            onClick={onManage}
          >
            <IconSettings size={14} />
            在设置里管理模型
          </button>
        </>
      ) : null}
    </div>
  );
}
