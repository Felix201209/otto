/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import * as fs from 'fs';
import * as path from 'path';
import { CommandKind, SlashCommand, CommandContext } from './types.js';
import { ImageGeneratorAdapter, UnauthorizedError, proxyAuthManager } from 'otto-core';
import { MessageType } from '../types.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import { t, tp } from '../utils/i18n.js';
import open from 'open';

const ALLOWED_RATIOS = ['auto', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.tif'];
const MAX_REFERENCE_IMAGES = 5;

// ANSI Color Constants
const COLOR_GREEN = '\u001b[32m';
const COLOR_YELLOW = '\u001b[33m';
const COLOR_RED = '\u001b[31m';
const COLOR_CYAN = '\u001b[36m';
const RESET_COLOR = '\u001b[0m';
const BOLD = '\u001b[1m';

interface ImageTaskStatusWithCredits {
  credits_actual?: number;
  credits_deducted?: number;
}

async function runImageGeneration(context: CommandContext, ratio: string, prompt: string, imagePaths: string[], imageSize?: string) {
  const { addItem } = context.ui;
  const adapter = ImageGeneratorAdapter.getInstance();

  try {
    let fromImgUrl: string | undefined;
    let imageUrls: string[] | undefined;

    if (imagePaths.length > 0) {
      if (context.isNonInteractive) {
        console.error(JSON.stringify({
          type: 'nanobanana_upload_start',
          timestamp: new Date().toISOString(),
          reference_images: imagePaths,
        }));
      } else {
        const pathsDisplay = imagePaths.map(p => `${BOLD}${p}${RESET_COLOR}${COLOR_CYAN}`).join(', ');
        addItem({
          type: MessageType.INFO,
          text: `${COLOR_CYAN}📤 ${tp('nanobanana.uploading_image', { path: pathsDisplay })}${RESET_COLOR}`,
        }, Date.now());
      }

      try {
        // Validate all files exist
        for (const imagePath of imagePaths) {
          if (!fs.existsSync(imagePath)) {
            throw new Error(`Image file not found: ${imagePath}`);
          }
        }

        const userInfo = proxyAuthManager.getUserInfo();
        const username = (userInfo?.name || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');

        if (imagePaths.length === 1) {
          // Single image: use existing /upload-url endpoint
          const imagePath = imagePaths[0];
          const fileBuffer = fs.readFileSync(imagePath);
          const ext = path.extname(imagePath).toLowerCase();
          const contentType = getContentType(ext);
          const random = Math.random().toString(36).substring(2, 10);
          const filename = `${username}-${random}${ext}`;

          const { upload_url, public_url } = await adapter.getUploadUrl(filename, contentType);
          await adapter.uploadImage(upload_url, fileBuffer, contentType);
          fromImgUrl = public_url;
        } else {
          // Multiple images: use batch /upload-urls endpoint
          const filesInfo = imagePaths.map(imagePath => {
            const ext = path.extname(imagePath).toLowerCase();
            const random = Math.random().toString(36).substring(2, 10);
            return {
              filename: `${username}-${random}${ext}`,
              content_type: getContentType(ext),
              buffer: fs.readFileSync(imagePath),
            };
          });

          const uploadResult = await adapter.getUploadUrls(
            filesInfo.map(f => ({ filename: f.filename, content_type: f.content_type }))
          );

          // Upload all files in parallel
          await Promise.all(
            uploadResult.files.map((urlInfo, idx) =>
              adapter.uploadImage(urlInfo.upload_url, filesInfo[idx].buffer, filesInfo[idx].content_type)
            )
          );

          imageUrls = uploadResult.files.map(f => f.public_url);
        }

        if (context.isNonInteractive) {
          console.error(JSON.stringify({
            type: 'nanobanana_upload_success',
            timestamp: new Date().toISOString(),
            reference_images: imagePaths,
            uploaded_urls: fromImgUrl ? [fromImgUrl] : imageUrls,
          }));
        } else {
          addItem({
              type: MessageType.INFO,
              text: `${COLOR_GREEN}✅ ${tp('nanobanana.image_uploaded', { url: '' })}${RESET_COLOR}`,
          }, Date.now());
        }

      } catch (error) {
        if (context.isNonInteractive) {
          console.error(JSON.stringify({
            type: 'nanobanana_upload_failed',
            timestamp: new Date().toISOString(),
            reference_images: imagePaths,
            error: error instanceof Error ? error.message : String(error),
          }));
        } else {
          addItem({
              type: MessageType.ERROR,
              text: `${COLOR_RED}❌ ${tp('nanobanana.upload_failed', { error: error instanceof Error ? error.message : String(error) })}${RESET_COLOR}`,
            }, Date.now());
        }
        return; // Stop if upload fails
      }
    }

    if (!context.isNonInteractive) {
      addItem({
        type: MessageType.INFO,
        text: `${COLOR_CYAN}🎨 ${t('nanobanana.submitting').split('\n')[0]}${RESET_COLOR}\n` +
              `${BOLD}Prompt:${RESET_COLOR} ${COLOR_CYAN}"${prompt}"${RESET_COLOR}\n` +
              `${BOLD}Ratio:${RESET_COLOR} ${COLOR_YELLOW}${ratio}${RESET_COLOR}`,
      }, Date.now());
    }

    const task = await adapter.submitImageGenerationTask(prompt, ratio, fromImgUrl, imageSize, imageUrls);

    const estimatedTime = task.task_info.estimated_time || 60;
    const timeoutSeconds = estimatedTime + 120;
    const startTime = Date.now();

    // Emit credits consumed event if credits were deducted
    if (task.credits_deducted > 0) {
      appEvents.emit(AppEvent.CreditsConsumed, task.credits_deducted);
    }

    if (context.isNonInteractive) {
      // 🆕 非交互模式：输出任务提交成功事件
      console.error(JSON.stringify({
        type: 'nanobanana_submitted',
        timestamp: new Date().toISOString(),
        task_id: task.task_id,
        prompt,
        ratio,
        size: imageSize || 'auto',
        reference_images: imagePaths.length > 0 ? imagePaths : null,
        reference_image_urls: fromImgUrl ? [fromImgUrl] : (imageUrls || null),
        estimated_time_seconds: estimatedTime,
        credits_estimated: task.credits_deducted,
      }));
    } else {
      addItem({
        type: MessageType.INFO,
        text: `${COLOR_GREEN}✅ ${t('nanobanana.submitted').split('\n')[0].replace('{taskId}', `${COLOR_CYAN}${task.task_id}${RESET_COLOR}${COLOR_GREEN}`)}${RESET_COLOR}\n` +
              `${COLOR_YELLOW}💰 ${t('nanobanana.submitted').split('\n')[1].replace('{credits}', `${BOLD}${task.credits_deducted}${RESET_COLOR}${COLOR_YELLOW}`)}${RESET_COLOR}\n` +
              `${COLOR_CYAN}⏳ ${t('nanobanana.submitted').split('\n')[2]}${RESET_COLOR}`,
      }, Date.now());
    }

    // Emit event to show polling spinner
    if (!context.isNonInteractive) {
      appEvents.emit(AppEvent.ImagePollingStart, {
        taskId: task.task_id,
        estimatedTime
      });
    }

    // 🆕 在非交互模式下，使用 Promise 等待轮询完成
    // 在交互模式下，仍然使用原来的 setInterval 触发即忘模式
    if (context.isNonInteractive) {
      // 非交互模式：使用 Promise 包装轮询逻辑，等待完成
      // 输出详细的流式进度信息（伪流式JSON）
      await new Promise<void>((resolve, reject) => {
        let lastProgress = 0;

        const pollInterval = setInterval(async () => {
          try {
            const elapsedSeconds = (Date.now() - startTime) / 1000;

            if (elapsedSeconds > timeoutSeconds) {
              clearInterval(pollInterval);
              const errorMsg = `Task timeout after ${Math.round(elapsedSeconds)} seconds`;
              console.error(JSON.stringify({
                type: 'nanobanana_error',
                timestamp: new Date().toISOString(),
                task_id: task.task_id,
                error: errorMsg,
                elapsed_seconds: Math.round(elapsedSeconds),
              }));
              reject(new Error(errorMsg));
              return;
            }

            const status = await adapter.getImageTaskStatus(task.task_id);

            if (status.status === 'completed') {
              clearInterval(pollInterval);
              const resultUrls = status.result_urls || [];
              const statusWithCredits = status as typeof status & ImageTaskStatusWithCredits;
              const actualCredits = statusWithCredits.credits_actual !== undefined ? statusWithCredits.credits_actual : (statusWithCredits.credits_deducted || 0);

              // 输出完成事件
              console.error(JSON.stringify({
                type: 'nanobanana_completed',
                timestamp: new Date().toISOString(),
                task_id: task.task_id,
                status: 'completed',
                elapsed_seconds: Math.round(elapsedSeconds),
                credits_estimated: task.credits_deducted,
                credits_actual: actualCredits,
                image_urls: resultUrls,
                image_count: resultUrls.length,
              }));

              resolve();
              return;
            } else if (status.status === 'failed') {
              clearInterval(pollInterval);
              const errorMsg = status.error_message || 'Unknown error';

              console.error(JSON.stringify({
                type: 'nanobanana_failed',
                timestamp: new Date().toISOString(),
                task_id: task.task_id,
                status: 'failed',
                error: errorMsg,
                elapsed_seconds: Math.round(elapsedSeconds),
              }));

              reject(new Error(errorMsg));
              return;
            } else {
              // 'pending' or 'processing' - 计算虚假进度百分比
              const estimatedProgress = Math.min(95, Math.floor((elapsedSeconds / estimatedTime) * 100));
              const progress = Math.max(lastProgress, estimatedProgress);
              lastProgress = progress;

              console.error(JSON.stringify({
                type: 'nanobanana_progress',
                timestamp: new Date().toISOString(),
                task_id: task.task_id,
                status: status.status,
                elapsed_seconds: Math.round(elapsedSeconds),
                estimated_seconds: estimatedTime,
                progress_percent: progress,
              }));
            }
          } catch (error) {
            clearInterval(pollInterval);
            console.error(JSON.stringify({
              type: 'nanobanana_error',
              timestamp: new Date().toISOString(),
              task_id: task.task_id,
              error: error instanceof Error ? error.message : String(error),
            }));
            reject(error);
          }
        }, 2000); // 非交互模式下使用2秒轮询间隔
      });
    } else {
      // 交互模式：原有的 setInterval 触发即忘逻辑
      let displayedEstimatedTime = estimatedTime;
      let isFinished = false;

      const pollInterval = setInterval(async () => {
        if (isFinished) {
          clearInterval(pollInterval);
          return;
        }

        try {
          const elapsedSeconds = (Date.now() - startTime) / 1000;

          if (elapsedSeconds > timeoutSeconds) {
            isFinished = true;
            clearInterval(pollInterval);
            addItem({
              type: MessageType.ERROR,
              text: `${COLOR_RED}❌ ${tp('nanobanana.timeout', { seconds: Math.round(elapsedSeconds) })}${RESET_COLOR}`,
            }, Date.now());
            return;
          }

          const status = await adapter.getImageTaskStatus(task.task_id);

          if (isFinished) {
            clearInterval(pollInterval);
            return;
          }

          if (status.status === 'completed') {
            isFinished = true;
            clearInterval(pollInterval);
            appEvents.emit(AppEvent.ImagePollingEnd, { success: true });

            const resultUrls = status.result_urls || [];
            const urlText = resultUrls.map((url, idx) => `${BOLD}Image ${idx + 1}:${RESET_COLOR} ${COLOR_CYAN}${url}${RESET_COLOR}`).join('\n');

            const statusWithCredits = status as typeof status & ImageTaskStatusWithCredits;
            const actualCredits = statusWithCredits.credits_actual !== undefined ? statusWithCredits.credits_actual : (statusWithCredits.credits_deducted || 0);

            addItem({
              type: MessageType.INFO,
              text: `${COLOR_GREEN}🎉 ${t('nanobanana.completed').split('\n')[0]}${RESET_COLOR}\n` +
                    `${COLOR_YELLOW}💰 ${t('nanobanana.completed').split('\n')[1].replace('{credits}', `${BOLD}${actualCredits}${RESET_COLOR}${COLOR_YELLOW}`)}${RESET_COLOR}\n` +
                    `${urlText}`,
            }, Date.now());

            for (const url of resultUrls) {
              try {
                await open(url);
              } catch (err) {
                console.error(`Failed to open URL: ${url}`, err);
              }
            }
          } else if (status.status === 'failed') {
            isFinished = true;
            clearInterval(pollInterval);
            appEvents.emit(AppEvent.ImagePollingEnd, { success: false });

            addItem({
              type: MessageType.ERROR,
              text: `${COLOR_RED}❌ ${tp('nanobanana.failed', { error: status.error_message || 'Unknown error' })}${RESET_COLOR}`,
            }, Date.now());
          } else {
            if (elapsedSeconds > displayedEstimatedTime) {
              displayedEstimatedTime = Math.ceil(elapsedSeconds) + 30;
            }

            appEvents.emit(AppEvent.ImagePollingProgress, {
              elapsed: Math.round(elapsedSeconds),
              estimated: displayedEstimatedTime
            });
          }
        } catch (error) {
          console.error('Polling error:', error);
        }
      }, 1000);
    }

  } catch (error) {
    if (error instanceof UnauthorizedError) {
      addItem({
        type: MessageType.ERROR,
        text: `${COLOR_RED}❌ ${t('nanobanana.auth.failed')}${RESET_COLOR}`,
      }, Date.now());
    } else {
      addItem({
        type: MessageType.ERROR,
        text: `${COLOR_RED}❌ ${tp('nanobanana.submit.failed', { error: error instanceof Error ? error.message : String(error) })}${RESET_COLOR}`,
      }, Date.now());
    }
  }
}

/**
 * Get MIME content type from file extension
 */
function getContentType(ext: string): string {
  switch (ext) {
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.bmp': return 'image/bmp';
    case '.tiff': case '.tif': return 'image/tiff';
    default: return 'image/jpeg';
  }
}

/**
 * 检查文件是否为支持的图片格式
 */
function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

export const nanoBananaCommand: SlashCommand = {
  name: 'NanoBanana',
  altNames: ['nanobanana'],
  description: t('command.nanobanana.description'),
  kind: CommandKind.BUILT_IN,
  action: async (context, args) => {
    const trimmedArgs = args.trim();
    if (!trimmedArgs) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('nanobanana.usage.error'),
      };
    }

    // Parse: <ratio> <size> <prompt> [@image ...]
    // @image can appear anywhere in the command, multiple @images are supported (up to 5)
    // Example: /nanobanana 16:9 2K "A futuristic city" @ref.jpg
    // Example: /nanobanana 16:9 2K @refA.jpg @refB.png "融合两张图"

    // Extract all @image references and remove them from the string
    const imagePaths: string[] = [];
    const atImageRegex = /(?:^|\s)@(?:"([^"]+)"|([^\s]+))/g;
    let argsWithoutImage = trimmedArgs;
    let match;

    // Find all @references that are valid image files
    while ((match = atImageRegex.exec(trimmedArgs)) !== null) {
      const potentialPath = match[1] || match[2];
      if (isImageFile(potentialPath) && imagePaths.length < MAX_REFERENCE_IMAGES) {
        imagePaths.push(potentialPath);
        argsWithoutImage = argsWithoutImage.replace(match[0], ' ');
      }
    }

    // Clean up multiple spaces
    argsWithoutImage = argsWithoutImage.replace(/\s+/g, ' ').trim();

    const parts = argsWithoutImage.split(/\s+/);
    if (parts.length < 2) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('nanobanana.missing.prompt'),
      };
    }

    // Find ratio and size in the parts (they can be in any order among the first few tokens)
    let ratio: string | undefined;
    let imageSize: string | undefined;
    let ratioIndex = -1;
    let sizeIndex = -1;

    for (let i = 0; i < Math.min(parts.length, 3); i++) {
      const part = parts[i];
      const normalizedPart = part.replace(/\*/g, ':').replace(/x/g, ':');

      // Check if it's a ratio
      if (!ratio && ALLOWED_RATIOS.includes(normalizedPart)) {
        ratio = normalizedPart;
        ratioIndex = i;
        continue;
      }

      // Check if it's a size
      if (!imageSize && ['1K', '2K'].includes(part.toUpperCase())) {
        imageSize = part.toUpperCase();
        sizeIndex = i;
        continue;
      }
    }

    // Validate ratio
    if (!ratio) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('nanobanana.usage.error'),
      };
    }

    // Validate size
    if (!imageSize) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('nanobanana.invalid.size'),
      };
    }

    // Extract prompt: everything except ratio and size
    const promptParts = parts.filter((_, i) => i !== ratioIndex && i !== sizeIndex);
    const prompt = promptParts.join(' ').trim();

    if (!prompt) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('nanobanana.missing.prompt'),
      };
    }

    // 🆕 检测是否为非交互模式
    // 在非交互模式下，我们需要等待任务完成并返回结果
    // 在交互模式下，使用触发即忘模式，让任务在后台运行并通过UI更新进度
    if (context.isNonInteractive) {
      // 非交互模式：等待任务完成并返回消息
      try {
        await runImageGeneration(context, ratio, prompt, imagePaths, imageSize);
        return {
          type: 'message',
          messageType: 'info',
          content: `✅ Image generation completed successfully for prompt: "${prompt}"`,
        };
      } catch (error) {
        return {
          type: 'message',
          messageType: 'error',
          content: `❌ Image generation failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    } else {
      // 交互模式：触发即忘
      runImageGeneration(context, ratio, prompt, imagePaths, imageSize);
      // Return void to indicate handled without specific action return type
      return;
    }
  },
  completion: async (_context, partialArg) => {
    const trimmed = partialArg.trim();
    const parts = trimmed.split(/\s+/).filter((p) => p.length > 0);

    // Check if user has trailing space (e.g., "16:9 " with space)
    // This indicates they're moving to the next parameter
    const hasTrailingSpace = partialArg.endsWith(' ') || partialArg.endsWith('\t');

    // First parameter: suggest ratios
    if (parts.length === 0) {
      // User just typed the command name, suggest all ratios
      return ALLOWED_RATIOS;
    }

    if (parts.length === 1 && !hasTrailingSpace) {
      // User typed ratio prefix, suggest matching ratios
      // Normalize for matching (support 1*1, 1x1 formats)
      const normalizedInput = parts[0].replace(/\*/g, ':').replace(/x/g, ':').toLowerCase();
      const matches = ALLOWED_RATIOS.filter((ratio) =>
        ratio.toLowerCase().startsWith(normalizedInput)
      );

      // If user input is an exact match for a ratio, also show size options
      // This handles the case where user typed complete ratio like "16:9" without trailing space
      if (matches.length === 1 && matches[0].toLowerCase() === normalizedInput) {
        return ['1K', '2K'];
      }

      return matches;
    }

    // Second parameter: suggest image sizes
    if ((parts.length === 2 && !hasTrailingSpace) || (parts.length === 1 && hasTrailingSpace)) {
      const sizeOptions = ['1K', '2K'];
      const searchText = hasTrailingSpace ? '' : (parts[1] || '');
      return sizeOptions.filter((size) =>
        size.toLowerCase().startsWith(searchText.toLowerCase())
      );
    }

    // Otherwise, let global @ completion handle file suggestions
    return [];
  },
};
