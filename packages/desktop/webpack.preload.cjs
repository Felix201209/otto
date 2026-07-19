/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Electron sandbox preload 不能用 CommonJS require 拆成本地多文件。
 *
 * 因此 preload 必须整体打成一个 CJS 文件，只把 Electron 自身留给运行时。
 * `sandbox: true` 与 `contextIsolation: true` 是安全边界，不能为规避打包问题关闭。
 */

const path = require('path');

module.exports = (_env, argv) => {
  const isProd = (argv && argv.mode) === 'production';
  return {
    target: 'electron-preload',
    entry: path.resolve(__dirname, 'src/preload/index.ts'),
    output: {
      path: path.resolve(__dirname, 'dist/preload'),
      filename: 'index.js',
      clean: true,
      globalObject: 'globalThis',
    },
    devtool: isProd ? false : 'source-map',
    resolve: {
      extensions: ['.ts', '.js'],
      extensionAlias: {
        '.js': ['.ts', '.js'],
      },
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          loader: 'ts-loader',
          options: {
            configFile: path.resolve(__dirname, 'tsconfig.preload.json'),
            transpileOnly: true,
          },
          exclude: /node_modules/,
        },
      ],
    },
    externals: {
      electron: 'commonjs2 electron',
    },
    optimization: {
      minimize: isProd,
    },
    performance: { hints: false },
  };
};
