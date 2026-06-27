/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { LSPManager } from '../../lsp/index.js';

let lspManagerInstance: LSPManager | null = null;

export function getLSPManager(projectRoot: string): LSPManager {
    if (!lspManagerInstance) {
        lspManagerInstance = new LSPManager(projectRoot);
    }
    return lspManagerInstance;
}
