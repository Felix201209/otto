/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 企业内测通道总开关。该模块不依赖 Node API，main 与 renderer 共用。
 *
 * 交付版本默认关闭，恢复真实登录、邀请注册和企业会话；代码保留，便于需要时
 * 构建明确标记的内部免登录测试包，而不是删除认证能力。
 */

/** 仅显式开启本地预览内测入口；正式启动默认仍强制企业验证。 */
export const INTERNAL_TEST_ACCESS_ENABLED =
  typeof process !== 'undefined'
  && process.env.OTTO_INTERNAL_TEST_ACCESS === '1';
