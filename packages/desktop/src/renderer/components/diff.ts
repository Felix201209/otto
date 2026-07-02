/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 轻量 unified-diff 解析（自带，不引 webview DiffRenderer 的庞大依赖树）。
 *
 * 只解析渲染编辑文件卡所需的最小信息：每行 type（add/del/context/hunk）+
 * 旧/新行号。覆盖 spec 的 diff 视图：
 *   - hunk 头 `@@ -45,15 +45,10 @@ ...`
 *   - 删除行（`-` 前缀，红底）/ 新增行（`+` 前缀，绿底）/ 上下文行（空格前缀）。
 *
 * 行号推进规则遵循标准 unified diff：
 *   context → old/new 都 +1；del → 只 old +1；add → 只 new +1。
 */

export type DiffLineType = 'add' | 'del' | 'context' | 'hunk' | 'meta';

export interface DiffLine {
  type: DiffLineType;
  /** 旧文件行号（add 行无）。 */
  oldLine?: number;
  /** 新文件行号（del 行无）。 */
  newLine?: number;
  /** 行内容（已去掉前缀符号）。 */
  content: string;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export interface ParsedDiff {
  lines: DiffLine[];
  stats: DiffStats;
}

const HUNK_RE = /^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/;

/**
 * 解析 unified diff 文本为带行号的行数组。
 * 容错：空输入 / 无 hunk 头时，把每行当 context（仍可读）。
 */
export function parseDiff(raw: string): ParsedDiff {
  const out: DiffLine[] = [];
  const stats: DiffStats = { added: 0, removed: 0 };
  if (!raw) return { lines: out, stats };

  const rows = raw.replace(/\r\n/g, '\n').split('\n');
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const row of rows) {
    // 文件头元信息行：跳过显示但保留为 meta（如 ---/+++/diff --git）
    if (
      row.startsWith('--- ') ||
      row.startsWith('+++ ') ||
      row.startsWith('diff --git') ||
      row.startsWith('index ')
    ) {
      continue;
    }

    const hunk = HUNK_RE.exec(row);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      inHunk = true;
      out.push({ type: 'hunk', content: row });
      continue;
    }

    if (!inHunk) {
      // 还没遇到 hunk 头：按上下文兜底渲染，不丢内容。
      out.push({ type: 'context', content: row });
      continue;
    }

    // `\ No newline at end of file` 标记行：非内容行，跳过且不推进行号。
    if (row.startsWith('\\')) {
      continue;
    }

    const marker = row[0];
    const content = row.slice(1);
    if (marker === '+') {
      out.push({ type: 'add', newLine: newNo, content });
      newNo += 1;
      stats.added += 1;
    } else if (marker === '-') {
      out.push({ type: 'del', oldLine: oldNo, content });
      oldNo += 1;
      stats.removed += 1;
    } else {
      // 空格前缀或空行 = 上下文
      out.push({ type: 'context', oldLine: oldNo, newLine: newNo, content });
      oldNo += 1;
      newNo += 1;
    }
  }

  return { lines: out, stats };
}
