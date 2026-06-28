/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 应用菜单（Issue #4「主进程 + 窗口 + 菜单 + 图标」）。
 *
 * macOS 习惯的标准菜单骨架（App / Edit / View / Window / Help），
 * 外加 Otto 专属项：New Chat、打开 server 端点文件、查看 server 状态。
 * 这些 Otto 项经 webContents.send 通知 renderer（renderer 后续接入 #5/#7），
 * 或直接走 shell 打开本地文件 —— 不引入跨人阻塞。
 */

import {
  app,
  Menu,
  shell,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from 'electron';
import { endpointFilePath } from 'otto-server';

const isMac = process.platform === 'darwin';

/** 给 renderer 发一个菜单动作（renderer 监听 'otto:menu' IPC）。 */
function emit(win: BrowserWindow | undefined, action: string): void {
  win?.webContents.send('otto:menu', action);
}

export function buildAppMenu(getWindow: () => BrowserWindow | undefined): Menu {
  const appName = app.name || 'Otto';

  const template: MenuItemConstructorOptions[] = [
    // ── macOS App 菜单 ──
    ...(isMac
      ? [
          {
            label: appName,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'Cmd+,',
                click: () => emit(getWindow(), 'open-settings'),
              },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),

    // ── File（Otto 专属）──
    {
      label: 'File',
      submenu: [
        {
          label: 'New Chat',
          accelerator: 'CmdOrCtrl+N',
          click: () => emit(getWindow(), 'new-chat'),
        },
        { type: 'separator' },
        ...(isMac
          ? [{ role: 'close' as const }]
          : [
              {
                label: 'Settings…',
                accelerator: 'Ctrl+,',
                click: () => emit(getWindow(), 'open-settings'),
              },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ]),
      ],
    },

    // ── Edit（复制/粘贴等标准角色）──
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },

    // ── View ──
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // 仅开发期暴露 DevTools（生产 .app 不显，避免误触）。
        ...(app.isPackaged
          ? []
          : [{ role: 'toggleDevTools' as const }]),
      ],
    },

    // ── Window ──
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const },
            ]
          : [{ role: 'close' as const }]),
      ],
    },

    // ── Help（Otto 专属诊断项）──
    {
      role: 'help',
      submenu: [
        {
          label: 'Reveal Server Endpoint File',
          click: () => {
            // 端点文件存在则在 Finder 高亮，否则打开其所在目录。
            void shell.showItemInFolder(endpointFilePath());
          },
        },
        {
          label: 'Otto on GitHub',
          click: () => {
            void shell.openExternal('https://github.com/Felix201209/otto');
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

/** 构建并设为应用菜单。 */
export function installAppMenu(getWindow: () => BrowserWindow | undefined): void {
  Menu.setApplicationMenu(buildAppMenu(getWindow));
}
