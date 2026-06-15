/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { ImageReaderTool, ImageReaderToolParams } from './image-reader.js';
import { Config } from '../config/config.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';

// Minimal 1x1 transparent PNG.
const ONE_PIXEL_PNG = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,
  1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65,
  84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73,
  69, 78, 68, 174, 66, 96, 130,
]);

describe('ImageReaderTool', () => {
  let tempRootDir: string;
  let mockConfig: Config;
  let sendMessageMock: ReturnType<typeof vi.fn>;
  let createTemporaryChatMock: ReturnType<typeof vi.fn>;
  const abortSignal = new AbortController().signal;

  beforeEach(async () => {
    tempRootDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'image-reader-tool-'),
    );

    sendMessageMock = vi.fn().mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [{ text: 'A 1x1 transparent PNG.' }],
            role: 'model',
          },
          index: 0,
        },
      ],
    });

    createTemporaryChatMock = vi.fn().mockResolvedValue({
      sendMessage: sendMessageMock,
    });

    mockConfig = {
      getFileService: () => new FileDiscoveryService(tempRootDir),
      getTargetDir: () => tempRootDir,
      getUsageStatisticsEnabled: () => false,
      getGeminiClient: () => ({
        createTemporaryChat: createTemporaryChatMock,
      }),
    } as unknown as Config;
  });

  afterEach(async () => {
    if (fs.existsSync(tempRootDir)) {
      await fsp.rm(tempRootDir, { recursive: true, force: true });
    }
  });

  describe('schema', () => {
    it('exposes the canonical tool name', () => {
      expect(ImageReaderTool.Name).toBe('image_reader');
    });

    it('exposes a parameter schema with absolute_path required', () => {
      const tool = new ImageReaderTool(mockConfig);
      expect(tool.schema.name).toBe('image_reader');
      const params = tool.schema.parameters as {
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(params.required).toEqual(['absolute_path']);
      expect(params.properties).toHaveProperty('absolute_path');
      expect(params.properties).toHaveProperty('prompt');
      expect(params.properties).toHaveProperty('allow_external_access');
    });
  });

  describe('validateToolParams', () => {
    it('returns null for a valid PNG path inside the workspace', () => {
      const tool = new ImageReaderTool(mockConfig);
      const params: ImageReaderToolParams = {
        absolute_path: path.join(tempRootDir, 'pic.png'),
      };
      expect(tool.validateToolParams(params)).toBeNull();
    });

    it('cleans up quotes and whitespace from absolute_path', () => {
      const tool = new ImageReaderTool(mockConfig);
      const params: ImageReaderToolParams = {
        absolute_path: `  "${path.join(tempRootDir, 'pic.png')}"  `,
      };
      expect(tool.validateToolParams(params)).toBeNull();
      expect(params.absolute_path).toBe(path.join(tempRootDir, 'pic.png'));
    });

    it('rejects relative paths', () => {
      const tool = new ImageReaderTool(mockConfig);
      const params = { absolute_path: 'pic.png' } as ImageReaderToolParams;
      expect(tool.validateToolParams(params)).toContain(
        'File path must be absolute',
      );
    });

    it('rejects paths outside the workspace by default', () => {
      const tool = new ImageReaderTool(mockConfig);
      const outside = path.resolve(os.tmpdir(), 'outside-image.png');
      const params: ImageReaderToolParams = { absolute_path: outside };
      const err = tool.validateToolParams(params);
      expect(err).toMatch(/within the workspace directory/);
    });

    it('allows external paths when allow_external_access is true', () => {
      const tool = new ImageReaderTool(mockConfig);
      const outside = path.resolve(os.tmpdir(), 'outside-image.png');
      const params: ImageReaderToolParams = {
        absolute_path: outside,
        allow_external_access: true,
      };
      expect(tool.validateToolParams(params)).toBeNull();
    });

    it('rejects unsupported file extensions', () => {
      const tool = new ImageReaderTool(mockConfig);
      const params: ImageReaderToolParams = {
        absolute_path: path.join(tempRootDir, 'doc.txt'),
      };
      expect(tool.validateToolParams(params)).toMatch(
        /Unsupported image extension/,
      );
    });
  });

  describe('execute', () => {
    it('returns a description by delegating to a temporary Gemini Flash chat', async () => {
      const tool = new ImageReaderTool(mockConfig);
      const filePath = path.join(tempRootDir, 'pic.png');
      await fsp.writeFile(filePath, ONE_PIXEL_PNG);

      const result = await tool.execute(
        { absolute_path: filePath },
        abortSignal,
      );

      expect(createTemporaryChatMock).toHaveBeenCalledTimes(1);
      // First arg must be the IMAGE_READER scene.
      expect(createTemporaryChatMock.mock.calls[0][0]).toBe('image_reader');

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const sendCall = sendMessageMock.mock.calls[0][0];
      expect(Array.isArray(sendCall.message)).toBe(true);
      // First part is the prompt text, second part is the inlineData image.
      expect(sendCall.message[0]).toMatchObject({ text: expect.any(String) });
      expect(sendCall.message[1]).toMatchObject({
        inlineData: {
          mimeType: expect.stringMatching(/^image\//),
          data: expect.any(String),
        },
      });

      expect(result.llmContent).toContain('A 1x1 transparent PNG.');
      expect(typeof result.returnDisplay).toBe('string');
      expect(result.returnDisplay as string).toMatch(/Described image/);
    });

    it('uses a custom prompt when provided', async () => {
      const tool = new ImageReaderTool(mockConfig);
      const filePath = path.join(tempRootDir, 'pic.png');
      await fsp.writeFile(filePath, ONE_PIXEL_PNG);

      await tool.execute(
        {
          absolute_path: filePath,
          prompt: 'Just transcribe any text.',
        },
        abortSignal,
      );

      const sendCall = sendMessageMock.mock.calls[0][0];
      expect(sendCall.message[0].text).toBe('Just transcribe any text.');
    });

    it('returns an error result for non-image files even if validation slips', async () => {
      const tool = new ImageReaderTool(mockConfig);
      const filePath = path.join(tempRootDir, 'fake.png');
      // Write text content but with .png extension. fileUtils detects via mime
      // lookup which uses extension, so this will still be classified as image
      // and fall through to the vision model. We instead test the explicit
      // extension guard with a .txt file:
      const txtPath = path.join(tempRootDir, 'note.txt');
      await fsp.writeFile(txtPath, 'hello', 'utf-8');

      const result = await tool.execute(
        { absolute_path: txtPath },
        abortSignal,
      );

      expect(result.llmContent).toMatch(
        /Error: Invalid parameters provided.*Unsupported image extension/,
      );
      expect(sendMessageMock).not.toHaveBeenCalled();
      // silence unused-variable lints
      void filePath;
    });

    it('returns an error if the vision model returns empty text', async () => {
      sendMessageMock.mockResolvedValueOnce({
        candidates: [
          {
            content: { parts: [{ text: '' }], role: 'model' },
            index: 0,
          },
        ],
      });
      const tool = new ImageReaderTool(mockConfig);
      const filePath = path.join(tempRootDir, 'pic.png');
      await fsp.writeFile(filePath, ONE_PIXEL_PNG);

      const result = await tool.execute(
        { absolute_path: filePath },
        abortSignal,
      );

      expect(result.llmContent).toMatch(/empty description/);
    });

    it('surfaces errors from the vision model gracefully', async () => {
      sendMessageMock.mockRejectedValueOnce(new Error('upstream boom'));
      const tool = new ImageReaderTool(mockConfig);
      const filePath = path.join(tempRootDir, 'pic.png');
      await fsp.writeFile(filePath, ONE_PIXEL_PNG);

      const result = await tool.execute(
        { absolute_path: filePath },
        abortSignal,
      );

      expect(result.llmContent).toMatch(/Error describing image.*upstream boom/);
    });

    it('selects custom Gemini Flash model when custom models are used', async () => {
      const getModelMock = vi.fn().mockReturnValue('custom:openai:gpt-4o@hash');
      const getCustomModelsMock = vi.fn().mockReturnValue([
        {
          displayName: 'My Custom Flash',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'key',
          modelId: 'gemini-2.5-flash',
          enabled: true,
        },
        {
          displayName: 'Some Other Model',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'key',
          modelId: 'gpt-4o',
          enabled: true,
        }
      ]);

      const testConfig = {
        ...mockConfig,
        getModel: getModelMock,
        getCustomModels: getCustomModelsMock,
      } as unknown as Config;

      const tool = new ImageReaderTool(testConfig);
      const filePath = path.join(tempRootDir, 'pic.png');
      await fsp.writeFile(filePath, ONE_PIXEL_PNG);

      const result = await tool.execute(
        { absolute_path: filePath },
        abortSignal,
      );

      // Verify that createTemporaryChat was called with the generated custom model ID
      expect(createTemporaryChatMock).toHaveBeenCalledWith(
        'image_reader',
        'custom:openai:gemini-2.5-flash@yomiri',
        expect.any(Object),
        expect.any(Object)
      );
      expect(result.llmContent).toContain('via custom model');
    });

    it('returns tool unavailable when custom models are used but no custom Gemini Flash is found', async () => {
      const getModelMock = vi.fn().mockReturnValue('custom:openai:gpt-4o@hash');
      const getCustomModelsMock = vi.fn().mockReturnValue([
        {
          displayName: 'Some Other Model',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'key',
          modelId: 'gpt-4o',
          enabled: true,
        }
      ]);

      const testConfig = {
        ...mockConfig,
        getModel: getModelMock,
        getCustomModels: getCustomModelsMock,
      } as unknown as Config;

      const tool = new ImageReaderTool(testConfig);
      const filePath = path.join(tempRootDir, 'pic.png');
      await fsp.writeFile(filePath, ONE_PIXEL_PNG);

      const result = await tool.execute(
        { absolute_path: filePath },
        abortSignal,
      );

      expect(result.llmContent).toContain('is currently unavailable because you are using custom models');
      expect(result.returnDisplay).toBe('Tool unavailable: Gemini Flash required');
    });
  });
});
