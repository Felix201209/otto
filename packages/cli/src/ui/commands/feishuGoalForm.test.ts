/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { normalizeGoalFields } from './feishuGoalForm.js';
import { buildGoalPrompt } from '../components/GoalWizard.js';

/**
 * normalizeGoalFields — 把飞书目标表单回传的原始字段（全是字符串）校验并归一化
 * 成 GoalWizardResult。校验失败返回 { ok:false, error }，由调用方提示用户重填。
 *
 * 规则（对齐 TUI GoalWizard）：
 *   - task：必填，去空格后非空
 *   - criteria：必填，去空格后非空
 *   - forbidden：可选
 *   - hours：必填，解析为 0.5–24 的数字，非法则报错
 *   - intensity：steady/standard/intense，非法或空则默认 standard
 */
describe('normalizeGoalFields', () => {
  const valid = {
    task: '把覆盖率提到 90%',
    criteria: '所有测试通过',
    forbidden: '别改 API',
    hours: '2',
    intensity: 'standard',
  };

  it('accepts a fully valid form', () => {
    const out = normalizeGoalFields(valid);
    expect(out.ok).toBe(true);
    expect(out.result).toEqual({
      task: '把覆盖率提到 90%',
      criteria: '所有测试通过',
      forbidden: '别改 API',
      hours: 2,
      intensity: 'standard',
    });
  });

  it('rejects empty task', () => {
    const out = normalizeGoalFields({ ...valid, task: '   ' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/任务|task/i);
  });

  it('rejects empty criteria', () => {
    const out = normalizeGoalFields({ ...valid, criteria: '' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/标准|criteria/i);
  });

  it('allows empty forbidden (optional)', () => {
    const out = normalizeGoalFields({ ...valid, forbidden: '' });
    expect(out.ok).toBe(true);
    expect(out.result?.forbidden).toBe('');
  });

  it('trims whitespace on text fields', () => {
    const out = normalizeGoalFields({
      ...valid,
      task: '  hello  ',
      criteria: '  done  ',
    });
    expect(out.result?.task).toBe('hello');
    expect(out.result?.criteria).toBe('done');
  });

  it('parses decimal hours', () => {
    const out = normalizeGoalFields({ ...valid, hours: '0.5' });
    expect(out.ok).toBe(true);
    expect(out.result?.hours).toBe(0.5);
  });

  it('rejects non-numeric hours', () => {
    const out = normalizeGoalFields({ ...valid, hours: 'abc' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/小时|hours/i);
  });

  it('rejects hours below 0.5', () => {
    const out = normalizeGoalFields({ ...valid, hours: '0.1' });
    expect(out.ok).toBe(false);
  });

  it('rejects hours above 24', () => {
    const out = normalizeGoalFields({ ...valid, hours: '48' });
    expect(out.ok).toBe(false);
  });

  it('rejects empty/missing hours', () => {
    const out = normalizeGoalFields({ ...valid, hours: '' });
    expect(out.ok).toBe(false);
  });

  it('defaults intensity to standard when empty', () => {
    const out = normalizeGoalFields({ ...valid, intensity: '' });
    expect(out.ok).toBe(true);
    expect(out.result?.intensity).toBe('standard');
  });

  it('defaults intensity to standard when invalid', () => {
    const out = normalizeGoalFields({ ...valid, intensity: 'turbo' });
    expect(out.ok).toBe(true);
    expect(out.result?.intensity).toBe('standard');
  });

  it('accepts steady and intense intensities', () => {
    expect(normalizeGoalFields({ ...valid, intensity: 'steady' }).result?.intensity).toBe('steady');
    expect(normalizeGoalFields({ ...valid, intensity: 'intense' }).result?.intensity).toBe('intense');
  });

  it('handles missing fields object gracefully', () => {
    const out = normalizeGoalFields({} as never);
    expect(out.ok).toBe(false);
  });
});

/**
 * 飞书 /goal 拦截的「组装链」不变量：normalizeGoalFields 的输出必须能直接
 * 喂给 buildGoalPrompt，产出含任务内容的非空 prompt。
 *
 * 这是 feishuCommand.ts goal 拦截的核心逻辑（messageText = buildGoalPrompt(
 * normalizeGoalFields(fields).result)）。组装出的 prompt 会被写回 msg.text
 * 并入队，交给隔离 session 的 agent loop 执行。若这条链断裂，飞书 goal 模式
 * 就只会把原始 "/goal" 喂给 agent，目标契约丢失。
 */
describe('feishu goal interception: normalizeGoalFields → buildGoalPrompt chain', () => {
  const valid = {
    task: '把覆盖率提到 90%',
    criteria: '所有测试通过',
    forbidden: '别改 API',
    hours: '2',
    intensity: 'standard',
  };

  it('produces a non-empty goal prompt embedding the task', () => {
    const normalized = normalizeGoalFields({ ...valid, task: '独特任务标记ZZZ' });
    expect(normalized.ok).toBe(true);
    const prompt = buildGoalPrompt(normalized.result!);
    expect(prompt).toBeTruthy();
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('独特任务标记ZZZ');
    // prompt 不应再是原始斜杠命令
    expect(prompt.trim()).not.toBe('/goal');
  });

  it('embeds criteria and forbidden into the assembled prompt', () => {
    const normalized = normalizeGoalFields({
      ...valid,
      criteria: '判定标记CRIT',
      forbidden: '禁止标记FORB',
    });
    const prompt = buildGoalPrompt(normalized.result!);
    expect(prompt).toContain('判定标记CRIT');
    expect(prompt).toContain('禁止标记FORB');
  });
});

