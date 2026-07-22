/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

export type NativeHotPathId = 'agent_pool' | 'session_store' | 'tokenizer';

export interface NativeHotPathContract {
  id: NativeHotPathId;
  purpose: string;
  rustModule: string;
  methods: readonly string[];
  legacyOwner: string;
}

export const NATIVE_HOT_PATH_CONTRACTS: readonly NativeHotPathContract[] = [
  {
    id: 'agent_pool',
    purpose: 'Sub-agent concurrency, memory accounting, idle cleanup, and pending-log buffering.',
    rustModule: 'otto-native/src/agent_pool.rs',
    legacyOwner: 'packages/core/src/core/subAgent.ts and packages/core/src/core/agentResourceBudget.ts',
    methods: [
      'agent_pool.create',
      'agent_pool.register',
      'agent_pool.unregister',
      'agent_pool.update_memory',
      'agent_pool.add_log',
      'agent_pool.drain_pending',
      'agent_pool.stats',
      'agent_pool.list_agents',
      'agent_pool.cleanup_idle',
    ],
  },
  {
    id: 'session_store',
    purpose: 'Session persistence, metadata listing, cache-aware reads, and bounded on-disk history.',
    rustModule: 'otto-native/src/session_store.rs',
    legacyOwner: 'packages/core/src/services/sessionManager.ts',
    methods: [
      'session_store.open',
      'session_store.save',
      'session_store.load',
      'session_store.delete',
      'session_store.list',
      'session_store.size_bytes',
    ],
  },
  {
    id: 'tokenizer',
    purpose: 'Local token counting, truncation, and model tokenizer capability discovery.',
    rustModule: 'otto-native/src/tokenizer.rs',
    legacyOwner: 'packages/core/src/core/tokenLimits.ts and tool-schema budget callers',
    methods: [
      'tokenizer.create',
      'tokenizer.count',
      'tokenizer.truncate',
      'tokenizer.supported_models',
    ],
  },
];

export const REQUIRED_NATIVE_HOT_PATH_METHODS = Object.freeze(
  NATIVE_HOT_PATH_CONTRACTS.flatMap((contract) => contract.methods),
);

export function validateNativeHotPathCoverage(methods: readonly string[]): string[] {
  const available = new Set(methods);
  return REQUIRED_NATIVE_HOT_PATH_METHODS.filter((method) => !available.has(method));
}
