/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export type WindowCloseChoice = 'continue-background' | 'stop-and-quit' | 'cancel';

export interface WindowCloseDialog {
  showMessageBox(options: {
    type: 'question';
    title: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    noLink: boolean;
  }): Promise<{ response: number }>;
}

/** Always requires an explicit choice before a user-initiated window close. */
export async function askWindowCloseChoice(
  prompt: WindowCloseDialog,
): Promise<WindowCloseChoice> {
  const { response } = await prompt.showMessageBox({
    type: 'question',
    title: '关闭 Otto',
    message: '关闭窗口后如何处理正在运行的任务？',
    detail: '请明确选择“继续后台运行”或“停止任务并退出”。',
    buttons: ['继续后台运行', '停止任务并退出', '取消'],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
  });
  if (response === 0) return 'continue-background';
  if (response === 1) return 'stop-and-quit';
  return 'cancel';
}
