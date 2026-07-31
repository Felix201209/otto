/**
 * electron-builder 打包后钩子。
 *
 * 公开测试渠道暂未使用 Apple Developer ID；electron-builder 在 identity:null
 * 时只留下 linker 签名，资源没有封存，经过下载隔离后容易被 Gatekeeper 判成
 * “App 已损坏”。这里为 macOS bundle 补完整的深度 ad-hoc 签名并立即严格校验。
 * 它不能替代 Apple 公证，但能确保 DMG 中的 App 自身结构和资源封存有效。
 */

const { execFileSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, readdirSync } = require('node:fs');
const path = require('node:path');

function electronBuilderArchName(value) {
  if (value === 'x64' || value === 1) return 'x64';
  if (value === 'arm64' || value === 3) return 'arm64';
  throw new Error(`[after-pack] unsupported SQLCipher architecture: ${value}`);
}

function copySqlCipherNativeAsset(context) {
  const platform = context.electronPlatformName;
  if (!['win32', 'darwin', 'linux'].includes(platform)) {
    throw new Error(`[after-pack] unsupported SQLCipher platform: ${platform}`);
  }
  const arch = electronBuilderArchName(context.arch);
  const target = `${platform}-${arch}`;
  const repoRoot = path.resolve(__dirname, '../../..');
  const sourceRoot = path.join(repoRoot, 'native', 'sqlcipher');
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'verify-sqlcipher-native-assets.mjs'),
      '--root',
      sourceRoot,
      '--target',
      target,
    ],
    { stdio: 'inherit' },
  );
  const resourcesRoot =
    platform === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources',
        )
      : path.join(context.appOutDir, 'resources');
  const destination = path.join(resourcesRoot, 'sqlcipher');
  mkdirSync(destination, { recursive: true });
  for (const name of ['better_sqlite3.node', 'manifest.json']) {
    copyFileSync(
      path.join(sourceRoot, target, name),
      path.join(destination, name),
    );
  }
  copyFileSync(
    path.join(sourceRoot, 'THIRD_PARTY_NOTICES.md'),
    path.join(destination, 'THIRD_PARTY_NOTICES.md'),
  );
  console.log(`[after-pack] SQLCipher native asset copied: ${target}`);
}

function findNestedLibreOfficeBundles(appPath) {
  const runtimeRoot = path.join(appPath, 'Contents', 'Resources', 'runtime');
  if (!existsSync(runtimeRoot)) return [];

  return readdirSync(runtimeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      path.join(runtimeRoot, entry.name, 'libreoffice', 'LibreOffice.app'),
    )
    .filter(existsSync)
    .sort();
}

async function afterPack(context) {
  copySqlCipherNativeAsset(context);
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
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
    console.log(
      `[after-pack] 内置 LibreOffice ad-hoc 签名校验通过：${libreOfficePath}`,
    );
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });
  console.log(`[after-pack] macOS ad-hoc 签名校验通过：${appPath}`);
}

module.exports = afterPack;
module.exports.findNestedLibreOfficeBundles = findNestedLibreOfficeBundles;
module.exports.copySqlCipherNativeAsset = copySqlCipherNativeAsset;
module.exports.electronBuilderArchName = electronBuilderArchName;
