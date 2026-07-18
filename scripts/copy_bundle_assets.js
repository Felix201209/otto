/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { copyFileSync, existsSync, mkdirSync, statSync, readdirSync, chmodSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bundleDir = join(root, 'bundle');

// Create the bundle directory if it doesn't exist
if (!existsSync(bundleDir)) {
  mkdirSync(bundleDir);
}

// Find and copy all .sb files from packages to the root of the bundle directory
const sbFiles = glob.sync('packages/**/*.sb', { cwd: root });
for (const file of sbFiles) {
  copyFileSync(join(root, file), join(bundleDir, basename(file)));
}

// Copy help system assets (knowledge base markdown files)
const helpAssetsDir = join(bundleDir, 'assets', 'help');
if (!existsSync(helpAssetsDir)) {
  mkdirSync(helpAssetsDir, { recursive: true });
}

const helpSourceDir = join(root, 'packages', 'cli', 'src', 'assets', 'help');
if (existsSync(helpSourceDir)) {
  const helpFiles = readdirSync(helpSourceDir).filter(f => f.endsWith('.md'));
  for (const file of helpFiles) {
    const sourcePath = join(helpSourceDir, file);
    const targetPath = join(helpAssetsDir, file);
    copyFileSync(sourcePath, targetPath);
    console.log(`✅ Copied help asset: ${file}`);
  }
} else {
  console.warn('⚠️  Help assets directory not found, skipping help system files');
}



// Copy and setup cross-platform ripgrep module
async function copyRipgrepModule() {
  try {
    const require = createRequire(import.meta.url);

    // Get ripgrep module path
    const ripgrepModulePath = dirname(require.resolve('@vscode/ripgrep/package.json'));

    // Create node_modules/@vscode/ripgrep directory in bundle
    const ripgrepBundleDir = join(bundleDir, 'node_modules', '@vscode', 'ripgrep');
    if (!existsSync(ripgrepBundleDir)) {
      mkdirSync(ripgrepBundleDir, { recursive: true });
    }

    // Copy package.json and lib directory
    const filesToCopy = ['package.json', 'lib'];
    for (const item of filesToCopy) {
      const sourcePath = join(ripgrepModulePath, item);
      const targetPath = join(ripgrepBundleDir, item);

      if (existsSync(sourcePath)) {
        const fs = require('fs');
        const stat = fs.statSync(sourcePath);
        if (stat.isDirectory()) {
          if (!existsSync(targetPath)) {
            mkdirSync(targetPath, { recursive: true });
          }
          const files = fs.readdirSync(sourcePath);
          for (const file of files) {
            const subSourcePath = join(sourcePath, file);
            const subTargetPath = join(targetPath, file);
            copyFileSync(subSourcePath, subTargetPath);

            // 🔧 Ensure binary files have execute permissions (Unix systems)
            if (process.platform !== 'win32' && (file === 'rg' || file.endsWith('-rg'))) {
              try {
                fs.chmodSync(subTargetPath, 0o755);
                console.log(`  ✅ Set execute permissions: ${file}`);
              } catch (error) {
                console.warn(`  ⚠️  Failed to set execute permissions for ${file}: ${error.message}`);
              }
            }
          }
        } else {
          copyFileSync(sourcePath, targetPath);
        }
      }
    }

    // 🔧 移除 bundled ripgrep 的 postinstall：二进制已随包，安装时不应再去 GitHub 下载
    // (否则离线/受限网络的 Windows 上 npm install -g 会因下载失败而整体中止)
    try {
      const rgPkgPath = join(ripgrepBundleDir, 'package.json');
      if (existsSync(rgPkgPath)) {
        const rgPkg = JSON.parse(readFileSync(rgPkgPath, 'utf-8'));
        if (rgPkg.scripts && rgPkg.scripts.postinstall) {
          delete rgPkg.scripts.postinstall;
          writeFileSync(rgPkgPath, JSON.stringify(rgPkg, null, 2) + '\n');
          console.log('  ✅ Stripped ripgrep postinstall (binaries are pre-bundled)');
        }
      }
    } catch (error) {
      console.warn('  ⚠️  Failed to strip ripgrep postinstall:', error.message);
    }

    // Setup cross-platform binaries
    await setupCrossPlatformRipgrep(ripgrepBundleDir);

    const downloadAllPlatforms = process.env.DOWNLOAD_ALL_PLATFORMS === 'true';
    if (downloadAllPlatforms) {
      console.log('✅ Copied ripgrep module with cross-platform binaries');
    } else {
      console.log('✅ Copied ripgrep module for current platform');
    }
  } catch (error) {
    console.warn('⚠️  Warning: Failed to copy ripgrep module:', error.message);
  }
}

// Call the async function
await copyRipgrepModule();

// Note: Jimp (pure JavaScript) doesn't need cross-platform binary copying
console.log('✅ Using Jimp (pure JavaScript) - no native binaries needed');

// Setup cross-platform ripgrep binaries
async function setupCrossPlatformRipgrep(ripgrepBundleDir) {
  const require = createRequire(import.meta.url);
  const fs = require('fs');
  const { downloadRipgrepBinaries } = await import('./download_ripgrep_binaries.js');

  // Platform mapping from download script format to runtime detection
  const platformMappings = {
    'darwin-x64': 'rg',
    'darwin-arm64': 'rg',
    'win32-x64': 'rg.exe',
    'win32-ia32': 'rg.exe',
    'win32-arm64': 'rg.exe',
    'linux-x64': 'rg',
    'linux-arm64': 'rg',
    'linux-arm': 'rg',
  };

  const binDir = join(ripgrepBundleDir, 'bin');
  const tempBinariesDir = join(__dirname, '..', 'temp', 'ripgrep-binaries');

  // Create bin directory structure
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  try {
    // Check if cross-platform download is requested
    const downloadAllPlatforms = process.env.DOWNLOAD_ALL_PLATFORMS === 'true';

    if (downloadAllPlatforms) {
      // Download all platform binaries
      console.log('🚀 Cross-platform packaging: Downloading ripgrep binaries for all platforms...');
      await downloadRipgrepBinaries(tempBinariesDir);
    } else {
      console.log('💻 Development mode: Using current platform ripgrep binary only');
      console.log('   ℹ️  For cross-platform packaging production, use ⚡️npm run pack:prod⚡️');
      // Skip download, will use fallback below
      throw new Error('Skipping cross-platform download');
    }

    // Copy all downloaded binaries to bundle
    let copiedCount = 0;
    const missingPlatforms = [];
    const copyErrors = [];

    for (const [platformKey, binaryName] of Object.entries(platformMappings)) {
      const sourcePath = join(tempBinariesDir, `${platformKey}-${binaryName}`);
      const targetPath = join(binDir, `${platformKey}-${binaryName}`);

      if (existsSync(sourcePath)) {
        try {
          copyFileSync(sourcePath, targetPath);

          // 🔧 Ensure binary files have execute permissions (Unix systems)
          if (process.platform !== 'win32' && !binaryName.endsWith('.exe')) {
            try {
              const fs = require('fs');
              fs.chmodSync(targetPath, 0o755);
            } catch (error) {
              console.warn(`  ⚠️  Failed to set execute permissions for ${platformKey}: ${error.message}`);
            }
          }

          copiedCount++;
          console.log(`✅ Copied ${platformKey} binary`);
        } catch (error) {
          copyErrors.push({ platformKey, error: error.message });
          console.error(`❌ Failed to copy ${platformKey} binary: ${error.message}`);
        }
      } else {
        missingPlatforms.push(platformKey);
        console.error(`❌ Missing binary for ${platformKey}`);
      }
    }

    // Also copy current platform binaries with standard names for backward compatibility
    const currentPlatform = process.platform;
    const currentArch = process.arch;
    const currentKey = `${currentPlatform}-${currentArch === 'x64' ? 'x64' : currentArch}`;

    if (platformMappings[currentKey]) {
      const currentBinaryPath = join(tempBinariesDir, `${currentKey}-${platformMappings[currentKey]}`);
      const standardBinaryPath = join(binDir, platformMappings[currentKey]);

      if (existsSync(currentBinaryPath)) {
        copyFileSync(currentBinaryPath, standardBinaryPath);

        // 🔧 Ensure binary files have execute permissions (Unix systems)
        if (process.platform !== 'win32' && !platformMappings[currentKey].endsWith('.exe')) {
          try {
            const fs = require('fs');
            fs.chmodSync(standardBinaryPath, 0o755);
          } catch (error) {
            console.warn(`  ⚠️  Failed to set execute permissions: ${error.message}`);
          }
        }

        console.log(`✅ Copied current platform binary as ${platformMappings[currentKey]}`);
      }
    }

    // Validate all platforms were copied successfully
    const expectedPlatformCount = Object.keys(platformMappings).length;

    if (missingPlatforms.length > 0 || copyErrors.length > 0) {
      let errorMessage = '❌ Cross-platform ripgrep binary packaging failed:\n';
      if (missingPlatforms.length > 0) {
        errorMessage += `   Missing platforms: ${missingPlatforms.join(', ')}\n`;
      }
      if (copyErrors.length > 0) {
        errorMessage += `   Copy errors:\n${copyErrors.map(e => `     - ${e.platformKey}: ${e.error}`).join('\n')}\n`;
      }
      console.error(errorMessage);
      console.error('🛑 Build terminated: All platform binaries are required for production packaging.');
      process.exit(1);
    }

    if (copiedCount !== expectedPlatformCount) {
      console.error(`❌ Expected ${expectedPlatformCount} platform binaries, but only copied ${copiedCount}`);
      console.error('🛑 Build terminated: Incomplete cross-platform ripgrep binaries.');
      process.exit(1);
    }

    console.log(`📦 Successfully copied all ${copiedCount} cross-platform ripgrep binaries`);

  } catch (error) {
    const downloadAllPlatforms = process.env.DOWNLOAD_ALL_PLATFORMS === 'true';

    if (downloadAllPlatforms) {
      // In production mode, fail the build
      console.error('❌ Failed to download cross-platform binaries:', error.message);
      console.error('🛑 Build terminated: Cross-platform binaries are required for production packaging.');
      process.exit(1);
    }

    // Development mode: allow fallback to current platform only
    console.warn('⚠️  Development mode: Falling back to current platform binary only');
    console.warn('   ℹ️  For production builds, use: npm run pack:prod');

    // Fallback: copy current platform binary if available
    const currentBinary = join(__dirname, '../node_modules/@vscode/ripgrep/bin/rg');
    const currentWinBinary = join(__dirname, '../node_modules/@vscode/ripgrep/bin/rg.exe');

    let fallbackSuccess = false;

    if (existsSync(currentBinary)) {
      const targetPath = join(binDir, 'rg');
      copyFileSync(currentBinary, targetPath);

      // 🔧 Ensure binary files have execute permissions (Unix systems)
      if (process.platform !== 'win32') {
        try {
          const fs = require('fs');
          fs.chmodSync(targetPath, 0o755);
        } catch (error) {
          console.warn(`  ⚠️  Failed to set execute permissions: ${error.message}`);
        }
      }

      console.log('✅ Copied current platform rg binary');
      fallbackSuccess = true;
    }
    if (existsSync(currentWinBinary)) {
      copyFileSync(currentWinBinary, join(binDir, 'rg.exe'));
      console.log('✅ Copied current platform rg.exe binary');
      fallbackSuccess = true;
    }

    if (!fallbackSuccess) {
      console.error('❌ No ripgrep binary available for current platform');
      console.error('🛑 Build terminated: At least one ripgrep binary is required.');
      process.exit(1);
    }
  }

  // Create enhanced index.js that handles cross-platform detection
  const enhancedIndexContent = `'use strict';

const path = require('path');
const fs = require('fs');

function getRgPath() {
  const platform = process.platform;
  const arch = process.arch;

  // Normalize arch name
  const normalizedArch = arch === 'x64' ? 'x64' : arch;
  const platformKey = \`\${platform}-\${normalizedArch}\`;

  // Define binary names by platform
  const binaryName = platform === 'win32' ? 'rg.exe' : 'rg';

  // Try platform-specific binary first
  const platformSpecificPath = path.join(__dirname, \`../bin/\${platformKey}-\${binaryName}\`);
  if (fs.existsSync(platformSpecificPath)) {
    return platformSpecificPath;
  }

  // Fall back to standard binary name
  const standardPath = path.join(__dirname, \`../bin/\${binaryName}\`);
  if (fs.existsSync(standardPath)) {
    return standardPath;
  }

  // List available binaries for better error message
  const binDir = path.join(__dirname, '../bin');
  let availableBinaries = [];
  if (fs.existsSync(binDir)) {
    availableBinaries = fs.readdirSync(binDir);
  }

  throw new Error(\`Ripgrep binary not found for platform \${platform}-\${arch}.
Available binaries: \${availableBinaries.join(', ')}
Looking for: \${platformKey}-\${binaryName} or \${binaryName}
Please ensure the binary is available for your platform.\`);
}

module.exports.rgPath = getRgPath();
`;

  const libIndexPath = join(ripgrepBundleDir, 'lib', 'index.js');
  fs.writeFileSync(libIndexPath, enhancedIndexContent);

  console.log('✅ Enhanced ripgrep index.js for cross-platform support');

  // 🔧 移除 bundled ripgrep 的联网下载死代码：二进制已随包，download.js/postinstall.js
  // 不该随发布包一起出去（避免离线/受限网络下被触发去 GitHub 下载）。
  const deadDownloadFiles = ['download.js', 'postinstall.js'];
  for (const file of deadDownloadFiles) {
    const deadPath = join(ripgrepBundleDir, 'lib', file);
    if (existsSync(deadPath)) {
      try {
        rmSync(deadPath, { force: true });
        console.log(`  ✅ Removed bundled ripgrep lib/${file} (network download dead code)`);
      } catch (error) {
        console.warn(`  ⚠️  Failed to remove ripgrep lib/${file}: ${error.message}`);
      }
    }
  }
}



// Helper function to recursively copy directories
function copyDirectoryRecursive(src, dest) {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
  }

  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}



// Copy the binary permissions fix script to bundle
const fixPermissionsScript = join(__dirname, 'fix-binary-permissions.js');
const bundleFixScript = join(bundleDir, 'fix-binary-permissions.js');

if (existsSync(fixPermissionsScript)) {
  copyFileSync(fixPermissionsScript, bundleFixScript);
  console.log('✅ Copied fix-binary-permissions.js to bundle/');
} else {
  console.warn('⚠️  fix-binary-permissions.js not found, skipping copy');
}

// Copy authentication templates from packages/core to bundle
const templatesSourceDir = join(root, 'packages', 'core', 'src', 'auth', 'login', 'templates');
const templatesBundleDir = join(bundleDir, 'login', 'templates');

if (existsSync(templatesSourceDir)) {
  if (!existsSync(templatesBundleDir)) {
    mkdirSync(templatesBundleDir, { recursive: true });
  }

  const templateFiles = ['authSelectPage.html', 'deepv.ico', 'feishu.ico'];
  let copiedCount = 0;

  for (const file of templateFiles) {
    const sourcePath = join(templatesSourceDir, file);
    const targetPath = join(templatesBundleDir, file);

    if (existsSync(sourcePath)) {
      copyFileSync(sourcePath, targetPath);
      copiedCount++;
      console.log(`✅ Copied auth template: ${file}`);
    } else {
      console.warn(`⚠️  Auth template not found: ${file}`);
    }
  }

  console.log(`📋 Copied ${copiedCount} authentication template files`);
} else {
  console.warn('⚠️  Authentication templates source directory not found');
}

// Copy audio notification sounds from packages/cli to bundle
const soundsSourceDir = join(root, 'packages', 'cli', 'src', 'assets', 'sounds');
const soundsBundleDir = join(bundleDir, 'assets', 'sounds');

if (existsSync(soundsSourceDir)) {
  if (!existsSync(soundsBundleDir)) {
    mkdirSync(soundsBundleDir, { recursive: true });
  }

  const soundFiles = ['response-complete.wav', 'confirmation-required.wav', 'selection-made.wav'];
  let copiedSoundCount = 0;

  for (const file of soundFiles) {
    const sourcePath = join(soundsSourceDir, file);
    const targetPath = join(soundsBundleDir, file);

    if (existsSync(sourcePath)) {
      copyFileSync(sourcePath, targetPath);
      copiedSoundCount++;
      console.log(`🔊 Copied audio file: ${file}`);
    } else {
      console.warn(`⚠️  Audio file not found: ${file}`);
    }
  }

  // Also copy README.md if it exists (for production builds, skip README to reduce package size)
  const readmePath = join(soundsSourceDir, 'README.md');
  const isProduction = process.env.BUILD_ENV === 'production';

  if (existsSync(readmePath)) {
    if (!isProduction) {
      copyFileSync(readmePath, join(soundsBundleDir, 'README.md'));
      copiedSoundCount++;
      console.log(`📋 Copied audio README.md`);
    } else {
      console.log(`⏭️  Skipping README.md in assets/sounds/ (production build)`);
    }
  }

  console.log(`🔊 Copied ${copiedSoundCount} audio notification files`);
} else {
  console.warn('⚠️  Audio notification sounds source directory not found');
}

console.log('Assets copied to bundle/');
