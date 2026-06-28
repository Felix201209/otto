/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Otto Desktop 交付包聚合脚本（Issue #8）。
 *
 * 产出一个 `Otto-Desktop-<version>-mac-arm64.zip`，内含：
 *   1. `Otto.app`        —— electron-builder 产出的（未签名）mac 应用
 *   2. `otto-cli-*.tgz`  —— 兜底 CLI/TUI 离线安装包（即使 .app 滑窗也不为零）
 *   3. `README.md`       —— 安装 + 「未签名右键打开」说明
 *
 * 设计原则（hackathon 纪律）：
 *   - 不静默造假：找不到 .app / tgz 就 fail-loud 并打印怎么补。
 *   - 不替别的包跑构建：本脚本只【聚合现成产物】。需要时用 `--build` 触发
 *     `npm run dist`（仅 desktop 自己的 electron-builder），但默认不替你编译。
 *   - 幂等：每次清空并重建临时 staging 目录，zip 落到固定输出路径。
 *
 * 用法：
 *   node scripts/make-delivery-zip.mjs                 # 聚合现成 .app + tgz
 *   node scripts/make-delivery-zip.mjs --build         # 先 npm run dist 再聚合
 *   OTTO_CLI_TGZ=/path/to.tgz node scripts/...         # 指定 CLI tgz
 *   OTTO_DELIVERY_OUT=/path/out.zip node scripts/...   # 指定输出 zip 路径
 *
 * 真跑由人验证：脚本就绪，但出 .app 需在真机带 GUI 的环境跑 electron-builder。
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(DESKTOP_ROOT, '..', '..');

// ── 小工具 ───────────────────────────────────────────────────────────────
const log = (msg) => console.log(`[delivery] ${msg}`);
const warn = (msg) => console.warn(`[delivery] ⚠ ${msg}`);

function die(msg, hint) {
  console.error(`\n[delivery] ✗ ${msg}`);
  if (hint) console.error(`[delivery]   → ${hint}`);
  process.exit(1);
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** 递归用系统 cp -R 复制目录（保留 .app 的符号链接/权限/扩展属性）。 */
function copyDir(src, dest) {
  // -R 保留目录结构；-p 保留权限；mac 上 .app 含符号链接，cp -R 正确处理。
  execFileSync('cp', ['-R', src, dest], { stdio: 'inherit' });
}

// ── 1. 读版本号 ────────────────────────────────────────────────────────────
const pkg = readJson(join(DESKTOP_ROOT, 'package.json'));
// 交付版本对齐仓库根版本（产品版本），desktop 子包的 0.1.0 仅内部用。
let productVersion = pkg.version;
try {
  const rootPkg = readJson(join(REPO_ROOT, 'package.json'));
  if (rootPkg.version) productVersion = rootPkg.version;
} catch {
  warn('读不到根 package.json 版本，回退用 desktop 子包版本');
}

const ARCH = 'mac-arm64';
const DELIVERY_NAME = `Otto-Desktop-${productVersion}-${ARCH}`;

// ── 2. 可选：先触发 electron-builder ──────────────────────────────────────
const wantBuild = process.argv.includes('--build');
if (wantBuild) {
  log('--build：先跑 npm run dist（electron-builder 出 .app）…');
  try {
    execFileSync('npm', ['run', 'dist'], {
      cwd: DESKTOP_ROOT,
      stdio: 'inherit',
    });
  } catch {
    die(
      'electron-builder 构建失败',
      '在带 GUI 的真机上跑，或先手动 `npm run dist --workspace=packages/desktop` 排错',
    );
  }
}

// ── 3. 定位 Otto.app ───────────────────────────────────────────────────────
// electron-builder `dir` target → release/mac-arm64/Otto.app（arch 后缀视配置）。
function findApp() {
  const releaseDir = join(DESKTOP_ROOT, 'release');
  if (!existsSync(releaseDir)) return undefined;
  // 候选目录：mac-arm64 / mac / mac-universal …
  const candidates = readdirSync(releaseDir)
    .filter((d) => d.startsWith('mac'))
    .map((d) => join(releaseDir, d, 'Otto.app'))
    .filter((p) => existsSync(p));
  return candidates[0];
}

const appPath = findApp();
if (!appPath) {
  die(
    '找不到 Otto.app（release/mac*/Otto.app）',
    '先出 .app：`npm run dist --workspace=packages/desktop`（需真机 GUI 环境），或加 --build 重跑本脚本',
  );
}
log(`找到 app: ${appPath}`);

// ── 4. 定位 CLI 兜底 tgz ───────────────────────────────────────────────────
// 优先级：环境变量 OTTO_CLI_TGZ > ~/Desktop/otto-cli-*.tgz（取最新） > 仓库内
function findCliTgz() {
  const envPath = process.env.OTTO_CLI_TGZ;
  if (envPath) {
    if (!existsSync(envPath)) die(`OTTO_CLI_TGZ 指向的文件不存在: ${envPath}`);
    return envPath;
  }
  // 桌面优先（地基交付物约定落在 ~/Desktop）
  const searchDirs = [join(homedir(), 'Desktop'), REPO_ROOT];
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    const hits = readdirSync(dir)
      .filter((f) => /^otto-cli-.*\.tgz$/.test(f))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (hits.length > 0) return hits[0];
  }
  return undefined;
}

const cliTgz = findCliTgz();
if (!cliTgz) {
  // 不致命：但要 fail-loud 警告，交付包将缺兜底。默认要求带上，缺了就停。
  die(
    '找不到 CLI 兜底 tgz（otto-cli-*.tgz）',
    '生成一个：参考根 `npm run pack:prod`，或把已有 tgz 路径塞进 OTTO_CLI_TGZ 环境变量再跑',
  );
}
log(`找到 CLI tgz: ${cliTgz}`);

// ── 5. staging 目录 ────────────────────────────────────────────────────────
const stageRoot = join(DESKTOP_ROOT, 'release', '_delivery');
const stageDir = join(stageRoot, DELIVERY_NAME);
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

log('复制 Otto.app …');
copyDir(appPath, join(stageDir, 'Otto.app'));

log('复制 CLI 兜底 tgz …');
copyFileSync(cliTgz, join(stageDir, basename(cliTgz)));

log('写 README …');
writeFileSync(join(stageDir, 'README.md'), buildReadme(productVersion, basename(cliTgz)), 'utf8');

// ── 6. 打 zip ──────────────────────────────────────────────────────────────
const outZip =
  process.env.OTTO_DELIVERY_OUT ?? join(homedir(), 'Desktop', `${DELIVERY_NAME}.zip`);
rmSync(outZip, { force: true });

log(`打 zip → ${outZip}`);
// 用 ditto 而非 zip：ditto 正确保留 .app 的资源分支/符号链接/可执行位，
// 解压后 .app 仍可双击（zip 命令会丢失部分 mac 元数据，导致 .app 损坏）。
try {
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stageDir, outZip], {
    stdio: 'inherit',
  });
} catch {
  die('ditto 打包失败', '确认在 macOS 上运行（ditto 是 mac 自带工具）');
}

const sizeMB = (statSync(outZip).size / (1024 * 1024)).toFixed(1);
log(`✓ 交付包就绪: ${outZip} (${sizeMB} MB)`);
log('  内含: Otto.app + ' + basename(cliTgz) + ' + README.md');
log('  下一步: 拷到另一台 Mac 解压 → 右键 Otto.app → 打开（首次绕过 Gatekeeper）');

// ── README 模板 ────────────────────────────────────────────────────────────
function buildReadme(version, cliTgzName) {
  return `# Otto Desktop — 交付包 (v${version}, mac arm64)

> 本包未做 Apple 公证/签名（hackathon 交付）。首次打开需「右键 → 打开」绕过 Gatekeeper，这是预期行为，不是病毒。

## 包内容

| 文件 | 说明 |
|---|---|
| \`Otto.app\` | Otto 桌面端（Electron）。图形界面：聊天 / 飞书同步 / setup 配 key |
| \`${cliTgzName}\` | 兜底：Otto CLI / TUI 终端版离线安装包（.app 打不开也能用） |
| \`README.md\` | 本文件 |

---

## 一、装 Otto.app（图形版，推荐）

1. 把 \`Otto.app\` 拖进「应用程序」(/Applications)，或留在解压目录也行。
2. **首次打开必须右键**（直接双击会被 Gatekeeper 拦，因为未签名）：
   - 在 \`Otto.app\` 上 **右键（或 Control + 单击）→ 打开**。
   - 弹窗里再点 **「打开」**。
   - 之后就能正常双击启动了（只需绕过这一次）。
3. 若提示「Otto 已损坏，无法打开」（macOS 对未签名 app 的隔离属性所致），在终端跑一次：
   \`\`\`bash
   xattr -dr com.apple.quarantine /Applications/Otto.app
   \`\`\`
   （把路径换成你实际放 \`Otto.app\` 的位置；这步移除下载隔离标记，然后再右键打开。）

### 首次配置
打开后按图形引导填 **provider / API key / model**（BYO-key，自带 key）。配完即可对话。
配置与 CLI 版共享（落在 \`~/.otto-user/\`），两端互通。

---

## 二、装 CLI / TUI（兜底，终端版）

如果 \`.app\` 暂时打不开，用离线 tgz 装终端版，功能不缺：

\`\`\`bash
npm install -g ./${cliTgzName}
otto            # 启动 TUI
otto setup      # 配 provider / key / model
\`\`\`

需要 Node.js >= 20。

---

## 三、为什么要「右键打开」？

macOS Gatekeeper 默认拦截未经 Apple 签名/公证的应用。Otto 这个交付包**故意不做公证**（公证要 Apple 开发者账号 + 审核时间，hackathon 不烧这个时间）。「右键 → 打开」是 Apple 官方提供的、给可信来源 app 放行的标准操作，只需做一次。

---

## 故障排查

- **双击没反应 / 闪退**：先用上面的 \`xattr -dr com.apple.quarantine\` 去隔离，再右键打开。
- **「无法验证开发者」**：右键 → 打开（不要双击）。
- **要看日志**：终端里 \`/Applications/Otto.app/Contents/MacOS/Otto\` 直接跑，能看到 stdout/stderr。
- **图形版连不上后端**：app 会内嵌拉起本地 server；若界面显示「未连接」，重启 app；仍不行就先用 CLI 兜底版。
`;
}
