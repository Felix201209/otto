// 浏览器预览构建：esbuild 打包 renderer → dist-preview/（不进 git，仅本地预览用）
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const root = __dirname;
const outdir = path.join(root, 'dist-preview');

esbuild.build({
  entryPoints: [path.join(root, 'src/renderer/index.tsx')],
  bundle: true,
  outfile: path.join(outdir, 'main.js'),
  format: 'iife',
  jsx: 'automatic',
  target: 'chrome120',
  sourcemap: true,
  define: { 'process.env.NODE_ENV': '"development"' },
  loader: {
    '.png': 'dataurl',
    '.svg': 'dataurl',
    '.jpg': 'dataurl',
    '.jpeg': 'dataurl',
    '.gif': 'dataurl',
  },
  logLevel: 'info',
}).then(() => {
  // 生成预览 HTML：基于 src/renderer/index.html，注入 bundle 引用
  const template = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const html = template.replace(
    '</body>',
    `  <link rel="stylesheet" href="./main.css?v=${Date.now()}" />\n  <script src="./main.js?v=${Date.now()}"></script>\n  </body>`,
  );
  fs.writeFileSync(path.join(outdir, 'index.html'), html);
  console.log('PREVIEW_READY ' + outdir);
}).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
