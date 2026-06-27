/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


/**
 * 环境检测模块导出
 */

export {
  detectVSCodeEnvironment,
  isVSCodeEnvironment,
  getEnvironmentDetectionDetails,
  getEnvironmentDetectionReport,
  detectVSCodeEnvironmentWithOverrides,
} from './environment-detector.js';

export type {
  EnvironmentDetectionResult,
  ProcessDetectionConfig,
} from './environment-types.js';

export {
  EnvironmentType,
  VSCodeDetectionMethod,
} from './environment-types.js';

export {
  ENVIRONMENT_VARIABLES,
  VSCODE_INDICATORS,
} from './environment-constants.js';
