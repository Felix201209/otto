/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 斜杠命令面板。textarea 里「以 `/` 开头且在首行」时浮出的轻量命令下拉。
 *
 * 结构复刻 Composer 里的 ModelMenu（浮层 + 选中高亮 + Esc 关闭），但键盘导航
 * 刻意**不**把焦点移进面板：斜杠命令场景下用户还在 textarea 里打字（边打边过滤），
 * 焦点必须留在 textarea。因此方向键 / Enter / Tab / Esc 的分流都由 Composer 的
 * textarea onKeyDown 统一处理，本组件只负责：渲染过滤后的列表、高亮 activeIndex、
 * 支持鼠标点击执行。选中命令即本地执行（onExecute），不经过 sendMessage 发给模型。
 *
 * filterCommands 抽成纯函数导出，供 Composer 复用与单测直接断言。
 */

import React, { useEffect, useRef } from 'react';

/** 一条斜杠命令的定义。id 即命令名（不含前导 `/`）。 */
export interface SlashCommand {
  /** 命令名，如 'new'（面板显示为 `/new`），也是过滤匹配的键。 */
  id: string;
  /** 一句话说明，右侧灰字。 */
  description: string;
  /** 本地命令走 local；prompt 命令点击后直接发送给 Otto 执行。 */
  action?: 'local' | 'prompt';
  /** action=prompt 时发送给 Otto 的完整指令。 */
  prompt?: string;
}

/**
 * 按输入过滤命令。规则：
 *   - 只有首行、以 `/` 开头才算命令输入（是否命中由调用方 parseSlashQuery 判定，
 *     这里只接已剥掉前导 `/` 的 query）。
 *   - query 为空（刚敲下 `/`）→ 返回全部命令。
 *   - 否则按命令名「前缀」匹配（大小写不敏感），保持定义顺序。
 * 前缀匹配而非模糊匹配：命令集很小，前缀直觉且不会误命中。
 */
export function filterCommands(
  commands: readonly SlashCommand[],
  query: string,
): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...commands];
  return commands.filter((c) => c.id.toLowerCase().startsWith(q));
}

/**
 * 从 textarea 全文解析出斜杠命令查询。命中「命令输入态」的条件（与需求一致）：
 *   - 文本以 `/` 开头；
 *   - 且 `/` 处于首行（即 `/` 之前、以及 query 内部都不含换行）。
 * 命中返回去掉前导 `/` 的 query 字符串；不命中返回 null（面板应关闭）。
 * 注意：一旦用户在首行输入了空格（如 `/model 之后再打字`），仍按 query 处理，
 * 由 filterCommands 的 trim + 前缀匹配决定是否还有候选。
 */
export function parseSlashQuery(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const rest = text.slice(1);
  // `/` 必须在首行：query 内不能有换行（有换行说明已经在写多行正文，不是命令）。
  if (rest.includes('\n')) return null;
  return rest;
}

interface SlashCommandsProps {
  /** 已按当前 query 过滤后的命令列表。空列表时调用方应直接不渲染本组件。 */
  commands: SlashCommand[];
  /** 当前高亮项下标（受控，由 Composer 的方向键逻辑维护）。 */
  activeIndex: number;
  /** 鼠标点击某条命令 → 执行它。 */
  onExecute: (command: SlashCommand) => void;
  /** 鼠标悬停某条 → 同步高亮下标，避免键鼠高亮打架。 */
  onHover: (index: number) => void;
  /** 请求关闭面板（点击面板外 / Esc）。 */
  onClose: () => void;
}

export function SlashCommands({
  commands,
  activeIndex,
  onExecute,
  onHover,
  onClose,
}: SlashCommandsProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);

  // 点击面板外关闭（Esc 由 textarea onKeyDown 处理，焦点在 textarea 上）。
  useEffect(() => {
    const onDoc = () => onClose();
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [onClose]);

  // 高亮项滚动进视野（命令多到需要滚动时）。
  // scrollIntoView 在部分测试环境（jsdom）未实现，存在才调用，避免抛错。
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      '.otto-slashmenu__item--active',
    );
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div
      ref={listRef}
      id="otto-slashmenu"
      className="otto-slashmenu"
      role="listbox"
      aria-label="斜杠命令"
      // 阻止冒泡，避免点击面板本身触发上面的「点击面板外关闭」。
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        // 防止点击时 textarea 失焦（保持输入焦点，让执行后能继续打字）。
        e.preventDefault();
      }}
    >
      {commands.map((c, i) => {
        const active = i === activeIndex;
        return (
          <button
            key={c.id}
            type="button"
            role="option"
            aria-selected={active}
            className={`otto-slashmenu__item${
              active ? ' otto-slashmenu__item--active' : ''
            }`}
            onMouseEnter={() => onHover(i)}
            onClick={() => onExecute(c)}
          >
            <span className="otto-slashmenu__name">/{c.id}</span>
            <span className="otto-slashmenu__desc">{c.description}</span>
          </button>
        );
      })}
    </div>
  );
}
