/**
 * 消息内容转换器
 * 将 MessageContent 转换为 GenAI 的 PartListUnion
 */

import { Part, PartListUnion } from '@google/genai';
import { processFileToPartsList, processFolderToPartsList, FileContentItem } from './fileContentProcessor.js';
import { processImageToPart, ImageContent, ensureImageFilePath } from './imageProcessor.js';
import { MessageContent, MessageContentPart } from '../types/messages.js';

export interface ConversionResult {
  parts: PartListUnion;
  summary: {
    textParts: number;
    fileParts: number;
    imageParts: number;
    skippedFiles: number;
    totalParts: number;
  };
  warnings: string[];
}

/**
 * 将 MessageContent 转换为 GenAI PartListUnion
 */
export async function convertMessageContentToParts(
  content: MessageContent,
  workspaceRoot?: string
): Promise<ConversionResult> {
  const allParts: Part[] = [];
  const warnings: string[] = [];
  let textParts = 0;
  let fileParts = 0;
  let imageParts = 0;
  let skippedFiles = 0;

  // 🎯 调试：打印完整的 content 结构
  console.log(`🔍 [MessageConverter] 开始转换消息内容，共 ${content.length} 个部分:`);
  content.forEach((item, index) => {
    console.log(`  [${index}] type: ${item.type}`, item.value);
  });

  // 🎯 预处理：为所有图片引用确保有可访问的文件路径（统一落盘到 .deepvcode/clipboard/）
  for (const item of content) {
    if (item.type === 'image_reference') {
      try {
        const imageContent = item.value as ImageContent;
        const projectRoot = workspaceRoot || process.cwd();
        ensureImageFilePath(imageContent, projectRoot);
        console.log(`🔍 [MessageConverter] 图片已落盘: ${imageContent.filePath}`);
      } catch (err) {
        console.warn(`⚠️ [MessageConverter] 无法保存图片: ${(item.value as ImageContent).fileName}`, err);
      }
    }
  }

  // 🎯 第一步：生成完整的拼装文本（用户意图的完整表达）
  const assembledText = content.map(item => {
    switch (item.type) {
      case 'text':
        return item.value;
      case 'file_reference':
        return `@[${item.value.fileName}]`;
      case 'folder_reference':  // 🎯 文件夹引用
        return `@[${item.value.folderName}]`;
      case 'image_reference':
        // 🎯 包含本地文件路径，让非多模态模型和工具也能访问图片
        const imgPath = (item.value as ImageContent).filePath || '';
        return imgPath
          ? `[IMAGE:${item.value.fileName} (${imgPath})]`
          : `[IMAGE:${item.value.fileName}]`;
      case 'code_reference':  // 🎯 代码引用
        return `@[${item.value.fileName} (${item.value.startLine}-${item.value.endLine})]`;
      case 'text_file_content':  // ✨ 新增
        return `@[${item.value.fileName}]`;
      case 'terminal_reference':  // 🎯 终端引用
        return `@[Terminal: ${item.value.terminalName}]`;
      default:
        return '';
    }
  }).join('');

  console.log(`🔍 [MessageConverter] 拼装后的文本: ${assembledText.substring(0, 200)}${assembledText.length > 200 ? '...' : ''}`);

  // 🎯 添加拼装后的完整文本作为第一个part
  if (assembledText.trim()) {
    allParts.push({ text: assembledText });
    textParts = 1; // 只有一个文本part
  }

  // 🎯 第二步：添加所有引用的文件内容（作为AI上下文）
  for (const item of content) {
    try {
      if (item.type === 'file_reference') {
        console.log(`🔍 [MessageConverter] 处理 file_reference: ${item.value.fileName}, filePath: ${item.value.filePath}`);
        const result = await processFileToPartsList(item.value, workspaceRoot);
        if (result.skipped) {
          console.warn(`⚠️ [MessageConverter] 文件跳过: ${item.value.fileName} - ${result.skipReason}`);
          warnings.push(`File skipped: ${item.value.fileName} - ${result.skipReason}`);
          skippedFiles++;
        } else {
          console.log(`✅ [MessageConverter] 文件内容已添加: ${item.value.fileName}, ${result.parts.length} parts`);
          allParts.push(...result.parts);
          fileParts++;
        }
      } else if (item.type === 'code_reference') {
        // 🎯 代码引用：读取指定范围的文件内容
        console.log(`🔍 [MessageConverter] 处理 code_reference: ${item.value.fileName}, range: ${item.value.startLine}-${item.value.endLine}`);
        const result = await processFileToPartsList(item.value, workspaceRoot);
        if (result.skipped) {
          console.warn(`⚠️ [MessageConverter] 代码引用跳过: ${item.value.fileName} - ${result.skipReason}`);
          warnings.push(`Code reference skipped: ${item.value.fileName} - ${result.skipReason}`);
          skippedFiles++;
        } else {
          console.log(`✅ [MessageConverter] 代码引用内容已添加: ${item.value.fileName}, ${result.parts.length} parts`);
          allParts.push(...result.parts);
          fileParts++;
        }
      } else if (item.type === 'text_file_content') {  // ✨ 新增：直接嵌入的文本文件内容
        // 直接使用嵌入的内容，不需要文件系统访问
        console.log(`✅ [MessageConverter] 处理 text_file_content: ${item.value.fileName}, contentLength: ${item.value.content?.length || 0}`);
        const fileInfo = `--- File: ${item.value.fileName}${item.value.language ? ` (${item.value.language})` : ''} ---`;
        allParts.push({ text: fileInfo });
        allParts.push({ text: item.value.content });
        fileParts++;
      } else if (item.type === 'image_reference') {
        console.log(`🔍 [MessageConverter] 处理 image_reference: ${item.value.fileName}`);
        const part = processImageToPart(item.value);
        allParts.push(part);
        imageParts++;
      } else if (item.type === 'terminal_reference') {
        // 🎯 终端引用：将终端输出作为上下文添加
        console.log(`🔍 [MessageConverter] 处理 terminal_reference: ${item.value.terminalName}`);
        const terminalInfo = `--- Terminal Output: ${item.value.terminalName} ---`;
        allParts.push({ text: terminalInfo });
        if (item.value.output) {
          allParts.push({ text: item.value.output });
        }
        fileParts++; // 计入文件部分（作为上下文内容）
      } else if (item.type === 'folder_reference') {
        // 🚫 严禁展开文件夹内容：只传递路径文本。
        // 原因：展开会将整个文件夹文件塞入上下文，瞬间耗尽模型上下文窗口，导致响应失败/错乱。
        // 如需展开，必须通过显式的“文件夹展开”功能并加上限制/确认，不得在此处修改。
        console.log(`📁 [MessageConverter] 处理 folder_reference: ${item.value.folderName}, path: ${item.value.folderPath}`);
        const folderInfo = `--- Folder: ${item.value.folderName} (${item.value.folderPath}) ---`;
        allParts.push({ text: folderInfo });
      }
      // text类型已经在第一步处理了，这里跳过
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ [MessageConverter] 处理 ${item.type} 时出错:`, errorMessage);
      warnings.push(`Error processing ${item.type}: ${errorMessage}`);
    }
  }

  console.log(`🔍 [MessageConverter] 转换完成: ${allParts.length} parts (text: ${textParts}, file: ${fileParts}, image: ${imageParts}, skipped: ${skippedFiles})`);

  return {
    parts: allParts,
    summary: {
      textParts,
      fileParts,
      imageParts,
      skippedFiles,
      totalParts: allParts.length
    },
    warnings
  };
}

/**
 * 🎯 将原始结构的 MessageContent 转换为字符串显示
 * 支持新的 file_reference 和 image_reference 类型
 */
export function messageContentToString(content: any): string {
  if (!content) {
    return '';
  }

  // 🎯 类型安全检查：如果已经是字符串，直接返回
  if (typeof content === 'string') {
    return content;
  }

  // 🎯 确保content是数组
  if (!Array.isArray(content)) {
    return String(content);
  }

  if (content.length === 0) {
    return '';
  }

  // 🎯 按原始顺序拼装显示内容
  return content.map((part: MessageContentPart) => {
    switch(part.type) {
      case 'text':
        return part.value;
      case 'file_reference':
        return `@[${part.value.fileName}]`;
      case 'image_reference': {
        const imgPath = (part.value as ImageContent).filePath || '';
        return imgPath
          ? `[IMAGE:${part.value.fileName} (${imgPath})]`
          : `[IMAGE:${part.value.fileName}]`;
      }
      case 'code_reference':  // 🎯 代码引用
        return `@[${part.value.fileName} (${part.value.startLine}-${part.value.endLine})]`;
      case 'text_file_content':  // ✨ 新增
        return `@[${part.value.fileName}]`;
      case 'terminal_reference':  // 🎯 终端引用
        return `@[Terminal: ${part.value.terminalName}]`;
      default:
        return '';
    }
  }).join('');
}