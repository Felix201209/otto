/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { ModuleDefinition } from '../moduleCatalog.js';
import {
  createModuleGroup,
  deleteModuleGroup,
  removeModuleFromGroup,
  renameModuleGroup,
  reorderModuleGroups,
  updateModuleGroupRows,
  validateModuleGroupName,
  type ModuleWorkspaceLayout,
} from '../moduleWorkspace.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ModuleIcon } from './ModuleIcon.js';

export interface ModuleWorkspaceProps {
  presentation: 'panel' | 'page';
  layout: ModuleWorkspaceLayout;
  defaultLayout?: ModuleWorkspaceLayout;
  modules: readonly ModuleDefinition[];
  onActivate(module: ModuleDefinition): void;
  onOpenMarketplace(groupId: string): void;
  onLayoutChange(next: ModuleWorkspaceLayout): void;
}

export function ModuleWorkspace({
  presentation,
  layout,
  defaultLayout,
  modules,
  onActivate,
  onOpenMarketplace,
  onLayoutChange,
}: ModuleWorkspaceProps): React.JSX.Element {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<{
    groupId: string;
    value: string;
    error: string | null;
  } | null>(null);
  const [confirmState, setConfirmState] = useState<
    { kind: 'delete-group'; groupId: string } | { kind: 'restore-defaults' } | null
  >(null);
  const [undoState, setUndoState] = useState<{
    label: string;
    previousLayout: ModuleWorkspaceLayout;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modulesById = useMemo(
    () => new Map(modules.map((module) => [module.id, module])),
    [modules],
  );

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (openMenuId && !menuRef.current?.contains(event.target as Node)) setOpenMenuId(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpenMenuId(null);
        setRenameDraft(null);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenuId]);

  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);

  const applyWithUndo = (
    next: ModuleWorkspaceLayout,
    label: string,
    previousLayout = layout,
  ): void => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    onLayoutChange(next);
    setUndoState({ label, previousLayout });
    undoTimerRef.current = setTimeout(() => {
      setUndoState(null);
      undoTimerRef.current = null;
    }, 5_000);
  };

  const moveGroup = (groupId: string, delta: -1 | 1): void => {
    const ids = layout.groups.map((group) => group.id);
    const index = ids.indexOf(groupId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    onLayoutChange(reorderModuleGroups(layout, ids));
    setOpenMenuId(null);
  };

  return (
    <section className="otto-module-workspace-shell" aria-label="功能组">
      <div className="otto-module-workspace__toolbar">
        <button
          type="button"
          aria-label="添加功能组"
          onClick={() => onLayoutChange(createModuleGroup(layout))}
        >＋ 添加功能组</button>
        {defaultLayout ? (
          <button type="button" onClick={() => setConfirmState({ kind: 'restore-defaults' })}>
            恢复默认布局
          </button>
        ) : null}
      </div>
      <div
        className={`otto-module-workspace otto-module-workspace--${presentation}`}
        data-presentation={presentation}
      >
        {layout.groups.map((group, groupIndex) => {
        const groupModules = group.moduleIds
          .map((moduleId) => modulesById.get(moduleId))
          .filter((module): module is ModuleDefinition => Boolean(module));
        const capacity = group.rows * 3;
        const overflowing = groupModules.length > capacity;
        return (
          <article
            className={`otto-module-group${editingGroupId === group.id ? ' is-editing' : ''}`}
            key={group.id}
            data-group-id={group.id}
          >
            <header className="otto-module-group__header">
              {renameDraft?.groupId === group.id ? (
                <div className="otto-module-group__rename">
                  <input
                    autoFocus
                    aria-label="功能组名称"
                    value={renameDraft.value}
                    onChange={(event) => setRenameDraft({
                      ...renameDraft,
                      value: event.target.value,
                      error: null,
                    })}
                  />
                  <button
                    type="button"
                    aria-label="保存名称"
                    onClick={() => {
                      const error = validateModuleGroupName(layout, group.id, renameDraft.value);
                      if (error) {
                        setRenameDraft({ ...renameDraft, error });
                        return;
                      }
                      onLayoutChange(renameModuleGroup(layout, group.id, renameDraft.value));
                      setRenameDraft(null);
                    }}
                  >
                    保存
                  </button>
                  {renameDraft.error ? <span role="alert">{renameDraft.error}</span> : null}
                </div>
              ) : <h2>{group.name}</h2>}
              <div className="otto-module-group__menu-wrap" ref={openMenuId === group.id ? menuRef : undefined}>
                <button
                  type="button"
                  className="otto-module-group__menu-button"
                  aria-label={`功能组菜单：${group.name}`}
                  aria-expanded={openMenuId === group.id}
                  onClick={() => setOpenMenuId((current) => current === group.id ? null : group.id)}
                >
                  ···
                </button>
                {openMenuId === group.id ? (
                  <div className="otto-module-group__menu" role="menu" aria-label={`${group.name}设置`}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setEditingGroupId((current) => current === group.id ? null : group.id);
                        setOpenMenuId(null);
                      }}
                    >
                      {editingGroupId === group.id ? '完成编辑' : '编辑模块'}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setRenameDraft({ groupId: group.id, value: group.name, error: null });
                        setOpenMenuId(null);
                      }}
                    >重命名</button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onLayoutChange(updateModuleGroupRows(layout, group.id, group.rows === 2 ? 3 : 2));
                        setOpenMenuId(null);
                      }}
                    >{group.rows === 2 ? '显示三行' : '显示两行'}</button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={groupIndex === 0}
                      onClick={() => moveGroup(group.id, -1)}
                    >上移功能组</button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={groupIndex === layout.groups.length - 1}
                      onClick={() => moveGroup(group.id, 1)}
                    >下移功能组</button>
                    <button
                      type="button"
                      role="menuitem"
                      className="is-danger"
                      disabled={layout.groups.length <= 1}
                      onClick={() => {
                        setConfirmState({ kind: 'delete-group', groupId: group.id });
                        setOpenMenuId(null);
                      }}
                    >删除功能组</button>
                  </div>
                ) : null}
              </div>
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
                  <div className="otto-module-tile-wrap" key={module.id}>
                    <button
                      type="button"
                      className="otto-module-tile"
                      aria-label={`打开 ${module.label}`}
                      disabled={disabled || editingGroupId === group.id}
                      title={disabled ? module.disabledReason : module.description}
                      onClick={() => onActivate(module)}
                    >
                      <ModuleIcon icon={module.icon} label={module.label} />
                      <span>{module.label}</span>
                    </button>
                    {editingGroupId === group.id ? (
                      <button
                        type="button"
                        className="otto-module-tile__remove"
                        aria-label={`移除 ${module.label}`}
                        onClick={() => applyWithUndo(
                          removeModuleFromGroup(layout, group.id, module.id),
                          '模块已移除',
                        )}
                      >−</button>
                    ) : null}
                  </div>
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
      </div>
      {undoState ? (
        <div className="otto-module-workspace__undo" role="status">
          <span>{undoState.label}</span>
          <button
            type="button"
            aria-label={undoState.label === '功能组已删除' ? '撤销删除' : '撤销移除'}
            onClick={() => {
              if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
              onLayoutChange(undoState.previousLayout);
              setUndoState(null);
            }}
          >撤销</button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmState?.kind === 'delete-group'}
        title="删除功能组"
        message="删除后，组内模块会回到模块超市，模块和专家数据不会被删除。"
        confirmText="确认删除"
        onConfirm={() => {
          if (confirmState?.kind !== 'delete-group') return;
          applyWithUndo(deleteModuleGroup(layout, confirmState.groupId), '功能组已删除');
          setEditingGroupId(null);
          setConfirmState(null);
        }}
        onCancel={() => setConfirmState(null)}
      />
      <ConfirmDialog
        open={confirmState?.kind === 'restore-defaults'}
        title="恢复默认布局"
        message="仅恢复功能组与模块排列，不会删除专家或业务数据。"
        confirmText="恢复默认"
        danger={false}
        onConfirm={() => {
          if (defaultLayout) onLayoutChange(defaultLayout);
          setConfirmState(null);
        }}
        onCancel={() => setConfirmState(null)}
      />
    </section>
  );
}
