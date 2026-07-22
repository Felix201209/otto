/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * FeatureFlags — 特性开关定义与管理器。
 *
 * 所有企业级特性通过统一的 FeatureFlagManager 控制启用/禁用。
 * 配置持久化在项目 settings.json 的 featureFlags 字段中。
 */

import { ProjectSettingsManager } from './projectSettings.js';

/** 所有特性开关，key 为标识符，value 为中文显示名。 */
export const FEATURE_FLAGS = {
  park_service: '公园服务',
  feishu_auto_reply: '飞书自动回复',
  enterprise_tree: '企业组织树',
  tui_sync: 'TUI同步',
  knowledge_loop: '知识沉淀闭环',
  memory_injection: '经验检索注入',
  checkpoints: '崩溃恢复',
  audit_log: '审计日志',
} as const;

/** 特性开关的标识符类型 */
export type FeatureFlag = keyof typeof FEATURE_FLAGS;

/** 变更回调：参数为新旧值 */
export type FeatureFlagChangeCallback = (
  flag: FeatureFlag,
  newValue: boolean,
  oldValue: boolean,
) => void;

/** 默认值：park_service 关闭，其余全部开启 */
const DEFAULTS: Record<FeatureFlag, boolean> = {
  park_service: false,
  feishu_auto_reply: true,
  enterprise_tree: true,
  tui_sync: true,
  knowledge_loop: true,
  memory_injection: true,
  checkpoints: true,
  audit_log: true,
};

/**
 * 特性开关管理器。
 *
 * 从 ProjectSettingsManager 的 featureFlags 读取/写入，
 * 并支持 onChange 订阅。
 */
export class FeatureFlagManager {
  private readonly settingsManager: ProjectSettingsManager;
  private readonly listeners = new Set<FeatureFlagChangeCallback>();

  constructor(settingsManager: ProjectSettingsManager) {
    this.settingsManager = settingsManager;
  }

  /**
   * 判断某个特性开关是否已启用。
   * 配置中未设置时回退到默认值。
   */
  isEnabled(flag: FeatureFlag): boolean {
    const settings = this.settingsManager.getSettings();
    const configured = settings.featureFlags?.[flag];
    if (typeof configured === 'boolean') return configured;
    return DEFAULTS[flag];
  }

  /**
   * 启用或禁用某个特性开关。
   * 变更后通知所有 subscribed listeners。
   */
  setEnabled(flag: FeatureFlag, enabled: boolean): void {
    const oldValue = this.isEnabled(flag);
    if (oldValue === enabled) return;

    const settings = this.settingsManager.getSettings();
    const updatedFlags: Record<string, boolean> = {
      ...settings.featureFlags,
      [flag]: enabled,
    };

    this.settingsManager.save({
      ...settings,
      featureFlags: updatedFlags,
    });

    // Fire listeners after persist
    for (const cb of this.listeners) {
      try {
        cb(flag, enabled, oldValue);
      } catch {
        // 回调异常不影响主流程
      }
    }
  }

  /**
   * 获取所有特性开关的当前状态。
   */
  getAll(): Record<FeatureFlag, boolean> {
    const result = {} as Record<FeatureFlag, boolean>;
    for (const flag of Object.keys(FEATURE_FLAGS) as FeatureFlag[]) {
      result[flag] = this.isEnabled(flag);
    }
    return result;
  }

  /**
   * 订阅特性开关变更。
   * @returns 取消订阅的函数
   */
  onChange(callback: FeatureFlagChangeCallback): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }
}
