/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * PreviewBox — bordered monospace box for a single option's markdown preview.
 * Reuses the Ink version's visual language (box-drawing chars, truncation bar)
 * but rendered as DOM elements with VSCode theme colors.
 */

import React, { useMemo } from 'react';

export interface PreviewBoxProps {
  content: string;
  /** Max lines before truncation. Defaults to 20. */
  maxLines?: number;
}

export const PreviewBox: React.FC<PreviewBoxProps> = ({
  content,
  maxLines = 20,
}) => {
  const { visibleLines, truncated, hiddenCount } = useMemo(() => {
    const lines = (content ?? '').split('\n');
    if (lines.length > maxLines) {
      return {
        visibleLines: lines.slice(0, maxLines),
        truncated: true,
        hiddenCount: lines.length - maxLines,
      };
    }
    return { visibleLines: lines, truncated: false, hiddenCount: 0 };
  }, [content, maxLines]);

  return (
    <div className="auq-preview-box">
      <pre className="auq-preview-content">
        {visibleLines.join('\n')}
      </pre>
      {truncated && (
        <div className="auq-preview-truncation">
          ─── ✂ ─── {hiddenCount} lines hidden ───
        </div>
      )}
    </div>
  );
};
