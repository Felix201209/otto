/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Type } from '@google/genai';
import { Config } from '../../config/config.js';
import { t } from '../../utils/simpleI18n.js';
import { GenerateDocumentTool } from '../generate-document.js';
import {
  BaseTool,
  Icon,
  ToolResult,
  ToolLocation,
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
} from '../tools.js';
import { PPTOutlineManager } from './pptOutlineManager.js';

export interface PptGenerateToolParams {
  /** 确认生成（默认 true） */
  confirm?: boolean;
  /** 本地 PPTX 输出路径；省略时保存到用户桌面 */
  output_path?: string;
}

/**
 * 兼容旧 ppt_outline -> ppt_generate 流程的本地适配器。
 *
 * PPT 内容由当前会话中的模型整理；文件渲染统一复用 GenerateDocumentTool，
 * 全程不访问 Otto 服务端、不登录、不上传，也不依赖网页编辑器。
 */
export class PptGenerateTool extends BaseTool<PptGenerateToolParams, ToolResult> {
  static readonly Name = 'ppt_generate';

  private readonly documentGenerator: GenerateDocumentTool;
  private pendingDefaultOutputPath?: string;

  constructor(
    private readonly config: Config,
    documentGenerator?: GenerateDocumentTool,
  ) {
    super(
      PptGenerateTool.Name,
      t('tool.ppt_generate'),
      t('tool.ppt_generate.description'),
      Icon.Pencil,
      {
        type: Type.OBJECT,
        properties: {
          confirm: {
            type: Type.BOOLEAN,
            description: t('ppt_generate.param.confirm'),
          },
          output_path: {
            type: Type.STRING,
            description: '本地 .pptx 输出路径；省略时保存到用户桌面',
          },
        },
        required: [],
      },
      true,
      true,
    );
    this.documentGenerator = documentGenerator ?? new GenerateDocumentTool(config);
  }

  validateToolParams(params: PptGenerateToolParams): string | null {
    const outlineError = PPTOutlineManager.getInstance().validateForSubmission();
    if (outlineError) return outlineError;
    if (params.output_path && path.extname(params.output_path).toLowerCase() !== '.pptx') {
      return 'PPT 本地输出路径必须以 .pptx 结尾';
    }
    return null;
  }

  getDescription(params: PptGenerateToolParams): string {
    const state = PPTOutlineManager.getInstance().getState();
    const outputPath = this.resolveOutputPath(params, state.topic);
    return `在本地生成 PPT: ${state.topic || '(未设置主题)'} -> ${outputPath}`;
  }

  toolLocations(params: PptGenerateToolParams): ToolLocation[] {
    if (!params.output_path) return [];
    return [{ path: this.resolveProvidedPath(params.output_path) }];
  }

  async shouldConfirmExecute(
    params: PptGenerateToolParams,
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    const manager = PPTOutlineManager.getInstance();
    const state = manager.getState();
    const validationError = this.validateToolParams(params);
    if (validationError) return false;

    const outputPath = this.resolveOutputPath(params, state.topic);
    const outlinePreview = state.outline.length > 500
      ? state.outline.substring(0, 500) + '...'
      : state.outline;

    return {
      type: 'info',
      title: 'Confirm Local PPT Generation',
      prompt: `即将在本地生成 PPT 文件

📝 主题: ${state.topic}
📄 预计页数: ${state.pageCount}
💾 本地路径: ${outputPath}

📋 内容预览:
${outlinePreview}

确认后将逐页生成本地 HTML，由本机浏览器转成图片，再封装为 PPTX；不调用 Python，不上传内容，也不打开云端网页。`,
      onConfirm: async (_outcome: ToolConfirmationOutcome) => {
        // 无额外确认副作用。
      },
    };
  }

  async execute(params: PptGenerateToolParams, signal: AbortSignal): Promise<ToolResult> {
    const manager = PPTOutlineManager.getInstance();
    const state = manager.getState();
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `❌ ${validationError}`,
        returnDisplay: `❌ ${validationError}`,
      };
    }

    const outputPath = this.resolveOutputPath(params, state.topic);

    try {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const renderResult = await this.documentGenerator.execute(
        {
          content: state.outline,
          format: 'slides',
          output_format: 'pptx',
          output_path: outputPath,
          title: state.topic,
        },
        signal,
      );

      const renderSucceeded = typeof renderResult.llmContent === 'string'
        && renderResult.llmContent.startsWith('generate_document OK');
      const generated = renderSucceeded
        && fs.existsSync(outputPath)
        && fs.statSync(outputPath).size > 0;
      if (!generated) {
        return {
          llmContent: `❌ 本地 PPT 生成失败，大纲已保留，可修复本机依赖后重试。\n\n${renderResult.llmContent}`,
          returnDisplay: `❌ 本地 PPT 生成失败：${renderResult.returnDisplay}`,
        };
      }

      const size = fs.statSync(outputPath).size;
      manager.clear();
      this.pendingDefaultOutputPath = undefined;
      return {
        llmContent: `✅ PPT 已在本地生成\n\n- 主题: ${state.topic}\n- 页数: ${state.pageCount}\n- 文件: ${outputPath}\n- 大小: ${size} bytes\n\n内容未上传，PPT 模式已退出。`,
        returnDisplay: `✅ PPT 已在本地生成：${outputPath}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `❌ 本地 PPT 生成失败，大纲已保留，可重试：${message}`,
        returnDisplay: `❌ 本地 PPT 生成失败：${message}`,
      };
    }
  }

  private resolveOutputPath(params: PptGenerateToolParams, topic: string): string {
    if (params.output_path) return this.resolveProvidedPath(params.output_path);
    if (!this.pendingDefaultOutputPath) {
      const safeTopic = Array.from(topic.trim())
        .map((character) => character.codePointAt(0)! < 32 ? '-' : character)
        .join('')
        .replace(/[<>:"/\\|?*]/g, '-')
        .replace(/\s+/g, ' ')
        .slice(0, 80) || 'Presentation';
      this.pendingDefaultOutputPath = path.join(
        os.homedir(),
        'Desktop',
        `${safeTopic}-${Date.now()}.pptx`,
      );
    }
    return this.pendingDefaultOutputPath;
  }

  private resolveProvidedPath(outputPath: string): string {
    if (outputPath === '~') return os.homedir();
    if (outputPath.startsWith(`~${path.sep}`)) {
      return path.join(os.homedir(), outputPath.slice(2));
    }
    if (path.isAbsolute(outputPath)) return path.normalize(outputPath);
    return path.resolve(this.config.getTargetDir(), outputPath);
  }
}
