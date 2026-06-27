/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, createReadStream } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';
import ora from 'ora';
import chalk from 'chalk';
import cliProgress from 'cli-progress';

/**
 * 🚀 New Package Script - Simplified Reliable Version
 */

function getFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

function run(command, options = {}) {
  console.log(chalk.cyan(`\n🔧 Executing: ${command}`));
  try {
    return execSync(command, { stdio: 'inherit', ...options });
  } catch (error) {
    console.error(chalk.red(`❌ Command failed: ${command}`));
    console.error(chalk.red(error.message));
    process.exit(1);
  }
}

function getCurrentVersion() {
  const rootPackageJsonPath = resolve(process.cwd(), 'package.json');
  const packageJson = JSON.parse(readFileSync(rootPackageJsonPath, 'utf-8'));
  return packageJson.version;
}

function incrementPatchVersion(version) {
  const parts = version.split('.');
  const patch = parseInt(parts[2]) + 1;
  return `${parts[0]}.${parts[1]}.${patch}`;
}

function updateRootPackageVersion(newVersion) {
  const rootPackageJsonPath = resolve(process.cwd(), 'package.json');
  const packageJson = JSON.parse(readFileSync(rootPackageJsonPath, 'utf-8'));
  packageJson.version = newVersion;
  writeFileSync(rootPackageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
}

function updateAllPackageVersions(newVersion) {
  const packagesToUpdate = [
    'packages/cli/package.json',
    'packages/cli/src/package.json',
    'packages/core/package.json',
    'packages/vscode-ide-companion/package.json'
  ];

  console.log(chalk.blue('   📦 Syncing version numbers across all sub-projects:'));

  packagesToUpdate.forEach(packagePath => {
    const fullPath = resolve(process.cwd(), packagePath);
    try {
      const packageJson = JSON.parse(readFileSync(fullPath, 'utf-8'));
      const oldVersion = packageJson.version;
      packageJson.version = newVersion;
      writeFileSync(fullPath, JSON.stringify(packageJson, null, 2) + '\n');
      console.log(chalk.green(`   ✅ ${packagePath}: ${oldVersion} → ${newVersion}`));
    } catch (error) {
      console.log(chalk.yellow(`   ⚠️  Skipped ${packagePath} (file not found or unreadable)`));
    }
  });
}

async function main() {
  console.log(chalk.bold.magenta('\n🚀 Otto CLI Packaging Process'));
  console.log(chalk.gray('═══════════════════════════════════════════════════════════════'));
  console.log(chalk.blue('📋 Process Overview:'));
  console.log(chalk.white('   1. Check current version'));
  console.log(chalk.white('   2. Auto-increment version number (patch +1)'));
  console.log(chalk.white('   3. Smart build and package (npm pack auto-executes prepare hook)'));
  console.log(chalk.white('   4. Optional installation and testing'));
  console.log(chalk.gray('═══════════════════════════════════════════════════════════════\n'));

  // Check if installation is needed (supports multiple methods)
  const args = process.argv.slice(2);
  const npmConfigArgv = process.env.npm_config_argv ? JSON.parse(process.env.npm_config_argv) : null;
  const allArgs = [...args, ...(npmConfigArgv?.original || [])];

  const shouldInstall = allArgs.includes('--install');
  // Check for no-version-bump flag OR production build environment
  const noVersionBump = allArgs.includes('--no-version-bump') || process.env.BUILD_ENV === 'production';

  if (shouldInstall) {
    console.log(chalk.green('🔧 Mode: Full workflow (build + install + test)'));
  } else {
    console.log(chalk.blue('🔧 Mode: Build only (no installation)'));
  }
  if (noVersionBump) {
    const reason = process.env.BUILD_ENV === 'production' ? '(production build)' : '(--no-version-bump flag)';
    console.log(chalk.yellow(`⚠️  Version bump: Disabled ${reason}`));
  }
  console.log('');

  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
  const pkgName = pkg.name;

  try {
    // Create progress bar for the overall process
    const progressBar = new cliProgress.SingleBar({
      format: chalk.cyan('Progress') + ' |' + chalk.cyan('{bar}') + '| {percentage}% | {value}/{total} Steps | {step}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true
    });

    progressBar.start(shouldInstall ? 4 : 3, 0, { step: 'Starting...' });

    progressBar.update(0, { step: '📋 Step 1: Checking current version' });
    const currentVersion = getCurrentVersion();
    console.log(chalk.blue(`\n   Current version: ${currentVersion}`));
    progressBar.increment({ step: 'Version check complete' });

    let newVersion;
    if (noVersionBump) {
      progressBar.update(1, { step: '📌 Step 2: Using current version (no bump)' });
      console.log(chalk.yellow('\n   Description: Skipping version increment (--no-version-bump flag set)'));
      newVersion = currentVersion;
      console.log(chalk.blue(`   📦 Will generate file: ${pkgName}-${newVersion}.tgz`));
      console.log(chalk.cyan('   ℹ️  Version remains: ${newVersion}'));
      progressBar.increment({ step: 'Version check complete (no bump)' });
    } else {
      progressBar.update(1, { step: '📈 Step 2: Auto-incrementing version number' });
      console.log(chalk.blue('\n   Description: Updating root directory and all sub-project version numbers (patch +1)'));
      newVersion = incrementPatchVersion(currentVersion);
      updateRootPackageVersion(newVersion);
      console.log(chalk.green(`   ✅ Root directory version updated: ${currentVersion} → ${newVersion}`));
      updateAllPackageVersions(newVersion);
      console.log(chalk.blue(`   📦 Will generate file: ${pkgName}-${newVersion}.tgz`));
      progressBar.increment({ step: 'Version increment complete' });
    }

    progressBar.update(2, { step: '🔨 Step 3: Building and packaging' });
    console.log(chalk.blue('\n   Description: npm pack will auto-execute all build steps via prepare hook'));
    console.log(chalk.blue('   📋 prepare hook executes: npm run bundle (includes build and package)'));

    const tgzFileName = `${pkgName}-${newVersion}.tgz`;

    // Prepare for packaging: validate README exists
    const prepareSpinner = ora({
      text: chalk.cyan('📝 Checking README for packaging...'),
      spinner: 'dots'
    }).start();
    try {
      run('node scripts/prepare-publish.js', { stdio: 'pipe' });
      prepareSpinner.succeed(chalk.green('✅ README check passed'));
    } catch (error) {
      prepareSpinner.fail(chalk.red('💥 README check failed!'));
      throw error;
    }

    const packingSpinner = ora({
      text: chalk.cyan('📦 Executing: npm pack (auto-build + package)'),
      spinner: 'bouncingBall'
    }).start();

    try {
      run('npm pack', { env: { ...process.env, DEEPV_SKIP_BUILD: '1' } });
      packingSpinner.succeed(chalk.green(`✨ Build and packaging completed: ${tgzFileName}`));
      progressBar.increment({ step: 'Build and package complete' });
    } catch (error) {
      packingSpinner.fail(chalk.red('💥 Build and packaging failed!'));
      throw error;
    }

    // Post-packaging cleanup
    const restoreSpinner = ora({
      text: chalk.cyan('🔄 Post-packaging cleanup...'),
      spinner: 'dots'
    }).start();
    try {
      run('node scripts/restore-after-publish.js', { stdio: 'pipe' });
      restoreSpinner.succeed(chalk.green('✅ Cleanup completed'));
    } catch (error) {
      restoreSpinner.warn(chalk.yellow('⚠️  Cleanup warning (non-critical)'));
    }

    // Optional: Global installation
    if (shouldInstall) {
      progressBar.update(3, { step: '🌐 Step 4: Global installation and testing' });
      console.log(chalk.blue('\n   Description: Uninstall old version → Install new version → Reset auth → Test startup'));

      // Uninstall old version first (ignore errors)
      const uninstallSpinner = ora('🗑️ Uninstalling old version...').start();
      try {
        run('npm uninstall -g otto-ai', { stdio: 'pipe' });
        uninstallSpinner.succeed(chalk.green('✅ Old version uninstalled'));
      } catch (error) {
        uninstallSpinner.info(chalk.cyan('ℹ️ No previously installed version found'));
      }

      // Install new version
      const installSpinner = ora('📦 Installing new version...').start();
      try {
        run(`npm install -g ./${tgzFileName}`);
        installSpinner.succeed(chalk.green('✅ Global installation completed!'));
      } catch (error) {
        installSpinner.fail(chalk.red('💥 Installation failed!'));
        throw error;
      }

      // Reset authentication (choose script based on OS)
      const authSpinner = ora('🔄 Resetting authentication config...').start();
      try {
        const isWindows = process.platform === 'win32';
        const resetScript = isWindows ? './reset_auth_win.ps1' : './reset_auth.sh';
        const command = isWindows ? `powershell -ExecutionPolicy Bypass -File ${resetScript}` : resetScript;

        run(command);
        authSpinner.succeed(chalk.green('✅ Authentication reset'));
      } catch (error) {
        authSpinner.info(chalk.cyan('ℹ️ Skipped auth reset (script not found or execution failed)'));
      }

      // Test otto startup
      const testSpinner = ora('🚀 Testing new version startup...').start();
      try {
        run('otto --version');
        testSpinner.succeed(chalk.green('✅ otto startup successful!'));
      } catch (error) {
        testSpinner.warn(chalk.yellow('⚠️ otto startup failed, please test manually'));
      }

      progressBar.increment({ step: 'Installation and testing complete' });
    }

    progressBar.stop();

    // Calculate Hash
    const fileHash = await getFileHash(resolve(process.cwd(), tgzFileName));

    // Final Professional Summary
    console.log(`\n${chalk.bold.blue('----------------------- Package Summary -----------------------')}`);
    console.log(`${chalk.green('✅')} ${chalk.cyan('Artifact'.padEnd(15))} ${chalk.white(`[${tgzFileName}]`)}`);
    console.log(`${chalk.green('✅')} ${chalk.cyan('Version'.padEnd(15))} ${chalk.white(`[${newVersion}]`)}`);
    console.log(`${chalk.green('✅')} ${chalk.cyan('SHA-256'.padEnd(15))} ${chalk.dim(fileHash)}`);
    console.log(`${chalk.green('✅')} ${chalk.cyan('Status'.padEnd(15))} ${chalk.green('[SUCCESS]')}`);

    if (shouldInstall) {
      console.log(`${chalk.green('✅')} ${chalk.cyan('Integration'.padEnd(15))} ${chalk.green('[Installed & Verified]')}`);
    }

    console.log(`${chalk.bold.blue('---------------------------------------------------------------')}`);

    if (!shouldInstall) {
      console.log(`\n${chalk.yellow('💡 Hint:')} Run ${chalk.cyan.bold(`npm install -g ./${tgzFileName}`)} to install globally.\n`);
    } else {
      console.log(`\n${chalk.green('🎉')} ${chalk.bold('otto')} is now updated and ready for use!\n`);
    }

  } catch (error) {
    console.error(chalk.red('\n❌ Packaging workflow failed!'));
    console.error(chalk.gray('═══════════════════════════════════════════════════════════════'));
    console.error(chalk.red(`Error message: ${error.message}`));
    console.error(chalk.gray('═══════════════════════════════════════════════════════════════'));
    process.exit(1);
  }
}

// Display help information
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(chalk.cyan(`
🚀 New Package Script Usage Guide (Simplified Reliable Version)

Usage:
  npm run newpack [options]

Options:
  --install          Auto global install after packaging
  --no-version-bump  Skip version increment (use current version)
  --help, -h         Show help information

Features:
  ✅ Auto-increment patch version (modify root package.json only)
  ✅ Standard build workflow (build → bundle → pack)
  ✅ Generate tgz file (otto-ai-{new-version}.tgz)
  ✅ Optional global install + auth reset + startup test

Examples:
  npm run newpack                        # Package only, no install
  npm run newpack:install                # Package and global install (recommended)
  npm run newpack --install              # Package and global install (compatible)
  npm run newpack -- --no-version-bump   # Package without version increment (for CI)

Build Workflow:
  1. Version auto-increment (patch +1) - can be skipped with --no-version-bump
  2. npm pack (auto-executes all build steps via prepare hook)
     - prepare hook auto-executes: npm run bundle
     - bundle includes: generate + build + esbuild + resource copying

Notes:
  - Version number auto-increments by default (unless --no-version-bump is used)
  - npm pack auto-executes build via prepare hook, avoiding duplicate builds
  - Using --install will auto-uninstall old version and install new one
  - Use --no-version-bump for CI/CD environments where version is managed externally
  - Generated tgz file can be used for manual installation or publishing
`));
  process.exit(0);
}

main();
