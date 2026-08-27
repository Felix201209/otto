/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React from 'react';
import type { ModuleDefinition } from '../moduleCatalog.js';
import type { ModuleWorkspaceLayout } from '../moduleWorkspace.js';
import { ModuleWorkspace } from './ModuleWorkspace.js';

/** Thin boundary: App owns capabilities, persistence, and business dialogs. */
export interface RightPanelProps {
  busy: boolean;
  presentation?: 'panel' | 'page';
  collapsed?: boolean;
  ready: boolean;
  readiness?: 'loading' | 'ready' | 'failed';
  onRetryCapabilities?: () => void;
  scopeKey: string;
  layout: ModuleWorkspaceLayout;
  modules: readonly ModuleDefinition[];
  onActivate(module: ModuleDefinition): void;
  onOpenMarketplace(groupId: string): void;
  onLayoutChange(next: ModuleWorkspaceLayout): void;
}

export function RightPanel({
  busy,
  presentation = 'panel',
  collapsed = false,
  ready,
  readiness = ready ? 'ready' : 'loading',
  onRetryCapabilities,
  scopeKey,
  layout,
  modules,
  onActivate,
  onOpenMarketplace,
  onLayoutChange,
}: RightPanelProps): React.JSX.Element {
  const hidden = presentation === 'panel' && collapsed;
  return (
    <aside
      className={`otto-right-panel otto-right-panel--${presentation}${hidden ? ' otto-right-panel--collapsed' : ''}`}
      aria-label="功能组"
      aria-busy={busy || readiness === 'loading'}
      aria-hidden={hidden || undefined}
    >
      {readiness === 'ready' ? (
        <ModuleWorkspace
          presentation={presentation}
          scopeKey={scopeKey}
          layout={layout}
          modules={modules}
          onActivate={onActivate}
          onOpenMarketplace={onOpenMarketplace}
          onLayoutChange={onLayoutChange}
        />
      ) : readiness === 'failed' ? (
        <div className="otto-module-workspace__loading" role="status">
          <span>暂时无法加载可用模块。</span>
          {onRetryCapabilities ? <button type="button" onClick={onRetryCapabilities}>重试</button> : null}
        </div>
      ) : (
        <div className="otto-module-workspace__loading" role="status">正在加载可用模块…</div>
      )}
    </aside>
  );
}
