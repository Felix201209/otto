/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GenerateDocumentTool,
  type Config,
  type GenerateDocumentToolParams,
  type ToolResult,
} from 'otto-core';

export interface LocalPptRequest {
  topic: string;
  pageCount: number;
  style: string;
  outline: string;
}

interface LocalDocumentGenerator {
  execute(params: GenerateDocumentToolParams, signal: AbortSignal): Promise<ToolResult>;
}

interface GenerateLocalPptOptions {
  outputDirectory?: string;
  now?: () => number;
  createGenerator?: (config: Config) => LocalDocumentGenerator;
}

export interface LocalPptResult {
  outputPath: string;
  size: number;
}

/**
 * 把自由文本收紧成弱模型也能稳定遵守的逐页视觉故事板。
 * 渲染器只识别这里公开的版式指令，避免模型输出无法落地的“设计建议”。
 */
export function buildPptStoryboardPrompt(request: LocalPptRequest): string {
  const pageCount = Math.max(1, Math.min(100, Math.round(request.pageCount || 1)));
  return `你是演示文稿的内容总编与视觉导演。请把输入材料重构成可直接渲染的逐页 Markdown 故事板。

【任务】
- 主题：${request.topic.trim() || '未指定'}
- 必须恰好 ${pageCount} 页
- 视觉方向：${request.style.trim() || '根据主题创造一个高冲击、清晰且一致的视觉母题'}

【视觉标准】
- 用户未明确要求克制、学术或政府风时，默认追求炫酷、高冲击、像发布会主视觉。
- 为这个主题创造一个独有视觉母题；禁止固定页眉、固定装饰条和每页相同的标题加卡片模板。
- 用明暗节奏、动势、景深、巨型数字、全幅图片或强排版制造焦点，不能只靠紫色渐变和发光描边。

【事实边界】
- 只使用输入材料中已有的事实、数字、名称和结论；不得编造数据、案例、引用或来源。
- 信息不足时使用保守表述，不用虚构内容填满页面。

【叙事与密度】
- 一页只表达一个观点，标题写成听众能复述的结论句，不用“市场分析”“解决方案”等空标题。
- 封面负责定调，中间按“背景/张力 → 证据 → 洞察 → 行动”推进，最后一页收束结论或下一步。
- 正文每页最多 3 个短要点，每点尽量不超过 20 个汉字；能用一个大数字或一句话讲清楚时不要凑列表。
- 连续三页不得使用同一种版式；整套至少使用 4 种版式。
- 不要输出“布局建议”“装饰元素位置”“视觉区”等说明文字，它们会被直接画进幻灯片。

【严格输出格式】
- 只输出 Markdown，不要代码围栏，不要前言或解释。
- 每页必须以一行版式指令开始，再写一个 # 标题。
- 第一页固定使用 <!-- layout: cover -->。
- 其余版式只能从 statement | split | timeline | quote | list | section 中选择；有本地图片 Markdown 时可用 visual。
- 页面之间只用独占一行的 --- 分隔。
- split 版式使用 2–3 个 ## 小标题组织对照；timeline 使用 3–5 条有顺序的编号列表；quote 只保留一句真正值得放大的话。
- 需要讲者备注时放在该页末尾，格式为“讲者备注：...”，不要把解释塞进正文。

格式示例：
<!-- layout: cover -->
# 一句能记住的核心结论
克制的副标题

---

<!-- layout: statement -->
# 结论式标题
**42%** 的变化来自一个关键动作

【输入材料】
${request.outline.trim()}`;
}

export function isStructuredPptStoryboard(content: string, pageCount: number): boolean {
  const slides = content
    .trim()
    .split(/^\s*---\s*$/m)
    .filter((slide) => slide.trim().length > 0);
  return slides.length === pageCount
    && slides.every((slide) => /<!--\s*layout\s*:\s*[a-z-]+\s*-->/i.test(slide))
    && slides.every((slide) => /^#\s+.+$/m.test(slide));
}

/** 只负责本地文件渲染；内容推理由当前会话模型完成。 */
export async function generateLocalPpt(
  request: LocalPptRequest,
  config: Config,
  signal: AbortSignal,
  options: GenerateLocalPptOptions = {},
): Promise<LocalPptResult> {
  const outputDirectory = options.outputDirectory ?? path.join(os.homedir(), 'Desktop');
  const now = options.now ?? Date.now;
  const safeTopic = Array.from(request.topic.trim())
    .map((character) => character.codePointAt(0)! < 32 ? '-' : character)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80) || 'Presentation';
  const outputPath = path.join(outputDirectory, `${safeTopic}-${now()}.pptx`);

  fs.mkdirSync(outputDirectory, { recursive: true });
  const generator = options.createGenerator?.(config) ?? new GenerateDocumentTool(config);
  const renderResult = await generator.execute(
    {
      content: request.outline,
      format: 'slides',
      output_format: 'pptx',
      output_path: outputPath,
      template_options: request.style,
      title: request.topic,
    },
    signal,
  );

  const renderSucceeded = typeof renderResult.llmContent === 'string'
    && renderResult.llmContent.startsWith('generate_document OK');
  if (!renderSucceeded || !fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    const detail = typeof renderResult.llmContent === 'string'
      ? renderResult.llmContent
      : JSON.stringify(renderResult.llmContent);
    throw new Error(detail);
  }
  return { outputPath, size: fs.statSync(outputPath).size };
}
