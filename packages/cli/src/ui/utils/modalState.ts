/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


/**
 * Global modal state to prevent ESC key conflicts
 * When a modal is open, other components should not process ESC
 */
let _backgroundTaskPanelOpen = false;

export function setBackgroundTaskPanelOpen(open: boolean): void {
  _backgroundTaskPanelOpen = open;
}

export function isBackgroundTaskPanelOpen(): boolean {
  return _backgroundTaskPanelOpen;
}

let _workflowPanelOpen = false;

export function setWorkflowPanelOpen(open: boolean): void {
  _workflowPanelOpen = open;
}

export function isWorkflowPanelOpen(): boolean {
  return _workflowPanelOpen;
}

let _sideQuestionPanelOpen = false;

export function setSideQuestionPanelOpen(open: boolean): void {
  _sideQuestionPanelOpen = open;
}

export function isSideQuestionPanelOpen(): boolean {
  return _sideQuestionPanelOpen;
}
