/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  ToolResult,
  Icon,
} from './tools.js';
import { Type } from '@google/genai';
import { Config } from '../config/config.js';
import { getErrorMessage } from '../utils/errors.js';

/**
 * Parameters for the ImageGenerator tool
 */
export interface ImageGeneratorToolParams {
  /** The image generation prompt */
  prompt: string;
  /** Image size, default 1024x1024 */
  size?: string;
  /** Image style (e.g., 'vivid' or 'natural' for DALL-E) */
  style?: string;
  /** Number of images to generate, default 1 */
  n?: number;
}

/** Result of a single image generation */
interface GeneratedImage {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

/**
 * AI Image Generator Tool
 *
 * Calls an OpenAI-compatible Images API (DALL-E or compatible service)
 * to generate images from a text prompt.
 *
 * Configuration (via Config / environment):
 *   - IMAGE_GEN_API_KEY    – API key
 *   - IMAGE_GEN_BASE_URL   – API base URL (default: https://api.openai.com)
 *   - IMAGE_GEN_ENABLED    – Whether the tool is enabled
 */
export class ImageGeneratorTool extends BaseTool<ImageGeneratorToolParams, ToolResult> {
  static readonly Name: string = 'image_generator';

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly enabled: boolean;

  constructor(private readonly config: Config) {
    super(
      ImageGeneratorTool.Name,
      'Image Generator',
      'Generates AI images from a text prompt using an OpenAI-compatible API (e.g. DALL-E). Provide a detailed prompt describing the desired image. Returns image URLs in markdown format.',
      Icon.Globe,
      {
        type: Type.OBJECT,
        properties: {
          prompt: {
            type: Type.STRING,
            description:
              'A detailed description of the image you want to generate. Be specific about style, composition, colors, lighting, and subject.',
          },
          size: {
            type: Type.STRING,
            description:
              'Image size. Supported values depend on the API model. Common: 1024x1024, 1792x1024, 1024x1792. Default: 1024x1024.',
          },
          style: {
            type: Type.STRING,
            description:
              'Image style. For DALL-E: "vivid" (hyper-real, dramatic) or "natural" (more realistic, less dramatic). Default depends on API.',
          },
          n: {
            type: Type.NUMBER,
            description: 'Number of images to generate. Default: 1.',
          },
        },
        required: ['prompt'],
      },
      true, // isOutputMarkdown
      false, // forceMarkdown
      false, // canUpdateOutput
      true, // allowSubAgentUse
    );

    // Read configuration from environment, with fallback
    this.apiKey = process.env.IMAGE_GEN_API_KEY ?? undefined;
    this.baseUrl = (process.env.IMAGE_GEN_BASE_URL ?? 'https://api.openai.com').replace(/\/+$/, '');
    this.enabled = process.env.IMAGE_GEN_ENABLED !== 'false' && process.env.IMAGE_GEN_ENABLED !== '0';
  }

  /**
   * Validate tool parameters
   */
  validateParams(params: ImageGeneratorToolParams): string | null {
    if (!params.prompt || params.prompt.trim() === '') {
      return 'The "prompt" parameter is required and cannot be empty.';
    }
    if (params.prompt.length > 4000) {
      return 'The "prompt" parameter exceeds the maximum length of 4000 characters.';
    }
    if (params.n !== undefined && (params.n < 1 || params.n > 10)) {
      return 'The "n" parameter must be between 1 and 10.';
    }
    return null;
  }

  getDescription(params: ImageGeneratorToolParams): string {
    const truncated = params.prompt.length > 100
      ? params.prompt.substring(0, 97) + '...'
      : params.prompt;
    const count = params.n ?? 1;
    const size = params.size ?? '1024x1024';
    return `Generate ${count} image(s) at ${size}: "${truncated}"`;
  }

  async execute(
    params: ImageGeneratorToolParams,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    // Check if tool is enabled
    if (!this.enabled) {
      const msg = 'Image generation is disabled. Set IMAGE_GEN_ENABLED=true to enable.';
      return {
        llmContent: msg,
        returnDisplay: msg,
      };
    }

    // Validate parameters
    const validationError = this.validateParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters. ${validationError}`,
        returnDisplay: validationError,
      };
    }

    // Check for API key
    if (!this.apiKey) {
      const msg = 'Image generation API key not configured. Set IMAGE_GEN_API_KEY environment variable.';
      return {
        llmContent: msg,
        returnDisplay: msg,
      };
    }

    const prompt = params.prompt.trim();
    const n = params.n ?? 1;
    const size = params.size ?? '1024x1024';

    try {
      const body: Record<string, unknown> = {
        model: 'dall-e-3', // Default model; can be overridden
        prompt,
        n,
        size,
      };

      if (params.style) {
        body.style = params.style;
      }

      // DALL-E 3 only supports n=1; for n>1, use dall-e-2
      if (n > 1) {
        body.model = 'dall-e-2';
      }

      const response = await fetch(`${this.baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        let errorBody: string;
        try {
          errorBody = await response.text();
        } catch {
          errorBody = 'Unable to read error response';
        }
        const errorMessage = `Image generation API returned status ${response.status}: ${errorBody}`;
        return {
          llmContent: `Error: ${errorMessage}`,
          returnDisplay: `Error: ${errorMessage}`,
        };
      }

      const data = await response.json();

      // Extract image URLs from the response
      const images: GeneratedImage[] = data?.data ?? [];
      if (images.length === 0) {
        return {
          llmContent: 'No images were generated. The API returned an empty result.',
          returnDisplay: 'No images generated.',
        };
      }

      // Build markdown result with image URLs
      const markdownParts: string[] = [];
      markdownParts.push(`Generated ${images.length} image(s) for prompt: "${prompt}"\n`);

      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (img.url) {
          markdownParts.push(`![Generated Image ${i + 1}](${img.url})`);
          if (img.revised_prompt) {
            markdownParts.push(`*Revised prompt: ${img.revised_prompt}*`);
          }
          markdownParts.push('');
        }
      }

      const markdown = markdownParts.join('\n');

      // LLM content: include the URLs in a way the LLM can reference
      const urlList = images
        .filter((img) => img.url)
        .map((img, i) => `[Image ${i + 1}](${img.url})`)
        .join('\n');

      const llmContent = `Successfully generated ${images.length} image(s).\n\n${urlList}`;

      return {
        llmContent,
        returnDisplay: markdown,
      };
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      const msg = `Error generating images: ${errorMessage}`;
      console.error(`[ImageGeneratorTool] ${msg}`, error);
      return {
        llmContent: `Error: ${msg}`,
        returnDisplay: `Error: ${msg}`,
      };
    }
  }
}
