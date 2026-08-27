/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer 构建链（独立的 Electron renderer webpack@react18 范式）。
 *
 * 与历史 webview 构建的关键差异：
 *   - target: 'electron-renderer'（而非 'web'）—— renderer 跑在 Electron。
 *   - 自带 html-webpack-plugin 产出 index.html（webview 当年由 VSCode host 注入，
 *     移植到 Electron 必须自产；交付文档 [WEBVIEW] §1 已点明）。
 *   - 不 external 'vscode'（Electron 无 vscode；host-only 命令经 preload 桩掉）。
 */

const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = (_env, argv) => {
  const isProd = (argv && argv.mode) === 'production';
  return {
    target: 'electron-renderer',
    entry: path.resolve(__dirname, 'src/renderer/index.tsx'),
    output: {
      path: path.resolve(__dirname, 'dist/renderer'),
      filename: 'main.js',
      // contextIsolation + sandbox 下没有 Node 的 `global`。electron-renderer
      // target 默认会让 chunk runtime 引用它，生产包因此在 React 挂载前白屏。
      globalObject: 'globalThis',
      clean: true,
    },
    devtool: isProd ? false : 'source-map',
    resolve: {
      extensions: ['.tsx', '.ts', '.jsx', '.js'],
      // 源码用 NodeNext 风格的 .js 后缀 import（与全仓一致）；
      // 让 webpack 把 './App.js' 解析到 './App.tsx'。
      extensionAlias: {
        '.js': ['.ts', '.tsx', '.js'],
        '.jsx': ['.tsx', '.jsx'],
      },
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          loader: 'ts-loader',
          options: {
            configFile: path.resolve(__dirname, 'tsconfig.renderer.json'),
            transpileOnly: true,
          },
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
        {
          // 图片内联为 base64，避免 Electron file:// 下的外链资源解析。
          test: /\.(png|jpe?g|gif|svg)$/i,
          type: 'asset/inline',
        },
      ],
    },
    plugins: [
      // Renderer 在 sandbox 中不能读取任意运行时环境变量。只在构建命令明确
      // 设置 OTTO_INTERNAL_TEST_ACCESS=1 时烘焙本地免登录入口；普通构建恒为关闭。
      new webpack.DefinePlugin({
        __OTTO_INTERNAL_TEST_ACCESS__: JSON.stringify(
          process.env.OTTO_INTERNAL_TEST_ACCESS === '1',
        ),
      }),
      new HtmlWebpackPlugin({
        template: path.resolve(__dirname, 'src/renderer/index.html'),
        filename: 'index.html',
        inject: 'body',
      }),
    ],
    performance: { hints: false },
  };
};
