/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import ottoPetAtlasUrl from '../assets/otto-pet-atlas.png';

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const ATLAS_COLUMNS = 8;
const ATLAS_ROWS = 9;
const PANEL_DISPLAY_SCALE = 0.62;
const LOGIN_DISPLAY_SCALE = 1.65;

type PetStateId =
  | 'idle'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review';

interface PetAnimation {
  id: PetStateId;
  row: number;
  durations: readonly number[];
  label: string;
}

export const PET_ANIMATIONS: Record<PetStateId, PetAnimation> = {
  idle: {
    id: 'idle',
    row: 0,
    durations: [280, 110, 110, 140, 140, 320],
    label: '安静陪着你',
  },
  'running-right': {
    id: 'running-right',
    row: 1,
    durations: [120, 120, 120, 120, 120, 120, 120, 220],
    label: '去右边转一圈',
  },
  'running-left': {
    id: 'running-left',
    row: 2,
    durations: [120, 120, 120, 120, 120, 120, 120, 220],
    label: '再跑回来',
  },
  waving: {
    id: 'waving',
    row: 3,
    durations: [140, 140, 140, 280],
    label: '和你打个招呼',
  },
  jumping: {
    id: 'jumping',
    row: 4,
    durations: [140, 140, 140, 140, 280],
    label: '开心地蹦一下',
  },
  failed: {
    id: 'failed',
    row: 5,
    durations: [140, 140, 140, 140, 140, 140, 140, 240],
    label: '摔了一小跤',
  },
  waiting: {
    id: 'waiting',
    row: 6,
    durations: [150, 150, 150, 150, 150, 260],
    label: '耐心等一会儿',
  },
  running: {
    id: 'running',
    row: 7,
    durations: [120, 120, 120, 120, 120, 220],
    label: '原地活动一下',
  },
  review: {
    id: 'review',
    row: 8,
    durations: [150, 150, 150, 150, 150, 280],
    label: '认真看看四周',
  },
};

interface AmbientStep {
  state: PetStateId;
  loops: number;
}

// 非运行态有自己的陪伴节奏；回答状态本身仍由消息侧橘色标记负责。
const AMBIENT_SEQUENCE: readonly AmbientStep[] = [
  { state: 'idle', loops: 3 },
  { state: 'waving', loops: 2 },
  { state: 'waiting', loops: 2 },
  { state: 'jumping', loops: 2 },
  { state: 'review', loops: 2 },
];

const RUNNING_SEQUENCE: readonly AmbientStep[] = [
  { state: 'running-right', loops: 4 },
  { state: 'running-left', loops: 4 },
];

const REDUCED_MOTION_SEQUENCE: readonly AmbientStep[] = [
  { state: 'idle', loops: 1 },
];

function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.(query).matches ?? false,
  );

  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const onChange = (event: MediaQueryListEvent): void =>
      setReduced(event.matches);
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);

  return reduced;
}

export function OttoPetStage({
  running,
  variant = 'panel',
}: {
  running: boolean;
  variant?: 'panel' | 'login';
}): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  const [stepIndex, setStepIndex] = useState(0);
  const [frameIndex, setFrameIndex] = useState(0);
  const [loopIndex, setLoopIndex] = useState(0);

  const sequence = reducedMotion
    ? REDUCED_MOTION_SEQUENCE
    : running
      ? RUNNING_SEQUENCE
      : AMBIENT_SEQUENCE;
  const step = sequence[stepIndex % sequence.length];
  const animation = PET_ANIMATIONS[step.state];

  useEffect(() => {
    setStepIndex(0);
    setFrameIndex(0);
    setLoopIndex(0);
  }, [reducedMotion, running]);

  useEffect(() => {
    if (reducedMotion) return;
    const timeout = window.setTimeout(() => {
      const nextFrame = frameIndex + 1;
      if (nextFrame < animation.durations.length) {
        setFrameIndex(nextFrame);
        return;
      }

      const nextLoop = loopIndex + 1;
      if (nextLoop < step.loops) {
        setFrameIndex(0);
        setLoopIndex(nextLoop);
        return;
      }

      setStepIndex((current) => (current + 1) % sequence.length);
      setFrameIndex(0);
      setLoopIndex(0);
    }, animation.durations[frameIndex]);

    return () => window.clearTimeout(timeout);
  }, [animation, frameIndex, loopIndex, reducedMotion, sequence.length, step.loops]);

  const totalStateDuration = useMemo(
    () =>
      animation.durations.reduce((total, duration) => total + duration, 0) *
      step.loops,
    [animation, step.loops],
  );
  const displayScale = variant === 'login' ? LOGIN_DISPLAY_SCALE : PANEL_DISPLAY_SCALE;
  const displayWidth = Number((CELL_WIDTH * displayScale).toFixed(2));
  const displayHeight = Number((CELL_HEIGHT * displayScale).toFixed(2));

  const spriteStyle: React.CSSProperties = {
    width: displayWidth,
    height: displayHeight,
    backgroundImage: `url(${ottoPetAtlasUrl})`,
    backgroundRepeat: 'no-repeat',
    backgroundSize: `${CELL_WIDTH * ATLAS_COLUMNS * displayScale}px ${
      CELL_HEIGHT * ATLAS_ROWS * displayScale
    }px`,
    backgroundPosition: `${-frameIndex * CELL_WIDTH * displayScale}px ${
      -animation.row * CELL_HEIGHT * displayScale
    }px`,
  };

  const motionStyle = {
    '--otto-pet-state-duration': `${totalStateDuration}ms`,
  } as React.CSSProperties;

  const travelling =
    animation.id === 'running-right' || animation.id === 'running-left';

  return (
    <section
      className={`otto-pet-stage${variant === 'login' ? ' otto-pet-stage--login' : ''}`}
      aria-label={variant === 'login' ? 'Otto 像素吉祥物动画' : 'Otto 吉祥物活动区'}
      data-testid="otto-pet-stage"
      data-current-state={animation.id}
      data-running={running ? 'true' : 'false'}
    >
      {variant === 'panel' ? (
        <div className="otto-pet-stage__head">
          <span>Otto 的小角落</span>
          <span className="otto-pet-stage__state">{animation.label}</span>
        </div>
      ) : null}
      <div className="otto-pet-stage__scene">
        {variant === 'panel' ? <div className="otto-pet-stage__floor" aria-hidden="true" /> : null}
        <div
          key={`${animation.id}-${stepIndex}`}
          className={`otto-pet-stage__motion${
            travelling ? ` is-${animation.id}` : ''
          }`}
          style={motionStyle}
          data-state={animation.id}
          data-frame={frameIndex}
          data-reduced-motion={reducedMotion ? 'true' : 'false'}
        >
          <div className="otto-pet-stage__sprite" style={spriteStyle} aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
