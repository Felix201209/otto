/**
 * electron-builder 打包后钩子。
 *
 * 公开测试渠道暂未使用 Apple Developer ID；electron-builder 在 identity:null
 * 时只留下 linker 签名，资源没有封存，经过下载隔离后容易被 Gatekeeper 判成
 * “App 已损坏”。这里为 macOS bundle 补完整的深度 ad-hoc 签名并立即严格校验。
 * 它不能替代 Apple 公证，但能确保 DMG 中的 App 自身结构和资源封存有效。
 */

const { execFileSync } = require('node:child_process');
const { existsSync, readdirSync } = require('node:fs');
const path = require('node:path');

function findNestedLibreOfficeBundles(appPath) {
  const runtimeRoot = path.join(
    appPath,
    'Contents',
    'Resources',
    'runtime',
  );
  if (!existsSync(runtimeRoot)) return [];

  return readdirSync(runtimeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      path.join(
        runtimeRoot,
        entry.name,
        'libreoffice',
        'LibreOffice.app',
      ))
    .filter(existsSync)
    .sort();
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  for (const libreOfficePath of findNestedLibreOfficeBundles(appPath)) {
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', '-', libreOfficePath],
      { stdio: 'inherit' },
    );
    execFileSync(
      'codesign',
      ['--verify', '--deep', '--strict', libreOfficePath],
      { stdio: 'inherit' },
    );
    console.log(`[after-pack] 内置 LibreOffice ad-hoc 签名校验通过：${libreOfficePath}`);
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`[after-pack] macOS ad-hoc 签名校验通过：${appPath}`);
}

module.exports = afterPack;
module.exports.findNestedLibreOfficeBundles = findNestedLibreOfficeBundles;
