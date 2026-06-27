/**
 * 简化的图片处理模块
 * 前端已压缩，后端直接转换为 GenAI Part
 */

import { Part } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';

/** 项目级配置目录前缀，与 core/src/utils/paths.ts 保持一致 */
const PROJECT_DIR_PREFIX = '.otto';

export interface ImageContent {
  fileName: string;
  data: string;        // base64 (前端已压缩)
  mimeType: string;
  originalSize?: number;
  compressedSize?: number;
  width?: number;
  height?: number;
  filePath?: string;   // 原始文件路径（拖拽/文件上传时可用；粘贴时为空）
}

/**
 * 将图片内容转换为 GenAI Part
 */
export function processImageToPart(imageContent: ImageContent): Part {
  return {
    inlineData: {
      mimeType: imageContent.mimeType,
      data: imageContent.data
    }
  };
}

/**
 * 验证图片内容
 */
export function validateImageContent(imageContent: ImageContent): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!imageContent.fileName) {
    errors.push('File name is required');
  }

  if (!imageContent.data) {
    errors.push('Image data is required');
  }

  if (!imageContent.mimeType || !imageContent.mimeType.startsWith('image/')) {
    errors.push('Valid image MIME type is required');
  }

  if (imageContent.compressedSize && imageContent.compressedSize > 10 * 1024 * 1024) { // 10MB limit
    errors.push('Image size exceeds 10MB limit');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB'];
  const base = 1024;
  const index = Math.floor(Math.log(bytes) / Math.log(base));
  const size = bytes / Math.pow(base, index);

  return `${size.toFixed(1)} ${units[index]}`;
}

/**
 * 确保图片内容有可访问的本地文件路径。
 * 所有图片统一落盘到 <projectRoot>/.otto/clipboard/ 目录，
 * 文件名格式：vscode-<timestamp>-<random>.jpg
 * 这样非多模态模型和工具也能通过路径访问图片。
 */
export function ensureImageFilePath(imageContent: ImageContent, projectRoot: string): string {
  const clipboardDir = path.join(projectRoot, PROJECT_DIR_PREFIX, 'clipboard');
  if (!fs.existsSync(clipboardDir)) {
    fs.mkdirSync(clipboardDir, { recursive: true });
  }

  const ext = imageContent.fileName.includes('.')
    ? path.extname(imageContent.fileName)
    : '.jpg';
  const uniqueName = `vscode-${Date.now()}-${Math.random().toString(36).substr(2, 6)}${ext}`;
  const destPath = path.join(clipboardDir, uniqueName);

  const buffer = Buffer.from(imageContent.data, 'base64');
  fs.writeFileSync(destPath, buffer);

  // 回填 filePath，后续可直接复用
  imageContent.filePath = destPath;
  return destPath;
}