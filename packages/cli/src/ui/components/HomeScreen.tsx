/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { isChineseLocale, t } from '../utils/i18n.js';
import { ottoThickLogo } from './AsciiArt.js';
import { WaveLogo } from './WaveLogo.js';

export interface HomeScreenProps {
  /** 终端宽度(列)。用于输入框框体宽度。 */
  terminalWidth: number;
  /** 当前工作区名(通常取 cwd 的 basename)。 */
  workspace: string;
  /** 当前模型 id(可能形如 custom:provider:name,会被美化)。 */
  model: string;
  /**
   * 真实输入框插槽。集成进 App 时把真的 <InputPrompt/> 传进来;
   * 不传则渲染一个静态占位行(仅用于单独预览形状)。
   */
  inputSlot?: React.ReactNode;
}

// 输入框框体宽度:跟随终端,封顶 88 列,窄终端贴边留 4 列边距(仿 opencode promptMaxWidth)。
function frameWidth(cols: number): number {
  return Math.max(24, Math.min(cols - 4, 88));
}

// 输入框面板底色:比页面背景(#0a0a0a)稍亮一档,让输入框成为可见面板而非糊进背景。
const PANEL_BG = '#1a1a1a';

// 模型名美化:custom:openai-responses:gpt-5.5@sess → gpt-5.5。
// 去掉 @会话后缀,再取 : 分隔的最后一段。
function prettyModel(model: string): string {
  if (!model) return '';
  const noSession = model.split('@')[0];
  const parts = noSession.split(':');
  return parts[parts.length - 1] || noSession;
}

/**
 * 满屏居中的 Home/idle 屏(仿 opencode home route)。极简:厚体 OTTO 字标 +
 * 一个可见的输入框面板(左侧暖橙激活条)+ 一行 workspace·model 状态 + 一行快捷键。
 * 信息只在中间放一遍,不再叠底部 Footer。flexGrow 填满父容器并上下居中。
 */
export const HomeScreen: React.FC<HomeScreenProps> = ({
  terminalWidth,
  workspace,
  model,
  inputSlot,
}) => {
  const width = frameWidth(terminalWidth);

  return (
    <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
      {/* 1. OTTO 字标 —— 暖橙底 + 循环光波高光 */}
      <Box marginBottom={2}>
        {/* 窄终端(<40列)厚体字标会撑破布局,降级为纯文字字标 */}
        {terminalWidth < 40 ? (
          <Text color={Colors.AccentOrange} bold>
            OTTO
          </Text>
        ) : (
          <WaveLogo rows={ottoThickLogo} />
        )}
      </Box>

      {/* 2. 输入框面板:可见底色 + 左侧暖橙激活条 */}
      <Box flexDirection="column" width={width}>
        <Box backgroundColor={PANEL_BG} flexDirection="row" width="100%">
          <Box width={1} backgroundColor={Colors.AccentOrange} marginRight={2} />
          <Box flexDirection="column" paddingY={1} paddingRight={2} flexGrow={1}>
            {inputSlot ? (
              <>{inputSlot}</>
            ) : (
              <Text color={Colors.Gray}>{t('input.placeholder.base')}</Text>
            )}
          </Box>
        </Box>

        {/* 3. 一行状态(workspace · 美化后的模型名) + 一行快捷键,左右分置 */}
        <Box marginTop={1} justifyContent="space-between">
          <Box>
            <Text color={Colors.Foreground}>{workspace}</Text>
            <Text color={Colors.Gray}>{'  ·  '}</Text>
            {/* model==='auto' 是未配模型时的占位回退值,灰显「未配置模型」而非橙显「auto」,
                避免新手误以为已就绪;有真实模型时仍暖橙高亮。语言跟随 locale,不新增 i18n key。 */}
            {model === 'auto' ? (
              <Text color={Colors.Gray}>{isChineseLocale() ? '未配置模型' : 'no model configured'}</Text>
            ) : (
              <Text color={Colors.AccentOrange}>{prettyModel(model)}</Text>
            )}
          </Box>
          <Box>
            <Text color={Colors.Gray}>
              {isChineseLocale() ? '/ 命令   @ 文件   ↵ 发送   /help 帮助' : '/ commands   @ files   ↵ send   /help help'}
            </Text>
          </Box>
        </Box>

        {/* 未配模型时,在面板下方给一行醒目的下一步引导(暖橙),比灰显状态行更显眼 */}
        {model === 'auto' && (
          <Box marginTop={1}>
            <Text color={Colors.AccentOrange}>
              {isChineseLocale() ? '⚠ 还没配置模型 — 运行 ' : '⚠ No model configured — run '}
            </Text>
            <Text color={Colors.AccentCyan} bold>
              otto setup
            </Text>
            <Text color={Colors.AccentOrange}>
              {isChineseLocale() ? ' 或输入 /model 添加' : ' or type /model to add one'}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
