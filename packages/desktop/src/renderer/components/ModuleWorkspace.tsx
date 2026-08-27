/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';

import type { ModuleDefinition } from '../moduleCatalog.js';
import type { ModuleWorkspaceLayout } from '../moduleWorkspace.js';
import { ModuleIcon } from './ModuleIcon.js';

export interface ModuleWorkspaceProps {
  presentation: 'panel' | 'page';
  layout: ModuleWorkspaceLayout;
  modules: readonly ModuleDefinition[];
  onActivate(module: ModuleDefinition): void;
  onOpenMarketplace(groupId: string): void;
  onLayoutChange(next: ModuleWorkspaceLayout): void;
}

export function ModuleWorkspace({
  presentation,
  layout,
  modules,
  onActivate,
  onOpenMarketplace,
}: ModuleWorkspaceProps): React.JSX.Element {
  const modulesById = useMemo(
    () => new Map(modules.map((module) => [module.id, module])),
    [modules],
  );

  return (
    <section
      className={`otto-module-workspace otto-module-workspace--${presentation}`}
      data-presentation={presentation}
      aria-label="功能组"
    >
      {layout.groups.map((group) => {
        const groupModules = group.moduleIds
          .map((moduleId) => modulesById.get(moduleId))
          .filter((module): module is ModuleDefinition => Boolean(module));
        const capacity = group.rows * 3;
        const overflowing = groupModules.length > capacity;
        return (
          <article className="otto-module-group" key={group.id} data-group-id={group.id}>
            <header className="otto-module-group__header">
              <h2>{group.name}</h2>
            </header>
            <div
              className={`otto-module-group__grid otto-module-group__grid--rows-${group.rows}${
                overflowing ? ' is-overflowing' : ''
              }`}
              tabIndex={overflowing ? 0 : undefined}
              aria-label={`${group.name}模块`}
            >
              {groupModules.map((module) => {
                const disabled = module.availability !== 'available';
                return (
                  <button
                    key={module.id}
                    type="button"
                    className="otto-module-tile"
                    aria-label={`打开 ${module.label}`}
                    disabled={disabled}
                    title={disabled ? module.disabledReason : module.description}
                    onClick={() => onActivate(module)}
                  >
                    <ModuleIcon icon={module.icon} label={module.label} />
                    <span>{module.label}</span>
                  </button>
                );
              })}
              {groupModules.length === 0 ? (
                <div className="otto-module-group__empty">还没有添加模块</div>
              ) : null}
            </div>
            <button
              type="button"
              className="otto-module-group__add"
              aria-label={`向${group.name}添加模块`}
              onClick={() => onOpenMarketplace(group.id)}
            >
              <span aria-hidden>＋</span>
              添加模块
            </button>
          </article>
        );
      })}
    </section>
  );
}
