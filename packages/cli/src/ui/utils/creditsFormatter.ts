/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { Colors } from '../colors.js';
import { t } from './i18n.js';

/**
 * 格式化积分数字
 * >= 1,000,000: 使用M表示，保留2位小数（如：1.50M）
 * >= 1,000: 使用k表示，保留2位小数（如：1.50k）
 * < 1,000: 显示整数
 * 异常值处理：NaN、Infinity 返回 "0"
 */
export function formatCreditsNumber(credits: number): string {
  // 防守异常值
  if (!Number.isFinite(credits) || credits < 0) {
    return '0';
  }

  if (credits >= 1000000) {
    const millions = credits / 1000000;
    return `${millions.toFixed(2)}M`;
  }
  if (credits >= 1000) {
    const thousands = credits / 1000;
    return `${thousands.toFixed(2)}k`;
  }
  return Math.floor(credits).toString();
}

/**
 * 使用 ANSI 颜色代码格式化积分显示
 * 显示套餐内的积分使用情况
 * 异常值防守：返回 null 如果数据无效
 */
export function formatCreditsWithColor(totalCredits: number, usedCredits: number, usagePercentage: number): string | null {
  // 防守异常值
  if (!Number.isFinite(totalCredits) || !Number.isFinite(usedCredits) || !Number.isFinite(usagePercentage)) {
    console.warn('⚠️ Invalid credits data:', { totalCredits, usedCredits, usagePercentage });
    return null;
  }

  if (totalCredits < 0 || usedCredits < 0 || usagePercentage < 0 || usagePercentage > 100) {
    console.warn('⚠️ Credits data out of range:', { totalCredits, usedCredits, usagePercentage });
    return null;
  }

  const totalStr = formatCreditsNumber(totalCredits);
  const usedStr = formatCreditsNumber(usedCredits);
  const remainingCredits = Math.max(0, totalCredits - usedCredits);
  const remainingStr = formatCreditsNumber(remainingCredits);
  const percentStr = usagePercentage.toFixed(1);

  // ANSI 颜色代码
  const RESET = '\x1b[0m';
  const CYAN = '\x1b[36m';      // 青色 - 标签
  const BLUE = '\x1b[34m';      // 蓝色 - 总积分（套餐额度）
  const GREEN = '\x1b[32m';     // 绿色 - 低使用百分比（0-50%）
  const YELLOW = '\x1b[33m';    // 黄色 - 中等使用百分比（50-95%）
  const RED = '\x1b[31m';       // 红色 - 高使用百分比（>95%）

  // 根据使用百分比选择颜色
  let usedColor: string;
  if (usagePercentage > 95) {
    usedColor = RED;
  } else if (usagePercentage > 50) {
    usedColor = YELLOW;
  } else {
    usedColor = GREEN;
  }

  // 显示：限额 | 已用 (使用百分比%) | 可用
  return (
    `💰 ${CYAN}${t('credits.limit')}:${RESET} ${BLUE}${totalStr}${RESET} | ` +
    `${CYAN}${t('credits.used')}:${RESET} ${usedColor}${usedStr}${RESET} ${CYAN}(${percentStr}%)${RESET} | ` +
    `${CYAN}${t('credits.available')}:${RESET} ${BLUE}${remainingStr}${RESET}`
  );
}
