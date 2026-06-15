/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * launchGoalMode — UI 无关的"启动目标驱动模式"共享内核。
 *
 * 抽取自 useGoalWizard.handleGoalWizardComplete，使 TUI 与飞书（及未来其它
 * surface）共用同一套启动逻辑，避免行为漂移。
 *
 * 本函数只做与 UI 无关的三件事：
 *   1) 若当前不是 YOLO，开启 YOLO（目标模式需要无人值守连续执行）
 *   2) buildGoalPrompt(result) 组装目标契约 prompt
 *   3) client.setGoalContext(...) 注册压缩抗性上下文（T0 在此刻按服务端墙钟捕获，
 *      使契约能在自动压缩后被重新注入，不被 summary 抹掉）
 *
 * 它【不】负责任何 UI（提示文案、把 prompt 喂给 agent loop 等）——这些由调用方
 * 用各自的通道完成（TUI 用 addItem + submitQuery；飞书用消息队列/流式发送）。
 */

import { ApprovalMode, type Config } from 'otto-core';
import {
  buildGoalPrompt,
  type GoalWizardResult,
} from '../components/GoalWizard.js';

export interface LaunchGoalModeOutcome {
  /** 组装好的目标契约 prompt，调用方负责把它喂给 agent loop。 */
  prompt: string;
  /** 本次调用是否真的开启了 YOLO（之前已是 YOLO 则为 false）。 */
  yoloWasEnabled: boolean;
}

/**
 * 启动目标驱动模式（纯逻辑）。
 *
 * @throws 当开启 YOLO 失败时抛出（调用方应据此中止启动并提示用户）。
 *         setGoalContext 失败【不】抛出——goal 仍可启动，只是失去压缩抗性。
 */
export function launchGoalMode(
  config: Config,
  result: GoalWizardResult,
): LaunchGoalModeOutcome {
  // 1) 开启 YOLO（若需要）。失败必须抛出，让调用方中止——否则目标模式会因
  //    工具逐次确认而无法无人值守连续执行。
  let yoloWasEnabled = false;
  const currentMode = config.getApprovalMode();
  if (currentMode !== ApprovalMode.YOLO) {
    config.setApprovalModeWithProjectSync(ApprovalMode.YOLO, true);
    yoloWasEnabled = true;
  }

  // 2) 组装目标契约 prompt（纯函数，内含安全红线 + 强度纪律 + 停止条件）。
  const prompt = buildGoalPrompt(result);

  // 3) 注册压缩抗性上下文。失败不阻断启动（仅丢失压缩后重注入能力）。
  try {
    const client = config.getGeminiClient();
    if (client) {
      client.setGoalContext({
        originalPrompt: prompt,
        startedAt: Date.now(),
        hours: result.hours,
        task: result.task,
        criteria: result.criteria,
        forbidden: result.forbidden,
      });
    }
  } catch (err) {
    // 不中断：目标仍会启动，只是不具备压缩后自动重注入契约的能力。
    console.warn(
      `[launchGoalMode] Failed to register goal context for compression resilience: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return { prompt, yoloWasEnabled };
}
