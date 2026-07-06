/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * /doctor —— 一次性体检 Otto 各能力所依赖的外部二进制/模块，友好打印体检报告。
 */

import { DoctorService, formatDoctorReport } from 'otto-core';
import { CommandKind, SlashCommand } from './types.js';
import { MessageType } from '../types.js';

export const doctorCommand: SlashCommand = {
  name: 'doctor',
  description: '体检 Otto 各能力所依赖的外部工具（就绪/缺失/安装命令）',
  kind: CommandKind.BUILT_IN,
  action: async (context) => {
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: '正在体检外部依赖…',
      },
      Date.now(),
    );

    try {
      const report = await new DoctorService().check();
      const text = formatDoctorReport(report);
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text,
        },
        Date.now(),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: `依赖体检失败：${message}`,
        },
        Date.now(),
      );
    }
  },
};
