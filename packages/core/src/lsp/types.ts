/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { ChildProcess } from 'node:child_process';
import type { MessageConnection } from 'vscode-jsonrpc';

export interface LSPServerInfo {
    id: string;
    displayName: string;
    extensions: string[];
    root: (file: string) => Promise<string>;
    spawn: (root: string) => Promise<{ process: ChildProcess }>;
}

export interface LSPClientInfo {
    serverID: string;
    root: string;
    connection: MessageConnection;
    capabilities: unknown;
}
