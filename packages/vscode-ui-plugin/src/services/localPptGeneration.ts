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
  const styleComment = request.style.trim()
    ? `<!-- Local PPT style preference: ${request.style.replace(/-->/g, '—>')} -->\n\n`
    : '';
  const generator = options.createGenerator?.(config) ?? new GenerateDocumentTool(config);
  const renderResult = await generator.execute(
    {
      content: styleComment + request.outline,
      format: 'slides',
      output_format: 'pptx',
      output_path: outputPath,
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
