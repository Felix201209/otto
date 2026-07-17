/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/** 浏览器实时模式 webpack 构建 —— 连真实 otto-server，Electron 崩了也能用。 */

const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  target: 'web',
  mode: 'development',
  devtool: 'source-map',
  entry: path.resolve(__dirname, 'preview/live.tsx'),
  output: {
    path: path.resolve(__dirname, 'live-dist'),
    filename: 'main.js',
    clean: true,
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.jsx', '.js'],
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    },
    // 浏览器环境不可用的 Node/Electron 模块 → 空 mock
    alias: {
      electron: false,
      'qrcode-terminal': false,
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
      },
      { test: /\.css$/, use: ['style-loader', 'css-loader'] },
      { test: /\.(png|jpe?g|gif|svg)$/i, type: 'asset/inline' },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: path.resolve(__dirname, 'src/renderer/index.html'),
      filename: 'index.html',
      inject: 'body',
    }),
    // otto-server 是 monorepo 包，路径解析为 ../server
    new webpack.NormalModuleReplacementPlugin(
      /^otto-server$/,
      path.resolve(__dirname, '../server/dist/index.js'),
    ),
    // preload/index.js → 空对象（只有 type，运行时不需要）
    new webpack.NormalModuleReplacementPlugin(
      /\/preload\/index\.js$/,
      path.resolve(__dirname, 'preview/live-bridge.ts'),
    ),
  ],
  devServer: {
    static: false,
    hot: true,
    port: 3000,
    open: false,
  },
  performance: { hints: false },
};
