/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

/**
 * Otto 副图标：蜷成一团的弹性刺球。
 * 暖棕刺、奶油腹部与青绿弧线保留品牌识别；没有头像感，也没有天线。
 */
export function OttoSecondaryMark({
  active,
}: {
  active: boolean;
}): React.JSX.Element {
  return (
    <span
      className={`otto-response-mark${active ? ' is-active' : ''}`}
      role={active ? 'status' : 'img'}
      aria-label={active ? 'Otto 正在回答' : 'Otto 回复'}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <g className="otto-response-mark__ball">
          <polygon
            className="otto-response-mark__spines"
            points="12,1.2 14.23,3.69 17.4,2.65 18.08,5.92 21.35,6.6 20.31,9.77 22.8,12 20.31,14.23 21.35,17.4 18.08,18.08 17.4,21.35 14.23,20.31 12,22.8 9.77,20.31 6.6,21.35 5.92,18.08 2.65,17.4 3.69,14.23 1.2,12 3.69,9.77 2.65,6.6 5.92,5.92 6.6,2.65 9.77,3.69"
          />
          <circle className="otto-response-mark__belly" cx="11.3" cy="12.3" r="6.15" />
          <circle className="otto-response-mark__ear" cx="14.25" cy="8.25" r="1.25" />
          <path
            className="otto-response-mark__curl"
            d="M14.9 12.5c0 2.45-1.65 4.15-3.9 4.15-2.05 0-3.55-1.35-3.55-3.15 0-1.55 1.1-2.65 2.55-2.65 1.2 0 2.05.75 2.05 1.75 0 .72-.5 1.25-1.18 1.25-.55 0-.95-.36-.95-.86"
          />
          <path className="otto-response-mark__accent" d="M6.1 14.2a6.2 6.2 0 0 0 3.45 3.75" />
          <circle className="otto-response-mark__eye" cx="15.2" cy="10.05" r=".62" />
          <circle className="otto-response-mark__nose" cx="17.55" cy="11.35" r=".92" />
        </g>
      </svg>
    </span>
  );
}
