/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


/**
 * Simple i18n utility for core package
 * Avoids circular dependencies by implementing basic translation functionality
 */

// 简单的翻译字典
const translations = {
  en: {
    'task.timeout.warning': '⚠️ Task execution timeout: Completed {turns} conversation turns but task remains unfinished',
    'task.timeout.credits.notice': 'Continuing may consume additional credits. Please review carefully.',
    'task.timeout.partial.header': '⚠️ Reached max turns ({turns}). Partial findings from sub-agent below:',
    'task.timeout.partial.no_summary': '(Sub-agent did not produce a final summary before reaching the turn limit.)',
    'task.execution.failed': 'Execution failed: {error}',
    'shell.output.truncated': '... (showing last {maxLines} lines, {totalLines} lines total)',
    'shell.error.dangerous_node_kill_windows': 'This command attempts to kill all node.exe processes, which would terminate the CLI itself. Please use specific PIDs instead: taskkill /PID <process_id> /F',
    'shell.error.dangerous_node_kill_unix': 'This command attempts to kill all node processes, which would terminate the CLI itself. Please use specific PIDs instead: kill -9 <process_id>',
    'websearch.results.returned': 'Search results for "{query}" returned.{truncated}',
    'websearch.results.truncated': ' (Content truncated)',
    'websearch.error.performing': 'Error performing web search.',
    'websearch.error.not.logged.in': 'Not logged in to Otto',
    'websearch.error.quota.exceeded': 'Insufficient credits',
    'tool.ppt_generate': 'PPT Generate',
    'tool.ppt_generate.description': 'Render the confirmed PPT outline through local HTML pages, turn each page into an image with local Chrome/Edge/Chromium, then package the images into a .pptx. No Python, Otto server, login, upload, or web editor is used. Separate slides with --- lines.',
    'ppt_generate.param.confirm': 'Confirm local generation (default true)',
  },
  zh: {
    'task.timeout.warning': '⚠️ 任务执行超时：已执行{turns}轮对话但任务仍未完成',
    'task.timeout.credits.notice': '继续执行可能消耗更多 Credits，请谨慎审视。',
    'task.timeout.partial.header': '⚠️ 已达到最大轮数 ({turns})。子 Agent 的部分发现如下：',
    'task.timeout.partial.no_summary': '（子 Agent 未能在轮数耗尽前产生最终总结。）',
    'task.execution.failed': '执行失败: {error}',
    'shell.output.truncated': '... (显示最新 {maxLines} 行，共 {totalLines} 行)',
    'shell.error.dangerous_node_kill_windows': '该命令会批量结束所有 node.exe 进程，这将导致CLI自身被终止。请使用精准的PID方式：taskkill /PID <进程ID> /F',
    'shell.error.dangerous_node_kill_unix': '该命令会批量结束所有 node 进程，这将导致CLI自身被终止。请使用精准的PID方式：kill -9 <进程ID>',
    'websearch.results.returned': '"{query}"的搜索结果已返回。{truncated}',
    'websearch.results.truncated': '（内容已截断）',
    'websearch.error.performing': '执行网络搜索时出错。',
    'websearch.error.not.logged.in': '未登录 Otto',
    'websearch.error.quota.exceeded': '积分不足',
    'tool.ppt_generate': 'PPT生成',
    'tool.ppt_generate.description': '把已确认的内容逐页生成本地 HTML，用本机 Chrome/Edge/Chromium 转成图片，再封装为本地 .pptx。全程不调用 Python，也不经过 Otto 服务端、登录、上传或网页编辑器；页面用独占一行的 --- 分隔。',
    'ppt_generate.param.confirm': '确认本地生成（默认 true）',
  }
} as const;

/**
 * 检测是否为中文环境
 */
function isChineseEnvironment(): boolean {
  try {
    const env = process.env;
    const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
    return locale.toLowerCase().includes('zh') || locale.toLowerCase().includes('chinese');
  } catch {
    return false;
  }
}

/**
 * 获取当前语言
 */
function getCurrentLocale(): 'en' | 'zh' {
  return isChineseEnvironment() ? 'zh' : 'en';
}

/**
 * 翻译函数，支持参数替换
 * @param key 翻译键
 * @param params 参数对象
 * @returns 翻译后的文本
 */
export function t(key: keyof typeof translations.en, params?: Record<string, string | number>): string {
  const locale = getCurrentLocale();
  let text: string = translations[locale][key] || translations.en[key] || key;

  // 参数替换
  if (params) {
    Object.entries(params).forEach(([paramName, value]) => {
      text = text.replace(new RegExp(`\\{${paramName}\\}`, 'g'), String(value));
    });
  }

  return text;
}
