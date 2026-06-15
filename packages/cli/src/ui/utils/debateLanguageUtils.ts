/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Helper utilities for debate language detection and configuration.
 */

import { DebateLanguage } from './debateI18n.js';

/**
 * Detect the UI language based on preferredLanguage setting and system environment.
 * Returns 'zh' for Chinese, 'en' for English.
 */
export function detectUILanguage(preferredLanguage?: string): 'zh' | 'en' {
  // If user has set preferredLanguage, try to detect from it
  if (preferredLanguage) {
    if (preferredLanguage.toLowerCase().includes('zh') ||
        preferredLanguage.toLowerCase().includes('chinese')) {
      return 'zh';
    }
    if (preferredLanguage.toLowerCase().includes('en') ||
        preferredLanguage.toLowerCase().includes('english')) {
      return 'en';
    }
  }

  // Check system environment
  const lang = process.env.LANG || process.env.LANGUAGE || '';
  if (lang.toLowerCase().includes('zh')) {
    return 'zh';
  }

  // Default to English
  return 'en';
}

/**
 * Normalize and validate debate language setting.
 * Returns the normalized language code or string.
 */
export function normalizeDebateLanguage(lang: string): DebateLanguage {
  if (!lang) return 'en';

  const lower = lang.toLowerCase().trim();

  // Map common language codes to 'zh' or 'en'
  if (lower.includes('zh') || lower.includes('chinese') || lower === 'c') {
    return 'zh';
  }
  if (lower.includes('en') || lower.includes('english') || lower === 'e') {
    return 'en';
  }

  // Return as-is for custom languages
  return lang;
}

/**
 * Format debate language for display in UI.
 */
export function formatDebateLanguage(lang: DebateLanguage): string {
  if (lang === 'zh') return '中文';
  if (lang === 'en') return 'English';
  return lang;
}
