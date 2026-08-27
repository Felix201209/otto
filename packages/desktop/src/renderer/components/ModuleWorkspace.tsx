/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
// Motion exposes its React runtime through this documented package entrypoint.
// eslint-disable-next-line import/no-internal-modules
import { Reorder, useDragControls, useReducedMotion } from 'motion/react';

import type { ModuleDefinition } from '../moduleCatalog.js';
import {
  createModuleGroup,
  deleteModuleGroup,
  removeModuleFromGroup,
  renameModuleGroup,
  reorderModuleGroups,
  reorderModulesInGroup,
  updateModuleGroupRows,
  validateModuleGroupName,
  type ModuleWorkspaceLayout,
} from '../moduleWorkspace.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ModuleIcon } from './ModuleIcon.js';
import '../styles/module-workspace.css';

interface DraggableItemProps {
  value: string;
  className: string;
  dataAttribute: Record<string, string>;
  reducedMotion: boolean;
  stopDragEndPropagation?: boolean;
  onDragEnd(): void;
  children(dragControls: ReturnType<typeof useDragControls>): React.ReactNode;
}

function DraggableItem({
  value,
  className,
  dataAttribute,
  reducedMotion,
  stopDragEndPropagation = false,
  onDragEnd,
  children,
}: DraggableItemProps): React.JSX.Element {
  const dragControls = useDragControls();
  return (
    <Reorder.Item
      as="div"
      value={value}
      className={className}
      dragListener={false}
      dragControls={dragControls}
      layout
      whileDrag={reducedMotion ? undefined : {
        scale: 1.015,
        boxShadow: '0 12px 30px rgba(15, 23, 42, 0.14)',
      }}
      transition={reducedMotion ? { duration: 0 } : {
        type: 'spring',
        stiffness: 420,
        damping: 34,
      }}
      onDragEnd={(event: MouseEvent | TouchEvent | PointerEvent) => {
        if (stopDragEndPropagation) event.stopPropagation();
        onDragEnd();
      }}
      {...dataAttribute}
    >
      {children(dragControls)}
    </Reorder.Item>
  );
}

function mergeVisibleModuleOrder(
  existingModuleIds: readonly string[],
  orderedVisibleModuleIds: readonly string[],
): string[] {
  const visible = new Set(orderedVisibleModuleIds);
  let visibleIndex = 0;
  return existingModuleIds.map((moduleId) => (
    visible.has(moduleId)
      ? orderedVisibleModuleIds[visibleIndex++] ?? moduleId
      : moduleId
  ));
}

function autoScrollAtPointer(
  element: HTMLElement,
  clientY: number,
  threshold = 40,
  step = 18,
): void {
  if (element.scrollHeight <= element.clientHeight) return;
  const rect = element.getBoundingClientRect();
  if (clientY >= rect.bottom - threshold) {
    element.scrollTop += step;
  } else if (clientY <= rect.top + threshold) {
    element.scrollTop -= step;
  }
}

export interface ModuleWorkspaceProps {
  presentation: 'panel' | 'page';
  scopeKey?: string;
  layout: ModuleWorkspaceLayout;
  defaultLayout?: ModuleWorkspaceLayout;
  modules: readonly ModuleDefinition[];
  onActivate(module: ModuleDefinition): void;
  onOpenMarketplace(groupId: string): void;
  onLayoutChange(next: ModuleWorkspaceLayout): void;
}

type WorkspacePopover =
  | { kind: 'group'; id: string }
  | { kind: 'module'; key: string }
  | null;

export function ModuleWorkspace({
  presentation,
  scopeKey = 'default',
  layout,
  defaultLayout,
  modules,
  onActivate,
  onOpenMarketplace,
  onLayoutChange,
}: ModuleWorkspaceProps): React.JSX.Element {
  const [openPopover, setOpenPopover] = useState<WorkspacePopover>(null);
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
    appliedSignature: string;
  } | null>(null);
  const [transientLayout, setTransientLayout] = useState(layout);
  const menuRef = useRef<HTMLDivElement>(null);
  const popoverTriggerRef = useRef<HTMLButtonElement | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transientLayoutRef = useRef(layout);
  const previousScopeRef = useRef(scopeKey);
  const reducedMotion = Boolean(useReducedMotion());
  const modulesById = useMemo(
    () => new Map(modules.map((module) => [module.id, module])),
    [modules],
  );

  useEffect(() => {
    const closePopoverAndRestoreFocus = (): void => {
      setOpenPopover(null);
      popoverTriggerRef.current?.focus();
    };
    const onPointerDown = (event: MouseEvent): void => {
      if (openPopover && !menuRef.current?.contains(event.target as Node)) {
        closePopoverAndRestoreFocus();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (openPopover) closePopoverAndRestoreFocus();
        setRenameDraft(null);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openPopover]);

  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);

  useEffect(() => {
    if (previousScopeRef.current === scopeKey) return;
    previousScopeRef.current = scopeKey;
    setOpenPopover(null);
    setEditingGroupId(null);
    setRenameDraft(null);
    setConfirmState(null);
    setUndoState(null);
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
  }, [scopeKey]);

  useEffect(() => {
    transientLayoutRef.current = layout;
    setTransientLayout(layout);
  }, [layout]);

  useEffect(() => {
    if (!undoState || JSON.stringify(layout) === undoState.appliedSignature) return;
    setUndoState(null);
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
  }, [layout, undoState]);

  const commitLayout = (next: ModuleWorkspaceLayout): void => {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndoState(null);
    onLayoutChange(next);
  };

  const applyWithUndo = (
    next: ModuleWorkspaceLayout,
    label: string,
  ): void => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    onLayoutChange(next);
    setUndoState({
      label,
      previousLayout: layout,
      appliedSignature: JSON.stringify(next),
    });
    undoTimerRef.current = setTimeout(() => {
      setUndoState(null);
      undoTimerRef.current = null;
    }, 5_000);
  };

  const moveGroup = (groupId: string, targetIndex: number): void => {
    const ids = layout.groups.map((group) => group.id);
    const index = ids.indexOf(groupId);
    if (index < 0 || targetIndex < 0 || targetIndex >= ids.length || index === targetIndex) return;
    ids.splice(index, 1);
    ids.splice(targetIndex, 0, groupId);
    commitLayout(reorderModuleGroups(layout, ids));
    setOpenPopover(null);
  };

  const moveModule = (groupId: string, moduleId: string, targetIndex: number): void => {
    const group = layout.groups.find((candidate) => candidate.id === groupId);
    if (!group) return;
    const ids = [...group.moduleIds];
    const index = ids.indexOf(moduleId);
    if (index < 0 || targetIndex < 0 || targetIndex >= ids.length || index === targetIndex) return;
    ids.splice(index, 1);
    ids.splice(targetIndex, 0, moduleId);
    commitLayout(reorderModulesInGroup(layout, groupId, ids));
    setOpenPopover(null);
  };

  const updateTransientLayout = (next: ModuleWorkspaceLayout): void => {
    transientLayoutRef.current = next;
    setTransientLayout(next);
  };

  const persistTransientLayout = (): void => {
    const next = transientLayoutRef.current;
    if (JSON.stringify(next) === JSON.stringify(layout)) return;
    commitLayout(next);
  };

  return (
    <section className="otto-module-workspace-shell" aria-label="功能组">
      <div className="otto-module-workspace__toolbar">
        <button
          type="button"
          aria-label="添加功能组"
          onClick={() => commitLayout(createModuleGroup(layout))}
        >＋ 添加功能组</button>
        {defaultLayout ? (
          <button type="button" onClick={() => setConfirmState({ kind: 'restore-defaults' })}>
            恢复默认布局
          </button>
        ) : null}
      </div>
      <Reorder.Group
        as="div"
        axis={presentation === 'panel' ? 'y' : undefined}
        values={transientLayout.groups.map((group) => group.id)}
        onReorder={(orderedGroupIds) => updateTransientLayout(
          reorderModuleGroups(transientLayoutRef.current, orderedGroupIds),
        )}
        className={`otto-module-workspace otto-module-workspace--${presentation}${
          reducedMotion ? ' is-reduced-motion' : ''
        }`}
        data-presentation={presentation}
        data-reorder-group="groups"
        onPointerMove={(event: React.PointerEvent<HTMLDivElement>) => (
          autoScrollAtPointer(event.currentTarget, event.clientY)
        )}
      >
        {transientLayout.groups.map((group, groupIndex) => {
        const groupModules = group.moduleIds
          .map((moduleId) => modulesById.get(moduleId))
          .filter((module): module is ModuleDefinition => Boolean(module));
        const capacity = group.rows * 3;
        const overflowing = groupModules.length > capacity;
        return (
          <DraggableItem
            key={group.id}
            value={group.id}
            className="otto-module-group-reorder-item"
            dataAttribute={{ 'data-reorder-group-item': group.id }}
            reducedMotion={reducedMotion}
            onDragEnd={persistTransientLayout}
          >
            {(groupDragControls) => (
          <article
            className={`otto-module-group${editingGroupId === group.id ? ' is-editing' : ''}`}
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
                      commitLayout(renameModuleGroup(layout, group.id, renameDraft.value));
                      setRenameDraft(null);
                    }}
                  >
                    保存
                  </button>
                  {renameDraft.error ? <span role="alert">{renameDraft.error}</span> : null}
                </div>
              ) : <h2>{group.name}</h2>}
              <div className="otto-module-group__header-actions">
                {editingGroupId === group.id ? (
                  <button
                    type="button"
                    className="otto-module-group__drag-handle"
                    aria-label={`拖动功能组：${group.name}`}
                    title="拖动调整功能组顺序"
                    onPointerDown={(event) => groupDragControls.start(event)}
                  >⠿</button>
                ) : null}
              <div className="otto-module-group__menu-wrap" ref={openPopover?.kind === 'group' && openPopover.id === group.id ? menuRef : undefined}>
                <button
                  type="button"
                  className="otto-module-group__menu-button"
                  aria-label={`功能组菜单：${group.name}`}
                  aria-expanded={openPopover?.kind === 'group' && openPopover.id === group.id}
                  onClick={(event) => {
                    popoverTriggerRef.current = event.currentTarget;
                    setOpenPopover((current) => (
                      current?.kind === 'group' && current.id === group.id
                        ? null
                        : { kind: 'group', id: group.id }
                    ));
                  }}
                >
                  ···
                </button>
                {openPopover?.kind === 'group' && openPopover.id === group.id ? (
                  <div className="otto-module-group__menu" role="menu" aria-label={`${group.name}设置`}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setEditingGroupId((current) => current === group.id ? null : group.id);
                        setOpenPopover(null);
                      }}
                    >
                      {editingGroupId === group.id ? '完成编辑' : '编辑模块'}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setRenameDraft({ groupId: group.id, value: group.name, error: null });
                        setOpenPopover(null);
                      }}
                    >重命名</button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        commitLayout(updateModuleGroupRows(layout, group.id, group.rows === 2 ? 3 : 2));
                        setOpenPopover(null);
                      }}
                    >{group.rows === 2 ? '显示三行' : '显示两行'}</button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={groupIndex === 0}
                      onClick={() => moveGroup(group.id, groupIndex - 1)}
                    >上移功能组</button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={groupIndex === layout.groups.length - 1}
                      onClick={() => moveGroup(group.id, groupIndex + 1)}
                    >下移功能组</button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={groupIndex === 0}
                      onClick={() => moveGroup(group.id, 0)}
                    >移到最前功能组</button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={groupIndex === layout.groups.length - 1}
                      onClick={() => moveGroup(group.id, layout.groups.length - 1)}
                    >移到最后功能组</button>
                    <button
                      type="button"
                      role="menuitem"
                      className="is-danger"
                      disabled={layout.groups.length <= 1}
                      onClick={() => {
                        setConfirmState({ kind: 'delete-group', groupId: group.id });
                        setOpenPopover(null);
                      }}
                    >删除功能组</button>
                  </div>
                ) : null}
              </div>
              </div>
            </header>
            <Reorder.Group
              as="div"
              axis="xy"
              values={groupModules.map((module) => module.id)}
              onReorder={(orderedVisibleIds) => {
                const current = transientLayoutRef.current;
                const currentGroup = current.groups.find((candidate) => candidate.id === group.id);
                if (!currentGroup) return;
                const mergedOrder = mergeVisibleModuleOrder(
                  currentGroup.moduleIds,
                  orderedVisibleIds,
                );
                updateTransientLayout(reorderModulesInGroup(current, group.id, mergedOrder));
              }}
              className={`otto-module-group__grid otto-module-group__grid--rows-${group.rows}${
                overflowing ? ' is-overflowing' : ''
              }`}
              data-reorder-group={`modules:${group.id}`}
              layoutScroll={overflowing}
              tabIndex={overflowing ? 0 : undefined}
              aria-label={`${group.name}模块`}
              onPointerMove={(event: React.PointerEvent<HTMLDivElement>) => (
                autoScrollAtPointer(event.currentTarget, event.clientY)
              )}
            >
              {groupModules.map((module, moduleIndex) => {
                const disabled = module.availability !== 'available';
                const moduleMenuKey = `${group.id}:${module.id}`;
                return (
                  <DraggableItem
                    key={module.id}
                    value={module.id}
                    className="otto-module-reorder-item"
                    dataAttribute={{
                      'data-reorder-module-item': `${group.id}:${module.id}`,
                    }}
                    reducedMotion={reducedMotion}
                    stopDragEndPropagation
                    onDragEnd={persistTransientLayout}
                  >
                    {(moduleDragControls) => (
                  <div
                    className="otto-module-tile-wrap"
                    ref={openPopover?.kind === 'module' && openPopover.key === moduleMenuKey ? menuRef : undefined}
                  >
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
                      <>
                        <button
                          type="button"
                          className="otto-module-tile__drag-handle"
                          aria-label={`拖动模块：${module.label}`}
                          title="拖动调整模块顺序"
                          onPointerDown={(event) => moduleDragControls.start(event)}
                        >⠿</button>
                        <button
                          type="button"
                          className="otto-module-tile__remove"
                          aria-label={`移除 ${module.label}`}
                          onClick={() => applyWithUndo(
                            removeModuleFromGroup(layout, group.id, module.id),
                            '模块已移除',
                          )}
                        >−</button>
                        <button
                          type="button"
                          className="otto-module-group__menu-button otto-module-tile__menu-button"
                          aria-label={`模块菜单：${module.label}`}
                          aria-expanded={openPopover?.kind === 'module' && openPopover.key === moduleMenuKey}
                          onClick={(event) => {
                            popoverTriggerRef.current = event.currentTarget;
                            setOpenPopover((current) => (
                              current?.kind === 'module' && current.key === moduleMenuKey
                                ? null
                                : { kind: 'module', key: moduleMenuKey }
                            ));
                          }}
                        >···</button>
                        {openPopover?.kind === 'module' && openPopover.key === moduleMenuKey ? (
                          <div className="otto-module-group__menu otto-module-tile__menu" role="menu" aria-label={`${module.label}设置`}>
                            <button
                              type="button"
                              role="menuitem"
                              disabled={moduleIndex === 0}
                              onClick={() => moveModule(group.id, module.id, moduleIndex - 1)}
                            >向前移动模块</button>
                            <button
                              type="button"
                              role="menuitem"
                              disabled={moduleIndex === groupModules.length - 1}
                              onClick={() => moveModule(group.id, module.id, moduleIndex + 1)}
                            >向后移动模块</button>
                            <button
                              type="button"
                              role="menuitem"
                              disabled={moduleIndex === 0}
                              onClick={() => moveModule(group.id, module.id, 0)}
                            >移到最前模块</button>
                            <button
                              type="button"
                              role="menuitem"
                              disabled={moduleIndex === groupModules.length - 1}
                              onClick={() => moveModule(group.id, module.id, groupModules.length - 1)}
                            >移到最后模块</button>
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                    )}
                  </DraggableItem>
                );
              })}
              {groupModules.length === 0 ? (
                <div className="otto-module-group__empty">还没有添加模块</div>
              ) : null}
            </Reorder.Group>
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
            )}
          </DraggableItem>
        );
        })}
      </Reorder.Group>
      {undoState ? (
        <div className="otto-module-workspace__undo" role="status">
          <span>{undoState.label}</span>
          <button
            type="button"
            aria-label={undoState.label === '功能组已删除' ? '撤销删除' : '撤销移除'}
            onClick={() => {
              if (undoTimerRef.current) {
                clearTimeout(undoTimerRef.current);
                undoTimerRef.current = null;
              }
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
          if (defaultLayout) commitLayout(defaultLayout);
          setConfirmState(null);
        }}
        onCancel={() => setConfirmState(null)}
      />
    </section>
  );
}
