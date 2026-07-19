/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 资源副作用/默认导入的类型声明。
 * 运行时由 webpack(style-loader / asset 模块)处理；tsc 仅需放行这些 import。
 */
declare module '*.css';
declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.jpg' {
  const src: string;
  export default src;
}
declare module '*.jpeg' {
  const src: string;
  export default src;
}
declare module '*.gif' {
  const src: string;
  export default src;
}
declare module '*.svg' {
  const src: string;
  export default src;
}
