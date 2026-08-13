/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { access, cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');

export const PORTABLE_LAUNCHER = `@echo off\r
setlocal\r
set "OTTO_USER_DIR=%~dp0otto-data"\r
set "OTTO_USER_DATA_DIR=%~dp0otto-data\\electron"\r
set "USERPROFILE=%~dp0otto-home"\r
set "OTTO_USB_LICENSE_PATH=%~dp0license\\license.bin"\r
set "OTTO_LICENSE_PUBLIC_KEY_FILE=%~dp0license\\public-key.pem"\r
if not exist "%OTTO_USER_DIR%" mkdir "%OTTO_USER_DIR%"\r
if not exist "%OTTO_USER_DATA_DIR%" mkdir "%OTTO_USER_DATA_DIR%"\r
if not exist "%USERPROFILE%" mkdir "%USERPROFILE%"\r
start "Otto" /D "%~dp0win-unpacked" "%~dp0win-unpacked\\Otto.exe"\r
endlocal\r
`;

const DEPLOYMENT_GUIDE = `# Otto U 盘便携版部署说明

## 部署

1. 在 Windows x64 构建机上运行 \`npm run dist:portable:win --workspace=packages/desktop\`。
2. 将 \`packages/desktop/release/Otto-portable\` 整个目录复制到 U 盘并可重命名为 \`Otto\`。
3. 许可证管理员将签名的 \`license.bin\` 放入 \`license\\license.bin\`（许可证目录使用 ASCII 名 \`license\`，避免批处理在非 UTF-8 代码页下读取中文目录名乱码）。

## 启动与数据

双击 \`启动Otto.bat\`。启动器会设置 \`OTTO_USER_DIR\` 为 \`otto-data\`、\`OTTO_USER_DATA_DIR\` 为 \`otto-data\\electron\`，并将 \`USERPROFILE\` 设为 \`otto-home\`。会话、记忆、技能、凭证和 Electron 数据因此跟随 U 盘，不应新写入当前 Windows 用户的 \`.otto-user\`。

首次启动后可检查 \`otto-data\` 下的会话/日志目录及 \`otto-data\\electron\`。移除 U 盘前请先退出 Otto，避免数据未写完。

## 许可证边界

便携版使用签名、机器指纹绑定和双份激活状态降低复制滥用风险。纯离线软件无法 100% 防止对激活前整盘镜像的复制；高风险部署应配置较短有效期、密钥吊销及可选联网激活登记。
`;

export async function assemblePortableUsb({ unpackedDir, outputDir }) {
  const executable = path.join(unpackedDir, 'Otto.exe');
  try {
    await access(executable);
  } catch {
    throw new Error(`缺少 Windows 绿色版 Otto.exe: ${executable}`);
  }
  await mkdir(outputDir, { recursive: true });
  await cp(unpackedDir, path.join(outputDir, 'win-unpacked'), {
    recursive: true,
    force: true,
  });
  await Promise.all([
    mkdir(path.join(outputDir, 'otto-data'), { recursive: true }),
    mkdir(path.join(outputDir, 'otto-home'), { recursive: true }),
    mkdir(path.join(outputDir, 'license'), { recursive: true }),
    writeFile(path.join(outputDir, '启动Otto.bat'), PORTABLE_LAUNCHER, 'utf8'),
    writeFile(path.join(outputDir, '部署说明.md'), DEPLOYMENT_GUIDE, 'utf8'),
  ]);
  return outputDir;
}

async function main() {
  const unpackedDir = path.resolve(
    process.env.OTTO_PORTABLE_UNPACKED_DIR || path.join(desktopDir, 'release', 'win-unpacked'),
  );
  const outputDir = path.resolve(
    process.env.OTTO_PORTABLE_OUTPUT_DIR || path.join(desktopDir, 'release', 'Otto-portable'),
  );
  await assemblePortableUsb({ unpackedDir, outputDir });
  console.log(`Otto U 盘便携版已生成: ${outputDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
