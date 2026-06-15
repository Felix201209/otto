/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import { Type } from '@google/genai';
import { BaseTool, Icon, ToolLocation, ToolResult } from './tools.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config } from '../config/config.js';
import {
  isWithinRoot,
  processSingleFileContent,
  detectFileType,
} from '../utils/fileUtils.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { getResponseText } from '../utils/generateContentResponseUtilities.js';
import { SceneType } from '../core/sceneManager.js';
import { getErrorMessage } from '../utils/errors.js';
import { isCustomModel, generateCustomModelId } from '../types/customModel.js';

/**
 * Parameters for the ImageReader tool
 */
export interface ImageReaderToolParams {
  /**
   * The absolute path to the image file to read.
   */
  absolute_path: string;

  /**
   * Optional custom instruction. If omitted, the tool asks the vision model
   * for a detailed, neutral description of everything visible in the image.
   */
  prompt?: string;

  /**
   * Allow reading images outside the workspace directory.
   */
  allow_external_access?: boolean;
}

const DEFAULT_DESCRIBE_PROMPT =
  'Please describe the image in extreme detail. Include all visible objects, text (transcribed verbatim), people, scenes, colors, layout, charts/diagrams, code snippets, UI elements, and any other relevant information. Preserve any text content exactly as it appears. If the image is a screenshot, describe the UI structure and content faithfully. Output plain prose; do not refuse.';

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
]);

// Cap on the description length to prevent token explosion when feeding back
// into the host model. Mirrors the cap used in web-fetch / web-search.
const MAX_DESCRIPTION_LENGTH = 10000;

/**
 * ImageReader Tool
 *
 * Used as a fallback when the active text-only model cannot directly accept
 * image content. The server signals this by replacing the image with a marker
 * such as:
 *   "[Image Content was filtered. Current config do not support (model: xxx)]
 *    Try using image_reader tool to assist."
 *
 * The model can then call this tool with the local image path; we offload the
 * vision work to a cheap Gemini Flash chat created via `createTemporaryChat`,
 * and return the resulting textual description.
 *
 * This is a PASSIVE fallback only. Multimodal models that can already see the
 * image must answer directly and must NOT call this tool. The tool description
 * is intentionally worded to discourage proactive invocation; the real trigger
 * is the server-side filter marker shown above.
 */
export class ImageReaderTool extends BaseTool<ImageReaderToolParams, ToolResult> {
  static readonly Name: string = 'image_reader';

  constructor(private readonly config: Config) {
    super(
      ImageReaderTool.Name,
      'ImageReader',
      'Fallback tool for text-only models that cannot natively view images. ' +
        'It offloads the vision work to a cheap model (gemini-2.5-flash) and ' +
        'returns a textual description. Do NOT call this tool proactively: ' +
        'only use it when the server has replaced an image with a filter ' +
        'marker explicitly instructing you to (e.g. "[Image Content was ' +
        'filtered. ... Try using image_reader tool to assist.]"). If you can ' +
        'already see and understand the image content yourself, just answer ' +
        'directly and do NOT call this tool. ' +
        'Supports PNG / JPG / JPEG / GIF / WEBP / BMP / SVG.',
      Icon.FileSearch,
      {
        type: Type.OBJECT,
        properties: {
          absolute_path: {
            type: Type.STRING,
            description:
              'Absolute path to the image file on disk (e.g. ' +
              '/home/user/pic.png or C:\\\\Users\\\\me\\\\pic.png). ' +
              'Relative paths are not supported.',
          },
          prompt: {
            type: Type.STRING,
            description:
              'Optional custom instruction for the vision model. If omitted, ' +
              'the tool asks for a detailed, neutral description of the image. ' +
              'Use this when you need targeted information, e.g. ' +
              '"Transcribe all text from this screenshot" or ' +
              '"What error message is shown in this dialog?".',
          },
          allow_external_access: {
            type: Type.BOOLEAN,
            description:
              'Optional: Allow reading images outside the workspace directory. ' +
              'Defaults to false. Set to true only when the user explicitly ' +
              'provides an external image path.',
          },
        },
        required: ['absolute_path'],
      },
    );
  }

  override validateToolParams(params: ImageReaderToolParams): string | null {
    if (params && typeof params.absolute_path === 'string') {
      let cleaned = params.absolute_path.trim();
      if (
        (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))
      ) {
        cleaned = cleaned.slice(1, -1).trim();
      }
      params.absolute_path = cleaned;
    }

    const errors = SchemaValidator.validate(
      this.schema.parameters,
      params,
      ImageReaderTool.Name,
    );
    if (errors) {
      return errors;
    }

    const filePath = params.absolute_path;
    if (!filePath || typeof filePath !== 'string') {
      return 'absolute_path must be a non-empty string.';
    }
    if (!path.isAbsolute(filePath)) {
      return `File path must be absolute, but was relative: ${filePath}`;
    }

    if (
      !params.allow_external_access &&
      !isWithinRoot(filePath, this.config.getTargetDir())
    ) {
      return (
        `File path must be within the workspace directory ` +
        `(${this.config.getTargetDir()}) or set allow_external_access=true: ${filePath}`
      );
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
      return (
        `Unsupported image extension "${ext}". Supported: ` +
        `${Array.from(SUPPORTED_IMAGE_EXTENSIONS).join(', ')}.`
      );
    }

    if (params.prompt !== undefined && typeof params.prompt !== 'string') {
      return 'prompt must be a string when provided.';
    }

    return null;
  }

  override getDescription(params: ImageReaderToolParams): string {
    if (params && typeof params.absolute_path === 'string') {
      let cleaned = params.absolute_path.trim();
      if (
        (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))
      ) {
        cleaned = cleaned.slice(1, -1).trim();
      }
      params.absolute_path = cleaned;
    }
    if (
      !params ||
      typeof params.absolute_path !== 'string' ||
      params.absolute_path.trim() === ''
    ) {
      return 'Path unavailable';
    }
    const relative = makeRelative(
      params.absolute_path,
      this.config.getTargetDir(),
    );
    return `Describing image: ${shortenPath(relative)}`;
  }

  override toolLocations(params: ImageReaderToolParams): ToolLocation[] {
    if (params && typeof params.absolute_path === 'string') {
      let cleaned = params.absolute_path.trim();
      if (
        (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))
      ) {
        cleaned = cleaned.slice(1, -1).trim();
      }
      params.absolute_path = cleaned;
    }
    if (!params?.absolute_path) return [];
    return [{ path: params.absolute_path }];
  }

  override async execute(
    params: ImageReaderToolParams,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: validationError,
      };
    }

    // Check if using a custom model
    const currentModel = typeof this.config.getModel === 'function' ? this.config.getModel() : undefined;
    const isUsingCustomModel = currentModel ? isCustomModel(currentModel) : false;
    let resolvedModel: string | undefined = undefined;

    if (isUsingCustomModel && typeof this.config.getCustomModels === 'function') {
      const customModels = this.config.getCustomModels() || [];
      const geminiFlashModel = customModels.find(m => {
        if (m.enabled === false) return false;
        const modelIdLower = (m.modelId || '').toLowerCase();
        const displayNameLower = (m.displayName || '').toLowerCase();
        return (modelIdLower.includes('gemini') && modelIdLower.includes('flash')) ||
               (displayNameLower.includes('gemini') && displayNameLower.includes('flash'));
      });

      if (!geminiFlashModel) {
        return {
          llmContent: `This tool (${ImageReaderTool.Name}) is currently unavailable because you are using custom models, but no custom Gemini Flash model (e.g., gemini-2.5-flash) was found in your custom models list to execute this tool. Please configure a custom Gemini Flash model to use this feature.`,
          returnDisplay: `Tool unavailable: Gemini Flash required`
        };
      }
      resolvedModel = generateCustomModelId(geminiFlashModel);
    }

    const filePath = params.absolute_path;

    // Verify it's an image file by content (mime-type) before doing anything
    // expensive.
    let detectedType: Awaited<ReturnType<typeof detectFileType>>;
    try {
      detectedType = await detectFileType(filePath);
    } catch (e) {
      const msg = getErrorMessage(e);
      return {
        llmContent: `Error: failed to detect file type for "${filePath}": ${msg}`,
        returnDisplay: `Error: failed to detect file type: ${msg}`,
      };
    }
    if (detectedType !== 'image' && detectedType !== 'svg') {
      return {
        llmContent:
          `Error: file at "${filePath}" is not an image (detected type: ${detectedType}). ` +
          `Use the read_file tool for non-image content.`,
        returnDisplay: `Not an image (detected: ${detectedType})`,
      };
    }

    // Read & compress the image via the shared file-reading pipeline so we
    // reuse the existing token-friendly compression logic.
    const fileResult = await processSingleFileContent(
      filePath,
      this.config.getTargetDir(),
    );
    if (fileResult.error) {
      return {
        llmContent: `Error reading image: ${fileResult.error}`,
        returnDisplay:
          typeof fileResult.returnDisplay === 'string'
            ? fileResult.returnDisplay
            : 'Error reading image',
      };
    }

    const llmContent = fileResult.llmContent;

    // SVG comes back as plain text; everything else as inlineData.
    let messageParts: Array<{ text: string } | {
      inlineData: { mimeType: string; data: string };
    }>;

    const userPrompt =
      (params.prompt && params.prompt.trim()) || DEFAULT_DESCRIBE_PROMPT;

    if (
      detectedType === 'svg' ||
      typeof llmContent === 'string'
    ) {
      // For SVG we feed the markup through as text so the model can read both
      // visual semantics and embedded text.
      const svgText =
        typeof llmContent === 'string' ? llmContent : String(llmContent);
      messageParts = [
        {
          text:
            `${userPrompt}\n\n` +
            `The image is an SVG. Treat the following XML as the image source ` +
            `and describe what it would render plus transcribe all text:\n\n` +
            `\`\`\`svg\n${svgText}\n\`\`\``,
        },
      ];
    } else if (
      llmContent &&
      typeof llmContent === 'object' &&
      'inlineData' in llmContent &&
      llmContent.inlineData?.data &&
      llmContent.inlineData?.mimeType
    ) {
      messageParts = [
        { text: userPrompt },
        {
          inlineData: {
            mimeType: llmContent.inlineData.mimeType,
            data: llmContent.inlineData.data,
          },
        },
      ];
    } else {
      return {
        llmContent: `Error: unexpected file read result for image "${filePath}".`,
        returnDisplay: 'Unexpected image read result',
      };
    }

    // Delegate the actual vision work to a cheap, dedicated Gemini Flash chat.
    try {
      const geminiClient = this.config.getGeminiClient();
      const temporaryChat = await geminiClient.createTemporaryChat(
        SceneType.IMAGE_READER,
        resolvedModel, // use scene-recommended model (gemini-2.5-flash) or custom Gemini Flash model
        { type: 'sub', agentId: 'ImageReader' },
        { disableSystemPrompt: true },
      );

      const response = await temporaryChat.sendMessage(
        {
          message: messageParts,
          config: {
            abortSignal: signal,
          },
        },
        `image-reader-${Date.now()}`,
        SceneType.IMAGE_READER,
      );

      let description = (getResponseText(response) || '').trim();

      if (!description) {
        return {
          llmContent: `Error: vision model returned an empty description for "${filePath}".`,
          returnDisplay: 'Empty description from vision model',
        };
      }

      let truncated = false;
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        const originalLength = description.length;
        description = description.substring(0, MAX_DESCRIPTION_LENGTH);
        description += `\n\n[Note: Description truncated from ${originalLength} to ${MAX_DESCRIPTION_LENGTH} characters to prevent context overflow]`;
        truncated = true;
      }

      const relative = makeRelative(filePath, this.config.getTargetDir());
      const header = `Image description for ${shortenPath(relative)} (via ${isUsingCustomModel ? 'custom model' : 'gemini-2.5-flash'}):`;

      return {
        llmContent: `${header}\n\n${description}`,
        returnDisplay: `Described image: ${shortenPath(relative)}${truncated ? ' (truncated)' : ''}`,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error(
        `[ImageReaderTool] Failed to describe image "${filePath}":`,
        error,
      );
      return {
        llmContent: `Error describing image "${filePath}": ${errorMessage}`,
        returnDisplay: `Error describing image: ${errorMessage}`,
      };
    }
  }
}
