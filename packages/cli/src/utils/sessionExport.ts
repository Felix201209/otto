/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */
import { SessionManager } from 'otto-core';
import { promises as fs } from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

function revealFile(filePath: string): Promise<void> {
  return new Promise((resolve) => {
    const platform = process.platform;

    try {
      if (platform === 'darwin') {
        execFile('open', ['-R', filePath], (error) => {
          if (error) {
            console.warn(`Unable to open file in Finder: ${error.message}`);
          }
          resolve();
        });
      } else if (platform === 'win32') {
        // Windows: use explorer.exe /select,"path\to\file"
        // The comma after /select is important for some Windows versions
        // and we ensure the path uses backslashes
        const winPath = path.win32.normalize(filePath);
        execFile('explorer.exe', [`/select,${winPath}`], (error) => {
          if (error) {
            console.warn(`Unable to open file in Explorer: ${error.message}`);
          }
          resolve();
        });
      } else {
        // Linux: use xdg-open with directory path
        execFile('xdg-open', [path.dirname(filePath)], (error) => {
          if (error) {
            console.warn(`Unable to open file browser: ${error.message}`);
          }
          resolve();
        });
      }
    } catch (error) {
      console.warn(`Error opening file browser: ${error instanceof Error ? error.message : String(error)}`);
      resolve();
    }
  });
}

export async function exportSessionToMarkdown(
  sessionId: string,
  projectRoot: string
): Promise<string> {
  // Check write permission before processing
  try {
    await fs.access(projectRoot, fs.constants.W_OK);
  } catch (error) {
    throw new Error(
      `No write permission for project root: ${projectRoot}. ` +
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Load session data
  const sessionManager = new SessionManager(projectRoot);
  let sessionData;
  try {
    sessionData = await sessionManager.loadSession(sessionId);
  } catch (error) {
    throw new Error(
      `Failed to load session ${sessionId}. ` +
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Validate session data integrity
  if (!sessionData) {
    throw new Error(`Session ${sessionId} not found or returned null.`);
  }

  if (!sessionData.history) {
    throw new Error(`Session ${sessionId} has no history. Session data may be corrupted.`);
  }

  if (sessionData.history.length === 0) {
    throw new Error(`Session ${sessionId} has empty history.`);
  }

  if (!sessionData.metadata) {
    console.warn(`Session ${sessionId} metadata is missing. Using defaults.`);
    sessionData.metadata = {
      title: sessionId,
      createdAt: new Date().toISOString(),
      model: 'Unknown',
    } as any;
  }

  const n = String.fromCharCode(10);
  let markdown = '# Session Log: ' + (sessionData.metadata.title || sessionId) + n + n;

  markdown += '- **Session ID:** ' + sessionId + n;
  markdown += '- **Date:** ' + new Date(sessionData.metadata.createdAt || new Date()).toLocaleString() + n;
  markdown += '- **Model:** ' + (sessionData.metadata.model || 'Unknown') + n + n;
  markdown += '---' + n + n;

  // Create a map of callId -> args from clientHistory to avoid cluttering UI history
  const toolArgsMap = new Map<string, any>();
  if (sessionData.clientHistory && Array.isArray(sessionData.clientHistory)) {
    for (const message of sessionData.clientHistory) {
      if (message.parts && Array.isArray(message.parts)) {
        for (const part of message.parts) {
          if (part.functionCall && part.functionCall.id) {
            toolArgsMap.set(part.functionCall.id, part.functionCall.args);
          }
        }
      }
    }
  }

  function exportToolCalls(tools: any[], indent = 0): string {
    let result = '';
    const prefix = ' '.repeat(indent);
    for (const tool of tools) {
      // 🎯 修复 1：参数提取逻辑。优先从 clientHistory 映射中获取，旧会话 fallback 到 confirmationDetails
      const toolArgs = toolArgsMap.get(tool.callId) || tool.confirmationDetails?.args || {};
      const toolPath = toolArgs.absolute_path || toolArgs.file_path || toolArgs.path || toolArgs.filePath;
      const displayName = toolPath ? `${tool.name}: ${toolPath}` : tool.name;

      result += prefix + '<details>' + n;
      result += prefix + '<summary>' + displayName + ' (' + (tool.status || 'Success') + ')</summary>' + n + n;

      // 🎯 修复 2：缩进逻辑。使用统一的换行符 n，并确保代码块内部正确缩进
      const jsonContent = JSON.stringify(toolArgs, null, 2);
      const indentedJson = jsonContent.split('\n').map(line => prefix + line).join(n);

      result += prefix + '**Arguments:**' + n + prefix + '```json' + n + indentedJson + n + prefix + '```' + n + n;

      if (tool.resultDisplay) {
        // 对结果内容也进行必要的换行处理
        const resultContent = (tool.resultDisplay.content || '').split('\n').map((line: string) => prefix + line).join(n);
        result += prefix + '**Result:**' + n + resultContent + n + n;
      }

      if (tool.subToolCalls && Array.isArray(tool.subToolCalls) && tool.subToolCalls.length > 0) {
        result += prefix + '#### ↳ Sub-tool Calls' + n + n;
        result += exportToolCalls(tool.subToolCalls, indent + 2);
      }

      result += prefix + '</details>' + n + n;
    }
    return result;
  }

  for (const item of sessionData.history) {
    if (item.type === 'user') {
      const text = (item.text || '').trim();
      if (text) {
        markdown += '### 👤 User' + n + n + text + n + n;
      }
    } else if (item.type === 'gemini' || item.type === 'gemini_content') {
      const text = (item.text || '').trim();
      if (text) {
        markdown += '### 🤖 Assistant' + n + n + text + n + n;
      }
    } else if (item.type === 'deepv') {
      const content = (item.content || '').trim();
      if (content) {
        markdown += '### 🤖 Assistant (System)' + n + n + content + n + n;
      }
    } else if (item.type === 'tool_group') {
      if (item.tools && Array.isArray(item.tools) && item.tools.length > 0) {
        const toolsMarkdown = exportToolCalls(item.tools, 0);
        if (toolsMarkdown.trim()) {
          markdown += '#### 🛠️ Tool Calls' + n + n;
          markdown += toolsMarkdown;
        }
      }
    }
  }

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const fileName = 'session_export_' + sessionId.substring(0, 8) + '_' + timestamp + '.md';
  const exportPath = path.resolve(projectRoot, fileName);

  try {
    await fs.writeFile(exportPath, markdown, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to write session export file to ${exportPath}. ` +
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  await revealFile(exportPath);
  return exportPath;
}