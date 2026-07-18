/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * v1.8.6 内部测试总开关。该模块不依赖 Node API，main 与 renderer 共用：
 * renderer 屏蔽登录界面，main 同时 fail closed，禁止恢复旧企业会话或向外上报。
 */

export const INTERNAL_TEST_ACCESS_ENABLED = true;
