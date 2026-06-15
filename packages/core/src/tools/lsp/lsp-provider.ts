/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
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
