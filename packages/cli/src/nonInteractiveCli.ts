/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Config,
  ToolCallRequestInfo,
  executeToolCall,
  ToolRegistry,
  shutdownTelemetry,
  isTelemetrySdkInitialized,
  MESSAGE_ROLES,
  MCPDiscoveryState,
  getMCPDiscoveryState,
  waitForMCPDiscoveryComplete,

  areAllFunctionCallsValid,
  fixAllFunctionCalls,
  appearIncompleteFromStreaming,
  getModelCapabilities,
  ToolCallResponseInfo,
  SceneType,
} from 'otto-core';
import {
  Content,
  Part,
  FunctionCall,
  GenerateContentResponse,
  FinishReason,
} from '@google/genai';

import { parseAndFormatApiError } from './ui/utils/errorParsing.js';
import {
  outputInit,
  outputMessage,
  outputToolUse,
  outputToolResult,
  outputError,
  outputResult,
  outputFinalJson,
  MessageBuffer,
} from './utils/streamJsonOutput.js';
import { handleNonInteractiveSlashCommand } from './nonInteractiveSlashCommandHandler.js';
import { LoadedSettings } from './config/settings.js';

function getResponseText(response: GenerateContentResponse): string | null {
  if (response.candidates && response.candidates.length > 0) {
    const candidate = response.candidates[0];
    if (
      candidate.content &&
      candidate.content.parts &&
      candidate.content.parts.length > 0
    ) {
      // We are running in headless mode so we don't need to return thoughts to STDOUT.
      const thoughtPart = candidate.content.parts[0];
      if (thoughtPart?.thought) {
        return null;
      }
      return candidate.content.parts
        .filter((part) => part.text)
        .map((part) => part.text)
        .join('');
    }
  }
  return null;
}

/**
 * Wait for MCP discovery to complete and sync tools into the current toolRegistry.
 *
 * Fix: The original implementation only waited for the discovery state to become
 * COMPLETED, but never synced the globally cached MCP tools into the current
 * toolRegistry instance. This caused MCP tools to be unavailable in non-interactive mode.
 */
async function waitForMcpDiscovery(config: Config): Promise<void> {
  const state = getMCPDiscoveryState();

  // If already complete, sync tools and return immediately
  if (state === MCPDiscoveryState.COMPLETED) {
    const toolRegistry = await config.getToolRegistry();
    await toolRegistry.discoverMcpTools();
    return;
  }

  // If discovery hasn't started yet (setImmediate hasn't fired, or was skipped
  // due to isMCPDiscoveryTriggered guard), trigger it directly and synchronously.
  if (state === MCPDiscoveryState.NOT_STARTED) {
    const toolRegistry = await config.getToolRegistry();
    await toolRegistry.discoverMcpTools();
    return;
  }

  // Discovery is IN_PROGRESS (triggered by a prior initialize call via setImmediate).
  // Wait for it to finish, then sync the results into the current toolRegistry.
  await waitForMCPDiscoveryComplete(15000);
  const toolRegistry = await config.getToolRegistry();
  await toolRegistry.discoverMcpTools();
}

export async function runNonInteractive(
  config: Config,
  input: string,
  prompt_id: string,
  outputFormat: 'stream-json' | 'json' | 'default' = 'default',
  settings?: LoadedSettings,
): Promise<void> {
  await config.initialize();

  // Wait for MCP tools to be discovered before proceeding
  // This ensures extension tools are available when sending prompts
  await waitForMcpDiscovery(config);

  // Handle EPIPE errors when the output is piped to a command that closes early.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      // Exit gracefully if the pipe is closed.
      process.exit(0);
    }
  });

  const geminiClient = config.getOttoClient();
  const toolRegistry: ToolRegistry = await config.getToolRegistry();

  const chat = await geminiClient.getChat();
  const abortController = new AbortController();

  // 🆕 处理斜杠命令预处理
  let processedInput = input;
  let initialFunctionCall: { name: string; args: Record<string, unknown> } | null = null;

  if (settings) {
    const slashCommandResult = await handleNonInteractiveSlashCommand(input, config, settings);

    if (slashCommandResult.type === 'tool_call') {
      // 斜杠命令转换为工具调用
      initialFunctionCall = {
        name: slashCommandResult.toolName,
        args: slashCommandResult.toolArgs,
      };
      if (outputFormat === 'stream-json') {
        outputMessage('user', input);
      }
    } else if (slashCommandResult.type === 'submit_prompt') {
      // 斜杠命令转换为新的prompt
      processedInput = slashCommandResult.content;
      if (outputFormat === 'stream-json') {
        outputMessage('user', input);
        // Note: Converted prompt will be sent as the actual user message
      }
    } else if (slashCommandResult.type === 'complete') {
      // 🆕 命令已完成，直接输出结果并退出
      if (outputFormat === 'stream-json') {
        outputMessage('user', input);
        outputMessage('assistant', slashCommandResult.message);
        outputResult(slashCommandResult.success ? 'success' : 'error', {
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          duration_ms: 0,
        });
      } else if (outputFormat === 'json') {
        outputFinalJson({
          model: config.getModel(),
          content: slashCommandResult.message,
          status: slashCommandResult.success ? 'success' : 'error',
        });
      } else {
        console.log(slashCommandResult.message);
      }
      process.exit(slashCommandResult.success ? 0 : 1);
    } else if (slashCommandResult.type === 'unsupported') {
      // 不支持的斜杠命令
      if (outputFormat === 'stream-json') {
        outputError(slashCommandResult.reason);
        outputResult('error');
      } else if (outputFormat === 'json') {
        outputFinalJson({
          model: config.getModel(),
          content: '',
          status: 'error',
          error: slashCommandResult.reason,
        });
      } else {
        console.error(`Error: ${slashCommandResult.reason}`);
      }
      process.exit(1);
    }
    // type === 'not_slash_command' 时，继续正常处理
  }

  let currentMessages: Content[] = [{ role: MESSAGE_ROLES.USER, parts: [{ text: processedInput }] }];
  let turnCount = 0;
  const modelName = config.getModel();
  const modelCapabilities = getModelCapabilities(modelName);

  // Buffer for coalescing assistant message deltas in stream-json mode
  const messageBuffer = outputFormat === 'stream-json' ? new MessageBuffer() : null;

  // Accumulate full response text for json mode (single final JSON output)
  const isJsonMode = outputFormat === 'json';
  let jsonAccumulatedText = '';

  // Output init event if in stream-json mode
  if (outputFormat === 'stream-json') {
    outputInit(config.getSessionId(), modelName);
    if (!initialFunctionCall) {
      outputMessage('user', processedInput);
    }
  }

  try {
    // 🆕 如果有初始工具调用（来自斜杠命令），直接执行工具，跳过第一轮LLM调用
    if (initialFunctionCall) {
      const callId = `${initialFunctionCall.name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const requestInfo: ToolCallRequestInfo = {
        callId,
        name: initialFunctionCall.name,
        args: initialFunctionCall.args,
        isClientInitiated: true, // 标记为客户端发起
        prompt_id,
      };

      if (outputFormat === 'stream-json') {
        outputToolUse(initialFunctionCall.name, callId, initialFunctionCall.args);
      }

      try {
        const toolResponse = await executeToolCall(
          config,
          requestInfo,
          toolRegistry,
          abortController.signal,
        );

        if (toolResponse.error) {
          const resultDisplay = toolResponse.resultDisplay
            ? typeof toolResponse.resultDisplay === 'string'
              ? toolResponse.resultDisplay
              : JSON.stringify(toolResponse.resultDisplay)
            : toolResponse.error.message;

          if (outputFormat === 'stream-json') {
            outputToolResult(callId, 'error', resultDisplay);
            outputError(resultDisplay);
            outputResult('error');
          } else if (isJsonMode) {
            outputFinalJson({
              model: modelName,
              content: '',
              status: 'error',
              error: resultDisplay,
            });
          } else {
            console.error(`Error executing tool ${initialFunctionCall.name}: ${resultDisplay}`);
          }
          process.exit(1);
        }

        // 工具执行成功，输出结果
        if (toolResponse.resultDisplay) {
          const resultText = typeof toolResponse.resultDisplay === 'string'
            ? toolResponse.resultDisplay
            : JSON.stringify(toolResponse.resultDisplay);

          if (outputFormat === 'stream-json') {
            outputToolResult(callId, 'success', resultText);
            outputResult('success', {
              total_tokens: 0,
              input_tokens: 0,
              output_tokens: 0,
              duration_ms: 0,
            });
          } else if (isJsonMode) {
            outputFinalJson({
              model: modelName,
              content: resultText,
              status: 'success',
            });
          } else {
            console.log(resultText);
          }
        }

        // 斜杠命令工具调用完成，直接返回
        return;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (outputFormat === 'stream-json') {
          outputToolResult(callId, 'error', errorMsg);
          outputError(errorMsg);
          outputResult('error');
        } else if (isJsonMode) {
          outputFinalJson({
            model: modelName,
            content: '',
            status: 'error',
            error: errorMsg,
          });
        } else {
          console.error(`Exception executing tool ${initialFunctionCall.name}:`, error);
        }
        process.exit(1);
      }
    }

    while (true) {
      turnCount++;
      if (
        config.getMaxSessionTurns() > 0 &&
        turnCount > config.getMaxSessionTurns()
      ) {
        console.error(
          '\n Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.',
        );
        return;
      }
      const functionCalls: FunctionCall[] = [];
      let lastFinishReason: FinishReason | undefined;
      let streamingIncomplete = false;

      const responseStream = await chat.sendMessageStream(
        {
          message: currentMessages[0]?.parts || [], // Ensure parts are always provided
          config: {
            abortSignal: abortController.signal,
            tools: [
              { functionDeclarations: toolRegistry.getFunctionDeclarations() },
            ],
          },
        },
        prompt_id,
        SceneType.CHAT_CONVERSATION
      );

      for await (const resp of responseStream) {
        if (abortController.signal.aborted) {
          console.error('Operation cancelled.');
          return;
        }

        // Track finish reason for error handling
        if (resp.candidates?.[0]?.finishReason) {
          lastFinishReason = resp.candidates[0].finishReason;
        }

        const textPart = getResponseText(resp);
        if (textPart) {
          if (messageBuffer) {
            messageBuffer.append(textPart);
          } else if (isJsonMode) {
            jsonAccumulatedText += textPart;
          } else {
            process.stdout.write(textPart);
          }
        }
        if (resp.functionCalls) {
          functionCalls.push(...resp.functionCalls);
        }
      }

      // Flush buffered text before processing tool calls or finishing the turn
      messageBuffer?.flush();

      // Check for streaming completeness issues in small models
      if (modelCapabilities.proneToIncompleteStream && functionCalls.length > 0) {
        streamingIncomplete = appearIncompleteFromStreaming(functionCalls, modelName);

        if (streamingIncomplete) {
          if (outputFormat !== 'stream-json') {
            console.error('\n⚠️  Detected incomplete function calls from streaming. Attempting to fix...');
          }
        }
      }

      if (functionCalls.length > 0) {
        // Validate and fix function calls for small models
        let processedFunctionCalls = functionCalls;

        if (modelCapabilities.needsFormatTolerance || streamingIncomplete) {
          const allValid = areAllFunctionCallsValid(functionCalls, modelName);

          if (!allValid || streamingIncomplete) {
            // Only show in non-stream-json mode
            if (outputFormat !== 'stream-json') {
              console.error('\n🔧 Fixing function call format issues...');
            }
            processedFunctionCalls = fixAllFunctionCalls(functionCalls, modelName);

            // Validate again after fixing
            const stillInvalid = !areAllFunctionCallsValid(processedFunctionCalls, modelName);
            if (stillInvalid && !modelCapabilities.enableMalformedRetry) {
              if (outputFormat === 'stream-json') {
                outputError('Function calls remain invalid after fixing. Aborting.');
              } else if (isJsonMode) {
                outputFinalJson({
                  model: modelName,
                  content: jsonAccumulatedText,
                  status: 'error',
                  error: 'Function calls remain invalid after fixing. Aborting.',
                });
              } else {
                console.error('\n❌ Function calls remain invalid after fixing. Aborting.');
              }
              process.exit(1);
            }
          }
        }

        // Handle malformed function call finish reason
        if (lastFinishReason === FinishReason.MALFORMED_FUNCTION_CALL && modelCapabilities.enableMalformedRetry) {
          if (outputFormat !== 'stream-json') {
            console.error('\n🔄 Model reported malformed function call. Retrying with fixed format...');
          }
          processedFunctionCalls = fixAllFunctionCalls(functionCalls, modelName);
        }

        const toolResponseParts: Part[] = [];
        const maxConcurrent = modelCapabilities.maxConcurrentTools;

        // Process tools with concurrency limit for small models
        const chunkedCalls = [];
        for (let i = 0; i < processedFunctionCalls.length; i += maxConcurrent) {
          chunkedCalls.push(processedFunctionCalls.slice(i, i + maxConcurrent));
        }

        for (const chunk of chunkedCalls) {
          const chunkPromises = chunk.map(async (fc) => {
            const callId = fc.id ?? `${fc.name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const requestInfo: ToolCallRequestInfo = {
              callId,
              name: fc.name as string,
              args: (fc.args ?? {}) as Record<string, unknown>,
              isClientInitiated: false,
              prompt_id,
            };

            try {
              // Output tool use for stream-json
              if (outputFormat === 'stream-json') {
                outputToolUse(fc.name as string, callId, (fc.args ?? {}) as Record<string, unknown>);
              }

              const toolResponse = await executeToolCall(
                config,
                requestInfo,
                toolRegistry,
                abortController.signal,
              );

              if (toolResponse.error) {
                const resultDisplay = toolResponse.resultDisplay
                  ? typeof toolResponse.resultDisplay === 'string'
                    ? toolResponse.resultDisplay
                    : JSON.stringify(toolResponse.resultDisplay)
                  : toolResponse.error.message;
                if (outputFormat === 'stream-json') {
                  outputToolResult(callId, 'error', resultDisplay);
                } else {
                  console.error(`Error executing tool ${fc.name}: ${resultDisplay}`);
                }
                // Return the error as a functionResponse so the AI can see it and retry
                return {
                  callId,
                  responseParts: [{
                    functionResponse: {
                      id: callId,
                      name: fc.name ?? '',
                      response: { error: resultDisplay },
                    },
                  }],
                  resultDisplay,
                  error: toolResponse.error,
                } satisfies ToolCallResponseInfo;
              }

              return toolResponse;
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              if (outputFormat === 'stream-json') {
                outputToolResult(callId, 'error', errorMsg);
              } else {
                console.error(`Exception executing tool ${fc.name}:`, error);
              }
              return null;
            }
          });

          const chunkResults = await Promise.all(chunkPromises);

          for (let i = 0; i < chunkResults.length; i++) {
            const toolResponse = chunkResults[i];
            const fc = chunk[i];
            const callId = fc.id ?? `${fc.name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            if (toolResponse?.responseParts) {
              const parts = Array.isArray(toolResponse.responseParts)
                ? toolResponse.responseParts
                : [toolResponse.responseParts];
              for (const part of parts) {
                let outputForJson = '';

                if (typeof part === 'string') {
                  // Direct string output
                  outputForJson = part;
                  toolResponseParts.push({ text: part });
                } else if (part && typeof part === 'object') {
                  // Try to extract the actual output from nested functionResponse
                  let actualOutput = '';
                  const typedPart = part as Part & { output?: unknown };
                  const response = typedPart.functionResponse?.response;
                  const responseRecord =
                    response && typeof response === 'object'
                      ? (response as Record<string, unknown>)
                      : undefined;
                  if (responseRecord?.output) {
                    actualOutput = String(responseRecord.output);
                  } else if (typedPart.output) {
                    actualOutput = String(typedPart.output);
                  } else {
                    actualOutput = JSON.stringify(part);
                  }
                  outputForJson = actualOutput;
                  toolResponseParts.push(part);
                } else if (part) {
                  outputForJson = String(part);
                  toolResponseParts.push(part);
                }

                // Output to JSON stream, with truncation for long outputs
                if (outputFormat === 'stream-json' && outputForJson) {
                  const outputStr = outputForJson.length > 500
                    ? `${outputForJson.substring(0, 500)}... [truncated ${outputForJson.length - 500} chars]`
                    : outputForJson;
                  outputToolResult(callId, 'success', outputStr);
                }
              }
            }
          }
        }

        // Note: tool failures are returned as functionResponse errors so the AI
        // can see them and retry with corrected parameters, instead of exiting.

        currentMessages = [{ role: MESSAGE_ROLES.USER, parts: toolResponseParts }];
      } else {
        if (outputFormat === 'stream-json') {
          outputResult('success', {
            total_tokens: 0, // TODO: track token usage
            input_tokens: 0,
            output_tokens: 0,
            duration_ms: 0,
          });
        } else if (isJsonMode) {
          outputFinalJson({
            model: modelName,
            content: jsonAccumulatedText,
            status: 'success',
          });
        } else {
          process.stdout.write('\n'); // Ensure a final newline
        }
        return;
      }
    }
  } catch (error) {
    // Flush any remaining buffered text before reporting the error
    messageBuffer?.flush();

    const errorMsg = parseAndFormatApiError(
      error,
      config.getContentGeneratorConfig()?.authType,
      undefined,
      config.getModel(),
    );
    if (outputFormat === 'stream-json') {
      outputError(errorMsg);
      outputResult('error');
    } else if (isJsonMode) {
      outputFinalJson({
        model: modelName,
        content: jsonAccumulatedText,
        status: 'error',
        error: errorMsg,
      });
    } else {
      console.error(errorMsg);
    }
    process.exit(1);
  } finally {
    if (isTelemetrySdkInitialized()) {
      await shutdownTelemetry();
    }
  }
}
