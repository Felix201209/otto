/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Windows ripgrep 预编译包的固定供应链摘要。
 *
 * ZIP digest 来自 microsoft/ripgrep-prebuilt 对应 GitHub Release 资产元数据，
 * executable digest 由该 ZIP 中解出的 rg.exe 独立计算。升级
 * @vscode/ripgrep 时必须先人工核验新的上游资产，再新增映射。
 */
export const WINDOWS_RIPGREP_INTEGRITY = Object.freeze({
  'v15.0.0': Object.freeze({
    target: 'x86_64-pc-windows-msvc',
    zipSha256: '5b7f6a3020739ac4bdf2c32300f14388456361bea054d35270a18a3c9949b932',
    executableSha256: '331303d50b7cb4abe04ee549e57b04f65550ce936da1eeba4d4b05909c96eb29',
  }),
});
