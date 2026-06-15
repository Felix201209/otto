#!/usr/bin/env node

/**
 * npm 发布前检查脚本
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

console.log('🔍 检查 npm 发布准备状态...\n');

let hasError = false;

// 1. 检查 package.json
console.log('📦 检查 package.json...');
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

// 检查 private 字段
if (pkg.private === true || pkg.private === 'true') {
  console.error('❌ package.json 中 "private": true，需要改为 false 或删除');
  hasError = true;
} else {
  console.log('✅ private 字段正确');
}

// 检查 name
if (!pkg.name || pkg.name.includes('gemini')) {
  console.error('❌ package name 需要修改为你自己的包名（当前：' + pkg.name + '）');
  hasError = true;
} else {
  console.log('✅ package name: ' + pkg.name);
}

// 检查 version
console.log('✅ version: ' + pkg.version);

// 检查 repository
if (pkg.repository && pkg.repository.url && pkg.repository.url.includes('google-gemini')) {
  console.warn('⚠️  repository URL 还是 Google 的，建议修改为你的仓库地址');
}

// 检查 bin
if (!pkg.bin || Object.keys(pkg.bin).length === 0) {
  console.error('❌ bin 字段缺失或不正确');
  hasError = true;
} else {
  const firstBin = Object.keys(pkg.bin)[0];
  console.log('✅ bin 字段正确: ' + firstBin + ' -> ' + pkg.bin[firstBin]);
}

// 检查 files
if (!pkg.files || (!pkg.files.includes('bundle/') && !pkg.files.includes('bundle/dvcode.js'))) {
  console.error('❌ files 字段需要包含 bundle/ 或其指定文件');
  hasError = true;
} else {
  console.log('✅ files 字段正确');
}

// 2. 检查 bundle 目录
console.log('\n📂 检查 bundle 目录...');
const bundleDir = path.join(rootDir, 'bundle');
if (!fs.existsSync(bundleDir)) {
  console.error('❌ bundle/ 目录不存在，请先运行 npm run bundle');
  hasError = true;
} else {
  const bundleFiles = fs.readdirSync(bundleDir);
  if (bundleFiles.length === 0) {
    console.error('❌ bundle/ 目录是空的，请先运行 npm run bundle');
    hasError = true;
  } else {
    console.log('✅ bundle/ 目录存在，包含 ' + bundleFiles.length + ' 个文件');

    // 检查 bin 字段中指定的实际可执行文件是否存在
    const binKeys = Object.keys(pkg.bin || {});
    for (const binKey of binKeys) {
      const binFileRelPath = pkg.bin[binKey];
      const binFilePath = path.join(rootDir, binFileRelPath);
      if (!fs.existsSync(binFilePath)) {
        console.error(`❌ ${binFileRelPath} 不存在`);
        hasError = true;
      } else {
        console.log(`✅ ${binFileRelPath} 存在`);
      }
    }
  }
}

// 3. 检查 README.md
console.log('\n📄 检查 README.md...');
const readmePath = path.join(rootDir, 'README.md');
if (!fs.existsSync(readmePath)) {
  console.warn('⚠️  README.md 不存在，建议创建');
} else {
  console.log('✅ README.md 存在');
}

// 4. 检查 LICENSE
console.log('\n📜 检查 LICENSE...');
const licensePath = path.join(rootDir, 'LICENSE');
if (!fs.existsSync(licensePath)) {
  console.warn('⚠️  LICENSE 文件不存在，建议添加');
} else {
  console.log('✅ LICENSE 存在');
}

// 5. 检查 .npmignore
console.log('\n🚫 检查 .npmignore...');
const npmignorePath = path.join(rootDir, '.npmignore');
if (!fs.existsSync(npmignorePath)) {
  console.warn('⚠️  .npmignore 不存在，会使用 .gitignore（可能不理想）');
} else {
  console.log('✅ .npmignore 存在');
}

// 总结
console.log('\n' + '='.repeat(50));
if (hasError) {
  console.error('\n❌ 发现问题，请修复后再发布！');
  process.exit(1);
} else {
  console.log('\n✅ 所有检查通过！可以发布了！');
  console.log('\n下一步：');
  console.log('1. npm login (如果还没登录)');
  console.log('2. npm publish (首次发布)');
  console.log('   或 npm publish --access public (如果包名带有 @scope)');
  console.log('\n测试发布（不会真正发布）：');
  console.log('   npm publish --dry-run');
}
