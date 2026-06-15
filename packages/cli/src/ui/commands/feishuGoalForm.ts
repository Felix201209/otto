/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书「目标驱动模式」表单字段的校验与归一化。
 *
 * 飞书表单回传的字段全是字符串；本模块把它们校验并转换成 GoalWizardResult，
 * 校验规则对齐 TUI 的 GoalWizard。纯函数，便于单测。
 */

import type {
  GoalWizardResult,
  GoalIntensity,
} from '../components/GoalWizard.js';

/** 飞书表单回传的原始字段（全字符串）。 */
export interface GoalFieldsInput {
  task: string;
  criteria: string;
  forbidden: string;
  hours: string;
  intensity: string;
}

export interface NormalizeGoalResult {
  ok: boolean;
  result?: GoalWizardResult;
  /** 校验失败时的中文错误说明（用于提示用户重填）。 */
  error?: string;
}

const HOURS_MIN = 0.5;
const HOURS_MAX = 24;
const VALID_INTENSITIES: GoalIntensity[] = ['steady', 'standard', 'intense'];
const DEFAULT_INTENSITY: GoalIntensity = 'standard';

/**
 * 校验并归一化飞书目标表单字段。
 */
export function normalizeGoalFields(
  fields: GoalFieldsInput,
): NormalizeGoalResult {
  const f = fields || ({} as GoalFieldsInput);

  const task = (f.task ?? '').trim();
  const criteria = (f.criteria ?? '').trim();
  const forbidden = (f.forbidden ?? '').trim();
  const hoursRaw = (f.hours ?? '').trim();
  const intensityRaw = (f.intensity ?? '').trim();

  // task 必填
  if (!task) {
    return { ok: false, error: '「目标任务」为必填项，请填写后重新发送 /goal。' };
  }

  // criteria 必填
  if (!criteria) {
    return {
      ok: false,
      error: '「成功判定标准」为必填项，请填写后重新发送 /goal。',
    };
  }

  // hours 必填且为 0.5–24 的数字
  if (!hoursRaw) {
    return {
      ok: false,
      error: `「最少持续小时数」为必填项（${HOURS_MIN}–${HOURS_MAX}），请填写后重新发送 /goal。`,
    };
  }
  const hours = Number(hoursRaw);
  if (!Number.isFinite(hours)) {
    return {
      ok: false,
      error: `「最少持续小时数」必须是数字（${HOURS_MIN}–${HOURS_MAX}），收到的是 "${hoursRaw}"。请重新发送 /goal。`,
    };
  }
  if (hours < HOURS_MIN || hours > HOURS_MAX) {
    return {
      ok: false,
      error: `「最少持续小时数」需在 ${HOURS_MIN}–${HOURS_MAX} 之间，收到的是 ${hours}。请重新发送 /goal。`,
    };
  }

  // intensity：非法或空则默认 standard（不报错）
  const intensity: GoalIntensity = VALID_INTENSITIES.includes(
    intensityRaw as GoalIntensity,
  )
    ? (intensityRaw as GoalIntensity)
    : DEFAULT_INTENSITY;

  return {
    ok: true,
    result: { task, criteria, forbidden, hours, intensity },
  };
}
