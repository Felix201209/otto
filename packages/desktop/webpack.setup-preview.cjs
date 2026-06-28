const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
module.exports = {
  target: 'web', mode: 'development', devtool: false,
  entry: path.resolve(__dirname, 'preview/setup-preview.tsx'),
  output: { path: path.resolve(__dirname, 'setup-preview-dist'), filename: 'main.js', clean: true },
  resolve: { extensions: ['.tsx','.ts','.jsx','.js'], extensionAlias: { '.js': ['.ts','.tsx','.js'], '.jsx': ['.tsx','.jsx'] } },
  module: { rules: [
    { test: /\.tsx?$/, loader: 'ts-loader', options: { configFile: path.resolve(__dirname,'tsconfig.renderer.json'), transpileOnly: true } },
    { test: /\.css$/, use: ['style-loader','css-loader'] },
    { test: /\.(png|jpe?g|gif|svg)$/i, type: 'asset/inline' },
  ] },
  plugins: [ new HtmlWebpackPlugin({ template: path.resolve(__dirname,'src/renderer/index.html'), filename: 'index.html', inject: 'body' }) ],
  performance: { hints: false },
};
