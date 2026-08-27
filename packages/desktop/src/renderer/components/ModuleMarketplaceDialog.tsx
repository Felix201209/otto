/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ModuleCategory, ModuleDefinition } from '../moduleCatalog.js';
import { addOrMoveModules, type ModuleWorkspaceLayout } from '../moduleWorkspace.js';
import { ModuleIcon } from './ModuleIcon.js';

const CATEGORY_LABELS: Readonly<Record<ModuleCategory, string>> = {
  common: '常用',
  park: '园区服务',
  capability: '企业能力',
  'custom-agent': '我的专家',
};

const CATEGORY_ORDER: readonly ModuleCategory[] = [
  'common',
  'park',
  'capability',
  'custom-agent',
];

export interface ModuleMarketplaceDialogProps {
  open: boolean;
  targetGroupId: string;
  layout: ModuleWorkspaceLayout;
  modules: readonly ModuleDefinition[];
  onConfirm(next: ModuleWorkspaceLayout): void;
  onClose(): void;
  onManageExperts(): void;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute('hidden'));
}

export function ModuleMarketplaceDialog({
  open,
  targetGroupId,
  layout,
  modules,
  onConfirm,
  onClose,
  onManageExperts,
}: ModuleMarketplaceDialogProps): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const titleId = `${useId()}-title`;
  const targetGroup = layout.groups.find((group) => group.id === targetGroupId);

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setQuery('');
    setSelection(new Set());
    closeRef.current?.focus();
    return () => {
      const trigger = triggerRef.current;
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [open, targetGroupId]);

  const moduleLocation = useMemo(() => {
    const result = new Map<string, string>();
    for (const group of layout.groups) {
      for (const moduleId of group.moduleIds) result.set(moduleId, group.name);
    }
    return result;
  }, [layout]);

  const visibleModules = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return modules.filter((module) => {
      if (module.availability === 'hidden') return false;
      if (!normalizedQuery) return true;
      return `${module.label} ${module.description ?? ''}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [modules, query]);

  if (!open || !targetGroup) return null;

  const toggleSelection = (moduleId: string): void => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(moduleId)) next.delete(moduleId);
      else next.add(moduleId);
      return next;
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="otto-module-marketplace-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="otto-module-marketplace"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="otto-module-marketplace__header">
          <div>
            <h2 id={titleId}>添加模块</h2>
            <p>添加到“{targetGroup.name}”</p>
          </div>
          <button ref={closeRef} type="button" aria-label="关闭添加模块" onClick={onClose}>×</button>
        </header>
        <label className="otto-module-marketplace__search">
          <span className="sr-only">搜索模块</span>
          <input
            type="search"
            aria-label="搜索模块"
            placeholder="搜索模块……"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="otto-module-marketplace__catalog">
          {CATEGORY_ORDER.map((category) => {
            const categoryModules = visibleModules.filter((module) => module.category === category);
            if (categoryModules.length === 0) return null;
            return (
              <section key={category} className="otto-module-marketplace__category">
                <h3>{CATEGORY_LABELS[category]}</h3>
                <div className="otto-module-marketplace__modules">
                  {categoryModules.map((module) => {
                    const location = moduleLocation.get(module.id);
                    const inTargetGroup = location === targetGroup.name;
                    const unavailable = module.availability !== 'available';
                    const disabled = inTargetGroup || unavailable;
                    return (
                      <label
                        key={module.id}
                        className={`otto-module-marketplace__module${disabled ? ' is-disabled' : ''}`}
                      >
                        <input
                          type="checkbox"
                          aria-label={module.label}
                          checked={inTargetGroup || selection.has(module.id)}
                          disabled={disabled}
                          onChange={() => toggleSelection(module.id)}
                        />
                        <ModuleIcon icon={module.icon} label={module.label} size={26} />
                        <span className="otto-module-marketplace__module-copy">
                          <strong>{module.label}</strong>
                          <small>
                            {inTargetGroup
                              ? '已添加到当前功能组'
                              : unavailable
                                ? module.disabledReason ?? '当前不可用'
                                : location
                                  ? `将从“${location}”移动`
                                  : module.description ?? '可添加到当前功能组'}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {visibleModules.length === 0 ? (
            <p className="otto-module-marketplace__empty">没有找到匹配的模块</p>
          ) : null}
        </div>
        <footer className="otto-module-marketplace__footer">
          <button type="button" className="otto-module-marketplace__manage" onClick={onManageExperts}>
            管理专家
          </button>
          <button
            type="button"
            className="otto-module-marketplace__confirm"
            disabled={selection.size === 0}
            onClick={() => {
              onConfirm(addOrMoveModules(layout, targetGroupId, [...selection]));
              onClose();
            }}
          >
            添加（{selection.size}）
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
