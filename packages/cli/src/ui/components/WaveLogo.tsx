/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import {
  shouldSkipAnimation,
  useSmallWindowOptimization,
} from '../hooks/useSmallWindowOptimization.js';

type RGB = [number, number, number];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function rgbToHex([r, g, b]: RGB): string {
  return (
    '#' +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * 计算某一列在光波下的颜色:离波峰中心越近越亮(向 peak 渐变),越远越接近 base。
 * 纯函数,便于单测波形逻辑(动效本身要在真终端才看得到)。
 */
export function waveColor(
  col: number,
  center: number,
  halfWidth: number,
  base: RGB,
  peak: RGB,
): string {
  const d = Math.abs(col - center);
  const intensity = Math.max(0, 1 - (d / halfWidth) ** 2); // 1 在波峰 → 0 在 halfWidth 外
  return rgbToHex([
    lerp(base[0], peak[0], intensity),
    lerp(base[1], peak[1], intensity),
    lerp(base[2], peak[2], intensity),
  ]);
}

export interface WaveLogoProps {
  /** 字标行(等宽)。 */
  rows: string[];
  /** 底色 RGB(默认 opencode 暖橙 #fab283)。 */
  base?: RGB;
  /** 波峰高光 RGB(默认接近白 #fff6ee)。 */
  peak?: RGB;
  /** 波峰半宽(列)。越大光带越宽。 */
  halfWidth?: number;
  /** 刷新间隔 ms(越小越快)。 */
  intervalMs?: number;
}

/**
 * 字标循环光波动效:一道高光从左到右匀速扫过,循环往复。
 * 仅在挂载期间跑 setInterval,卸载即清理(首屏专用,开聊后随 HomeScreen 卸载)。
 */
export const WaveLogo: React.FC<WaveLogoProps> = ({
  rows,
  base = [250, 178, 131],
  peak = [255, 246, 238],
  halfWidth = 6,
  intervalMs = 70,
}) => {
  const width = rows.reduce((m, r) => Math.max(m, [...r].length), 0);
  // 波峰从最左外(-halfWidth)扫到最右外(width+halfWidth)再循环。
  const span = width + halfWidth * 2;
  const [phase, setPhase] = useState(0);

  // 复用现成的小窗口优化入口判断是否禁用动画;再叠加非 TTY(管道/重定向/CI)兜底:
  // 这两种情况下不启动 setInterval,直接渲染一帧静态字标(波峰停在中部),避免无谓刷屏。
  const smallWindowConfig = useSmallWindowOptimization();
  const staticFrame =
    !process.stdout.isTTY ||
    shouldSkipAnimation(smallWindowConfig, 'loading');

  useEffect(() => {
    if (staticFrame) return; // 静态模式:不启动定时器
    const id = setInterval(() => setPhase((p) => (p + 1) % span), intervalMs);
    return () => clearInterval(id);
  }, [span, intervalMs, staticFrame]);

  // 静态帧让波峰停在字标中部,呈现一帧高光收尾的字标;动画模式下随 phase 移动。
  const center = staticFrame ? Math.floor(width / 2) : phase - halfWidth;

  return (
    <Box flexDirection="column" alignItems="center">
      {rows.map((row, ri) => (
        <Text key={ri} bold>
          {[...row].map((ch, ci) =>
            ch === ' ' ? (
              <Text key={ci}>{' '}</Text>
            ) : (
              <Text key={ci} color={waveColor(ci, center, halfWidth, base, peak)}>
                {ch}
              </Text>
            ),
          )}
        </Text>
      ))}
    </Box>
  );
};
