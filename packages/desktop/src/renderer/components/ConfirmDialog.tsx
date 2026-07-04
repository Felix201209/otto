/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 可复用的居中确认弹窗（modal）。取代原先挤在列表项里的 inline 二次确认，
 * 用于「删除对话」这类不可逆操作的二次确认。
 *
 * 交互：
 *   - 半透明遮罩 + 居中卡片；点遮罩 = 取消（用 onMouseDown 判定，避免卡片内起手、
 *     遮罩上松手的拖拽被误判为取消）。
 *   - Esc = 取消、Enter = 确认。
 *   - **焦点默认落「取消」按钮**，防手滑连按误删。
 *   - Tab / Shift+Tab 在取消 / 确认两钮间循环（焦点陷阱），焦点不逃出弹窗。
 *   - 打开时记住触发元素，关闭后把焦点还回去。
 *
 * 无障碍：role=dialog + aria-modal + aria-labelledby（标题）+ aria-describedby（正文）。
 * 视觉全走 var(--otto-*) token，随暗色主题自动切换；圆角 / 阴影对齐现有浮层（lightbox）风格。
 */

import React, { useEffect, useId, useRef } from 'react';

interface ConfirmDialogProps {
  /** 是否展开弹窗。false 时不渲染任何节点。 */
  open: boolean;
  /** 弹窗标题（如「删除对话」）。 */
  title: string;
  /** 正文说明（如「确定删除「X」吗？此操作不可撤销。」）。 */
  message: string;
  /** 确认按钮文案，默认「删除」。 */
  confirmText?: string;
  /** 取消按钮文案，默认「取消」。 */
  cancelText?: string;
  /** 危险操作：确认钮红色（默认 true）。false 时确认钮走中性主色。 */
  danger?: boolean;
  /** 点确认时回调。 */
  onConfirm: () => void;
  /** 点取消 / 点遮罩 / Esc 时回调。 */
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '删除',
  cancelText = '取消',
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element | null {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // 打开前的焦点元素，关闭后还回，避免焦点丢到 body。
  const triggerRef = useRef<Element | null>(null);
  // 唯一 id：把标题 / 正文关联到 dialog 的 aria-labelledby / describedby。
  const uid = useId();
  const titleId = `${uid}-title`;
  const descId = `${uid}-desc`;

  // 打开：记住触发元素并把焦点落到「取消」钮（防误删）；关闭：焦点还回触发元素。
  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      // 触发元素仍在文档里才还焦点（删除后原项可能已卸载）。
      const el = triggerRef.current;
      if (el instanceof HTMLElement && document.contains(el)) el.focus();
    };
  }, [open]);

  if (!open) return null;

  // 键盘：Esc 取消、Enter 确认、Tab 在两钮间做焦点陷阱循环。
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onConfirm();
    } else if (e.key === 'Tab') {
      // 只有取消 / 确认两个可聚焦项，手动在二者间循环，焦点不逃出弹窗。
      e.preventDefault();
      const active = document.activeElement;
      if (active === cancelRef.current) confirmRef.current?.focus();
      else cancelRef.current?.focus();
    }
  };

  return (
    <div
      className="otto-confirm-overlay"
      // 用 onMouseDown（而非 onClick）判定点遮罩=取消：避免从卡片内按下、
      // 拖到遮罩上松手被误当成取消。仅当起手点就在遮罩本身时才关。
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      // 模态语义：弹窗内的点击 / 键盘不漏给背后的元素。弹窗常挂在会话项等
      // 可点容器内部，DOM 上是其子节点；不拦截的话 click / Enter 会冒泡触发
      // 背后容器的 onClick / onKeyDown（如误选中正被删除的会话）。
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="otto-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onKeyDown={onKeyDown}
        // 卡片内点击不冒泡到遮罩（虽用 mousedown 判定，这里再兜一层）。
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="otto-confirm__title" id={titleId}>
          {title}
        </h2>
        <p className="otto-confirm__message" id={descId}>
          {message}
        </p>
        <div className="otto-confirm__actions">
          <button
            ref={cancelRef}
            type="button"
            className="otto-confirm__cancel"
            onClick={onCancel}
          >
            {cancelText}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`otto-confirm__confirm${
              danger ? ' otto-confirm__confirm--danger' : ''
            }`}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
