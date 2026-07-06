/**
 * 用 esbuild 把 Electron main 进程打包成 CJS 单文件。
 * 解决 Electron 33 (Node v20.18.3) 的 ESM 兼容性问题。
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname_esm = dirname(fileURLToPath(import.meta.url));
const absOutfile = resolve(__dirname_esm, 'dist/main/index.cjs');
const absFileUrl = pathToFileURL(absOutfile).href;

// 1. esbuild 打包成 CJS
await build({
  entryPoints: ['dist/main/index.js'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/main/index.cjs',
  external: ['electron', 'original-fs'],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'info',
});

// 2. 后处理：注入 import.meta.url polyfill
const polyfill = `
// === import.meta.url polyfill for CJS bundle (injected by build-cjs.mjs) ===
var __otto_cjs_file_url = ${JSON.stringify(absFileUrl)};
`;
const code = readFileSync(absOutfile, 'utf-8');
const patched = code.replace(
  /(import_meta\d*\s*=\s*\{\})/g,
  (match, varDecl) => {
    const varName = varDecl.split('=')[0].trim();
    return `${varName} = { url: __otto_cjs_file_url }`;
  }
);
const final = polyfill + patched;
writeFileSync(absOutfile, final);

console.log('✅ CJS bundle with import.meta polyfill:', absOutfile);
console.log('   import.meta.url =>', absFileUrl);
