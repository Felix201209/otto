/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * server 侧斜杠命令注册表 + 执行器。
 *
 * 职责：
 *   - listSlashCommands()：给 renderer 面板的命令清单（slash_commands_list 帧
 *     的单一事实源——renderer 不再自己维护 server 命令列表，防两处漂移）。
 *   - executeSlashCommand()：解析 name/args（含子命令），跑对应 action；
 *     所有异常兜成 ok:false 的 markdown，绝不抛出去砸 WS 分发。
 */

import type { SlashCommandInfo } from '../protocol.js';
import { infoCommands } from './info.js';
import { knowledgeCommands } from './knowledge.js';
import { sessionCommands } from './session.js';
import {
  fail,
  md,
  type CommandHost,
  type ServerSlashCommand,
  type SlashOutcome,
} from './types.js';

/** 注册表（顺序即面板展示顺序：信息类 → 知识类 → 会话类）。 */
const REGISTRY: readonly ServerSlashCommand[] = [
  ...infoCommands,
  ...knowledgeCommands,
  ...sessionCommands,
];

/** 面板清单（name/description/usage 元信息）。 */
export function listSlashCommands(): SlashCommandInfo[] {
  return REGISTRY.map((c) => ({
    name: c.name,
    description: c.description,
    ...(c.usage ? { usage: c.usage } : {}),
  }));
}

/** 测试/调试用：按名取命令定义。 */
export function getSlashCommand(name: string): ServerSlashCommand | undefined {
  return REGISTRY.find((c) => c.name === name.toLowerCase());
}

/** 把 args 按首个空白切成 [子命令候选, 余下参数]。 */
function splitFirstToken(args: string): [string, string] {
  const trimmed = args.trim();
  const idx = trimmed.search(/\s/);
  if (idx < 0) return [trimmed, ''];
  return [trimmed.slice(0, idx), trimmed.slice(idx + 1).trim()];
}

/** 渲染某命令的用法说明（bare 调用无 action 的父命令 / 未知子命令时）。 */
function usageOf(cmd: ServerSlashCommand): string {
  const lines: string[] = [`**/${cmd.name}** — ${cmd.description}`];
  if (cmd.subCommands?.length) {
    lines.push('', '可用子命令：', '');
    for (const sub of cmd.subCommands) {
      lines.push(`- \`/${cmd.name} ${sub.name}\` — ${sub.description}`);
    }
  } else if (cmd.usage) {
    lines.push('', `用法：\`/${cmd.usage}\``);
  }
  return lines.join('\n');
}

/**
 * 执行一条命令。永不抛异常：未知命令 / action 抛错都收敛成 ok:false markdown。
 * rawArgs 是命令名之后的整段原始文本（renderer 原样透传），子命令在这里解析。
 */
export async function executeSlashCommand(
  host: CommandHost,
  sessionId: string,
  name: string,
  rawArgs: string,
): Promise<SlashOutcome> {
  const cmd = getSlashCommand(name);
  if (!cmd) {
    return fail(`未知命令 \`/${name}\`。输入 \`/\` 查看可用命令。`);
  }
  const ctx = { host, sessionId };
  const args = (rawArgs ?? '').trim();
  try {
    if (cmd.subCommands?.length) {
      const [head, rest] = splitFirstToken(args);
      if (head) {
        const sub = cmd.subCommands.find(
          (s) => s.name === head.toLowerCase(),
        );
        if (sub?.action) return await sub.action(ctx, rest);
        // 未知子命令：报错并附用法，不静默吞掉（防「假成功」）。
        return fail(`未知子命令 \`${head}\`。\n\n${usageOf(cmd)}`);
      }
      // bare 调用：父命令自己有 action 就跑，否则给用法说明。
      if (cmd.action) return await cmd.action(ctx, args);
      return md(usageOf(cmd));
    }
    if (cmd.action) return await cmd.action(ctx, args);
    return md(usageOf(cmd));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return fail(`\`/${name}\` 执行失败：${message}`);
  }
}
