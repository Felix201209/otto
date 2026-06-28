/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 底部输入区。spec §底部输入区：
 *   圆角输入框（占位「给 Otto 发送消息...」）+ model 选择器 pill（claude-opus-4 ▾）
 *   + 回形针附件 + amber 圆形发送（↑）。
 *
 * model pill 点击弹出可用模型菜单（来自协议 models_list）。Enter 发送、
 * Shift+Enter 换行。slash 命令在 SetupPanel 路由的命令面板里（Issue #7）。
 */

import React, { useRef, useState } from 'react';
import type { ModelInfo } from 'otto-server';
import {
  IconChevronDown,
  IconPaperclip,
  IconArrowUp,
  IconCheck,
  IconSettings,
} from './icons.js';

interface ComposerProps {
  models: ModelInfo[];
  currentModel: string | null;
  disabled?: boolean;
  onSend: (text: string) => void;
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
  disabled,
  onSend,
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

  const canSend = text.trim().length > 0 && !disabled;

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

  const modelLabel =
    models.find((m) => m.id === currentModel)?.displayName ??
    currentModel ??
    'claude-opus-4';

  return (
    <div className="otto-composer">
      <div className="otto-composer__inner">
        <textarea
          ref={taRef}
          className="otto-composer__textarea"
          placeholder="给 Otto 发送消息..."
          rows={1}
          value={text}
          onChange={autoGrow}
          onKeyDown={onKeyDown}
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
            title="附件"
            aria-label="附件"
          >
            <IconPaperclip size={17} />
          </button>

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
