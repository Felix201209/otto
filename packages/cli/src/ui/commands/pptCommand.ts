/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { CommandKind, SlashCommand, SlashCommandActionReturn, CommandContext } from './types.js';
import { t, tp } from '../utils/i18n.js';

/**
 * PPT命令实现 - 触发PPT大纲对话模式
 *
 * 使用方式:
 * /ppt                    - 询问用户想要创建的PPT主题
 * /ppt "主题"             - 直接开始创建PPT，主题为指定内容
 * /ppt "主题" --pages 10  - 指定主题和预期页数
 */
export const pptCommand: SlashCommand = {
  name: 'ppt',
  description: t('command.ppt.description'),
  kind: CommandKind.BUILT_IN,

  action: async (context: CommandContext, args: string): Promise<SlashCommandActionReturn> => {
    const trimmedArgs = args.trim();

    // 解析参数
    let topic = '';
    let pageCount: number | undefined;

    if (trimmedArgs) {
      // 提取 --pages 参数
      const pagesMatch = trimmedArgs.match(/--pages\s+(\d+)/i);
      if (pagesMatch) {
        pageCount = parseInt(pagesMatch[1], 10);
        // 移除 --pages 参数后的部分作为主题
        topic = trimmedArgs.replace(/\s*--pages\s+\d+/i, '').trim();
      } else {
        topic = trimmedArgs;
      }

      // 移除首尾引号
      if ((topic.startsWith('"') && topic.endsWith('"')) ||
          (topic.startsWith("'") && topic.endsWith("'"))) {
        topic = topic.slice(1, -1);
      }
    }

    // 如果没有主题，询问用户
    if (!topic) {
      return {
        type: 'message',
        messageType: 'info',
        content: t('command.ppt.prompt'),
      };
    }

    // 构建初始化提示词，提交给AI处理PPT大纲
    const pageCountHint = pageCount ? tp('command.ppt.expected_pages', { count: pageCount }) : '';
    const initPrompt = `我想创建一个PPT演示文稿。

**主题**: ${topic}${pageCountHint}

请先用 use_skill 完整加载 ppt-creator 技能，并按高审美路径直接完成真实 PPTX：
1. 为这个主题创造独有视觉母题；默认炫酷、高冲击、像发布会主视觉
2. 一页只表达一个观点，标题必须是结论句，不能编造数据、案例或引用
3. 使用自定义 HTML/CSS/SVG 逐页构图，先做封面、最复杂数据页和结尾页三张标杆页并截图检查
4. 禁止固定页眉、重复卡片、网页后台感和整套复用同一个标题加三栏模板
5. 用本机浏览器输出 1920×1080 逐页 PNG，再用 Node/PptxGenJS 组装并真实打开 PPTX

你可以使用 ppt_outline 工具来:
- action=init: 初始化PPT编辑模式
- action=update: 更新大纲内容
- action=view: 查看当前大纲

你可以用 ppt_outline 管理内部故事板，但不要把大纲当最终交付。generate_document / ppt_generate 只能在我明确优先速度时作为兜底；不得把兜底模板冒充高审美成品。不要使用任何 Otto 云端 PPT 服务、网页登录或上传。`;

    // 返回特殊的提示词提交类型，让AI处理PPT相关任务
    return {
      type: 'submit_prompt',
      content: initPrompt,
    };
  },

  completion: async (context: CommandContext, partialArg: string) => {
    // 提供基本的补全建议
    const suggestions: string[] = [];

    if (partialArg.startsWith('--')) {
      return ['--pages '];
    }

    // 如果没有参数，建议示例
    if (!partialArg) {
      return ['"年度总结"', '"产品介绍"', '"技术分享"'];
    }

    return suggestions;
  },
};
