/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useDebateWizard — Host-side glue for the /debate command.
 *
 * Responsibilities:
 * - Own the wizard open/closed state
 * - Enumerate available models (built-in + custom + cached cloud)
 * - On wizard complete: save preset, start runtime debate, switch to the
 *   first model, and submit the opening phrase via submitQuery
 * - On wizard cancel: close silently
 */

import { useCallback, useState, type MutableRefObject } from 'react';
import process from 'node:process';
import { Config, isCustomModel, generateCustomModelId } from 'otto-core';
import type { PartListUnion } from '@google/genai';
import { MessageType } from '../types.js';
import type { HistoryItem } from '../types.js';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import {
  DebateWizardAvailableModel,
  DebateWizardResult,
} from '../components/DebateWizard.js';
import {
  startDebate,
  getActiveDebate,
  advanceCursor,
  endDebate,
  resumeDebate,
  pauseDebate,
  isLastTurn,
} from '../utils/debateState.js';
import { pickOpening, pickFollowup, buildSummaryPrompt, DEBATE_SUMMARY_MODEL, DEBATE_SUMMARY_FALLBACK_MODEL } from '../utils/debatePhrases.js';
import { getDebateI18nTexts } from '../utils/debateI18n.js';
import { detectUILanguage } from '../utils/debateLanguageUtils.js';
import { loadPresets, savePreset, DebatePreset } from '../utils/debateStorage.js';
import { loadCustomModels } from '../../config/customModelsStorage.js';

interface UseDebateWizardReturn {
  isDebateWizardOpen: boolean;
  debateWizardModels: DebateWizardAvailableModel[];
  debateWizardPresets: DebatePreset[];
  debatePreferredLanguage: string | undefined;
  openDebateWizard: () => void;
  handleDebateWizardComplete: (result: DebateWizardResult) => void;
  handleDebateWizardCancel: () => void;
  handleDebateLanguageSelected: (language: string) => void;
  /** Resume a paused debate: switch to next speaker, submit followup. */
  handleResumeDebate: () => void;
}

/**
 * Enumerate all models the user can pick from in the debate wizard.
 *
 * Strategy:
 * - Start from the `cloudModels` cached in settings (populated by /model).
 *   These are the "official" models available on the proxy server.
 * - Append custom models from custom-models.json.
 * - Filter out anything disabled.
 * - Deduplicate by ID (shouldn't happen in practice but safe).
 */
function enumerateAvailableModels(
  settings: LoadedSettings,
  config: Config | null,
): DebateWizardAvailableModel[] {
  const out: DebateWizardAvailableModel[] = [];
  const seen = new Set<string>();

  // Built-in / cloud models from settings cache (typed via LoadedSettings.merged).
  const cloudModels = settings.merged.cloudModels;
  if (Array.isArray(cloudModels)) {
    for (const m of cloudModels) {
      if (!m || m.available === false) continue;
      const id = m.name;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        label: m.displayName || id,
        description: undefined,
      });
    }
  }

  // Custom models.
  try {
    const customs = loadCustomModels();
    for (const cm of customs) {
      if (cm.enabled === false) continue;
      const id = generateCustomModelId(cm);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        label: cm.displayName || id,
        description: `${cm.provider} · ${cm.baseUrl}`,
      });
    }
  } catch {
    // ignore — custom model enumeration is best-effort
  }

  // Fallback: if nothing found, at least surface the currently active model.
  if (out.length === 0 && config) {
    const current = config.getModel();
    if (current) {
      out.push({
        id: current,
        label: isCustomModel(current) ? `${current} (custom)` : current,
      });
    }
  }

  return out;
}

export function useDebateWizard(args: {
  settings: LoadedSettings;
  config: Config | null;
  addItem: (item: Omit<HistoryItem, 'id'>, timestamp: number) => void;
  submitQuery: (
    query: PartListUnion,
    options?: { isContinuation?: boolean; silent?: boolean },
  ) => void;
  /**
   * Shared ref for the AbortController driving debate-related async work
   * (model switching for both the opening turn and subsequent turns). Letting
   * useGeminiStream observe the same ref means ESC / pauseDebate can interrupt
   * a switchModel that's in flight — including the very first switch.
   */
  advanceAbortRef: MutableRefObject<AbortController | null>;
}): UseDebateWizardReturn {
  const { settings, config, addItem, submitQuery, advanceAbortRef } = args;

  const [isOpen, setIsOpen] = useState(false);
  const [models, setModels] = useState<DebateWizardAvailableModel[]>([]);
  const [presets, setPresets] = useState<DebatePreset[]>([]);

  const openDebateWizard = useCallback(() => {
    // Fresh snapshot on each open — users may have added models since last time.
    setModels(enumerateAvailableModels(settings, config));
    const projectRoot = config?.getProjectRoot() || process.cwd();
    setPresets(loadPresets(projectRoot));
    setIsOpen(true);
  }, [settings, config]);

  const handleDebateWizardCancel = useCallback(() => {
    setIsOpen(false);
    addItem(
      {
        type: MessageType.INFO,
        text: 'ℹ️ 辩论配置已取消。',
      },
      Date.now(),
    );
  }, [addItem]);

  const handleDebateWizardComplete = useCallback(
    async (result: DebateWizardResult) => {
      setIsOpen(false);

      // 1) Persist as a preset for future /debate invocations.
      const projectRoot = config?.getProjectRoot() || process.cwd();
      savePreset(projectRoot, {
        topic: result.topic,
        models: result.models,
        rounds: result.rounds,
      });

      // 2) If a debate is already running, prevent double-starting (safety check)
      const existing = getActiveDebate();
      if (existing && existing.status === 'running') {
        addItem(
          {
            type: MessageType.ERROR,
            text: '⚠️ 已经有一场辩论正在进行。',
          },
          Date.now(),
        );
        return;
      }

      // 3) Install runtime state. The cursor points at (round=0, modelIdx=0),
      //    meaning the FIRST model is the one about to speak.
      try {
        startDebate({
          topic: result.topic,
          models: result.models,
          rounds: result.rounds,
          language: result.language,
          originalModel: config?.getModel(),
        });
      } catch (err) {
        addItem(
          {
            type: MessageType.ERROR,
            text: `❌ 无法启动辩论：${err instanceof Error ? err.message : String(err)}`,
          },
          Date.now(),
        );
        return;
      }

      // 4) Announce the debate.
      addItem(
        {
          type: MessageType.INFO,
          text:
            `🎭 辩论开始\n` +
            `   话题：${result.topic}\n` +
            `   参赛：${result.models.join(' → ')}\n` +
            `   语言：${result.language}\n` +
            `   每人 ${result.rounds} 轮，共 ${result.models.length * result.rounds} 轮发言\n` +
            `   📌 规则：每位发言前必须先调用工具阅读代码，以自己的阅读结果为准再下结论\n` +
            `   按 Esc 可暂停，用 /debate continue 恢复、/debate end 结束`,
        },
        Date.now(),
      );

      // 5) 强制切换到第一个模型并等待完成，然后再发开场白。
      //    不做 currentModel === firstModel 的短路——switchModel 内部会处理
      //    "已是同一模型"的情况（注入历史标记但跳过实际 API 切换）。
      //    这样保证开场白一定在正确的模型下发出。
      //
      //    switchModel 不会 throw——失败时返回 { success:false, error }。必须
      //    显式检查，否则会把开场白发给旧模型。
      const firstModel = result.models[0]!;
      const client = config?.getGeminiClient();

      // 复用 useGeminiStream 暴露的 ref：ESC 路径 abort 这个 controller 就能
      // 打断首启 switchModel，同时 pauseDebate 后也会打断后续推进。
      const abortController = new AbortController();
      advanceAbortRef.current = abortController;

      // 不再打"🎭 切换到 X..."的瞬时提示——DebateIndicator 常驻显示当前发言
      // 模型，不会被 React 18 批处理/流式响应吞掉。切换失败时仍然打 ERROR。

      try {
        if (!client) throw new Error('GeminiClient 未就绪');
        const switchResult = await client.switchModel(
          firstModel,
          abortController.signal,
        );
        if (!switchResult.success) {
          addItem(
            {
              type: MessageType.ERROR,
              text: `❌ 切换到 ${firstModel} 失败：${switchResult.error ?? '未知错误'}`,
            },
            Date.now(),
          );
          endDebate();
          return;
        }
        // 切换成功：emit ModelChanged 让 footer 等组件更新显示。
        // 压缩信息若有则打一条 INFO（一次性的有价值信息，不是"切换提示"），
        // 没有压缩就不打任何消息——当前发言模型由 DebateIndicator 常驻展示。
        appEvents.emit(AppEvent.ModelChanged, firstModel);
        if (switchResult.compressionInfo) {
          addItem(
            {
              type: MessageType.INFO,
              text: `📦 上下文压缩：${switchResult.compressionInfo.originalTokenCount} → ${switchResult.compressionInfo.newTokenCount} tokens`,
            },
            Date.now(),
          );
        }
      } catch (err) {
        // 被 ESC 主动中止：不报错，保留 debate 以便 continue 恢复
        if (abortController.signal.aborted) return;
        addItem(
          {
            type: MessageType.ERROR,
            text: `❌ 切换到 ${firstModel} 失败：${err instanceof Error ? err.message : String(err)}`,
          },
          Date.now(),
        );
        endDebate();
        return;
      } finally {
        // 清掉 ref，避免后续 pauseDebate 误 abort 已完成的 controller
        if (advanceAbortRef.current === abortController) {
          advanceAbortRef.current = null;
        }
      }

      // 6) switchModel 成功 → 发开场白触发模型 0 说话。
      //    注意：此刻 cursor 维持 (0,0)。遵循 "CURRENT speaker" 语义 —
      //    cursor 始终指向刚刚/正在说话的那个人。后续每次 Idle 事件由
      //    useGeminiStream 的推进块决定下一位，switch 成功后再 advanceCursor。
      //
      //    关键：submitQuery 内部会立刻 setIsResponding(true)，与上面的 addItem
      //    会被 React 18 batching 合并，导致"已切换到 xxx"行被流式响应覆盖看
      //    不见。用 setTimeout(50) 把 submitQuery 推到下一帧，保证 confirm 行
      //    先 commit 到终端。
      setTimeout(() => {
        if (getActiveDebate()?.status !== 'running') return;
        submitQuery(pickOpening(result.topic, result.language));
      }, 50);
    },
    [config, addItem, submitQuery, advanceAbortRef],
  );

  // Resume a paused debate. Core logic mirrors the auto-advance block in
  // useGeminiStream: compute next speaker -> switchModel -> advanceCursor ->
  // submit followup. Kept here because this hook has stable access to
  // geminiClient and submitQuery.
  const handleResumeDebate = useCallback(async () => {
    const debate = getActiveDebate();
    if (!debate) {
      addItem(
        {
          type: MessageType.INFO,
          text: 'ℹ️ 当前没有辩论可恢复。',
        },
        Date.now(),
      );
      return;
    }
    if (debate.status === 'running') {
      addItem(
        {
          type: MessageType.INFO,
          text: 'ℹ️ 辩论已在运行中。',
        },
        Date.now(),
      );
      return;
    }
    if (debate.status === 'done') {
      addItem(
        {
          type: MessageType.INFO,
          text: 'ℹ️ 辩论已结束。用 /debate 开始新的。',
        },
        Date.now(),
      );
      return;
    }

    const client = config?.getGeminiClient();
    if (!client) {
      addItem(
        {
          type: MessageType.ERROR,
          text: '❌ GeminiClient 未就绪，无法恢复辩论。',
        },
        Date.now(),
      );
      return;
    }

    // 计算下一位说话人（CURRENT 语义：cursor 指向刚刚/正在说话的人，
    // 暂停多半发生在这个人的流式响应期间，当前模型 == cursor 指向的模型）。
    let nextModelIdx = debate.cursor.modelIdx + 1;
    let nextRound = debate.cursor.round;
    if (nextModelIdx >= debate.models.length) {
      nextModelIdx = 0;
      nextRound += 1;
    }
    const isDebateFinished = nextRound >= debate.rounds;

    // 先把状态切回 running 再开始异步工作。失败路径会再 pauseDebate 回去。
    resumeDebate();

    if (isDebateFinished) {
      const finishedDebate = debate;
      advanceCursor();
      endDebate();
      const summaryTexts = getDebateI18nTexts(
        detectUILanguage(finishedDebate.language),
      );
      addItem(
        { type: MessageType.INFO, text: summaryTexts.summaryGenerating },
        Date.now(),
      );

      // 手动恢复到最后一轮结束时，尝试切换大上下文模型做总结
      const client = config?.getGeminiClient();
      const abortController = new AbortController();
      advanceAbortRef.current = abortController;

      if (client) {
        let summaryModel = DEBATE_SUMMARY_MODEL;
        let switchResult = await client.switchModel(
          summaryModel,
          abortController.signal,
        );
        if (!abortController.signal.aborted && !switchResult.success) {
          await client.switchModel(
            DEBATE_SUMMARY_FALLBACK_MODEL,
            abortController.signal,
          );
        }
      }

      if (abortController.signal.aborted) return;

      setTimeout(() => {
        submitQuery(
          buildSummaryPrompt(
            finishedDebate.topic,
            finishedDebate.models,
            finishedDebate.language,
          ),
        );
        // 总结请求发出后，异步执行模型还原
        if (finishedDebate.originalModel) {
          const originalModel = finishedDebate.originalModel;
          const geminiClient = config?.getGeminiClient();
          if (geminiClient) {
            setTimeout(async () => {
              try {
                await geminiClient.switchModel(
                  originalModel,
                  new AbortController().signal,
                );
                appEvents.emit(AppEvent.ModelChanged, originalModel);
              } catch (err) {
                console.warn(`[Debate] Failed to restore original model ${originalModel}:`, err);
              }
            }, 100);
          }
        }
      }, 0);
      return;
    }

    const nextModel = debate.models[nextModelIdx]!;
    const abortController = new AbortController();
    advanceAbortRef.current = abortController;

    // 不再打瞬时"切换到 X..."提示，DebateIndicator 常驻展示当前发言。

    try {
      const switchResult = await client.switchModel(
        nextModel,
        abortController.signal,
      );
      if (abortController.signal.aborted) return;
      if (!switchResult.success) {
        pauseDebate();
        addItem(
          {
            type: MessageType.ERROR,
            text: `⚠️ 恢复辩论失败：切换到 ${nextModel} 失败（${switchResult.error ?? '未知错误'}）。再次 /debate continue 可重试。`,
          },
          Date.now(),
        );
        return;
      }
      // 切换成功：emit ModelChanged；压缩信息（若有）打一条 INFO。
      appEvents.emit(AppEvent.ModelChanged, nextModel);
      if (switchResult.compressionInfo) {
        addItem(
          {
            type: MessageType.INFO,
            text: `📦 上下文压缩：${switchResult.compressionInfo.originalTokenCount} → ${switchResult.compressionInfo.newTokenCount} tokens`,
          },
          Date.now(),
        );
      }

      // 推进 cursor，再发 followup。不再需要 setTimeout 规避 batching
      // （因为不再有需要"抢救显示"的确认行），但保留 0ms 让出一帧，让
      // DebateIndicator 的状态 poll 有机会刷新到新模型。
      advanceCursor();
      // 拿到推进后的 debate（包括正确的 language）；用不同的名字避免遮蔽
      // 外层作用域的 debate 引起阅读歧义。
      const advancedDebate = getActiveDebate();
      setTimeout(() => {
        if (getActiveDebate()?.status !== 'running') return;
        submitQuery(
          pickFollowup(
            advancedDebate?.language || 'en',
            isLastTurn(advancedDebate),
          ),
        );
      }, 0);
    } catch (err) {
      if (abortController.signal.aborted) return;
      pauseDebate();
      addItem(
        {
          type: MessageType.ERROR,
          text: `⚠️ 恢复辩论失败：${err instanceof Error ? err.message : String(err)}。再次 /debate continue 可重试。`,
        },
        Date.now(),
      );
    } finally {
      if (advanceAbortRef.current === abortController) {
        advanceAbortRef.current = null;
      }
    }
  }, [config, addItem, submitQuery, advanceAbortRef]);

  // Handle language selection and persist to preferredLanguage
  const handleDebateLanguageSelected = useCallback(
    (language: string) => {
      // Save to workspace settings
      try {
        settings.setValue(SettingScope.Workspace, 'preferredLanguage', language);
      } catch (err) {
        console.warn(`Failed to save preferredLanguage: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [settings],
  );

  return {
    isDebateWizardOpen: isOpen,
    debateWizardModels: models,
    debateWizardPresets: presets,
    debatePreferredLanguage: settings.merged.preferredLanguage,
    openDebateWizard,
    handleDebateWizardComplete,
    handleDebateWizardCancel,
    handleDebateLanguageSelected,
    handleResumeDebate,
  };
}
