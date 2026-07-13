# Otto Desktop 发布规范

> 每次发版都走这套流程，一步不跳。本文沉淀自 v1.4.2 → v1.5.1 的实战（含踩过的坑）。
> 适用：packages/desktop 的桌面端发版。执行环境：mac（arm64），Windows 包在 mac 上交叉打。

## 版本号规则

- 功能迭代/修复：patch +1（1.5.0 → 1.5.1）；品牌级/大功能：minor +1（1.4.x → 1.5.0）。
- **两处版本号必须同步改**：根 `package.json` + `packages/desktop/package.json`（app 自报版本、交付包名、更新清单三者才一致）。

## 发布九步

### 1. 更新说明（What's New 弹窗）

`packages/desktop/src/renderer/components/WhatsNewDialog.tsx` 的 `CHANGELOG` 数组**头部**加本版条目（version/date/items）。用户升级后首次启动自动弹出——只有列在这里的版本会弹。

### 2. 版本号 bump

```bash
sed -i '' 's/"version": "旧"/"version": "新"/' package.json packages/desktop/package.json
```

### 3. 全量验证（全绿才许继续）

```bash
cd packages/desktop
npm run typecheck        # 三份 tsconfig
npm test                 # 全套单测
npx eslint <本次改动的文件>
npm run build            # main + preload + renderer
```

UI 改动另需真实 Electron 截图验证（dev 第二实例 + CDP，方法见 memory otto-desktop-dev-verify）。

### 4. 分组 commit + push

按逻辑拆 commit（fix / feat / chore(release) 分开），最后一个是
`chore(release): vX.Y.Z——一句话摘要`。推 `origin internal`（**绝不推 upstream**）。

### 5. 双平台打包

```bash
npm run dist:dmg    # → release/Otto-X.Y.Z-arm64.dmg
npm run dist:win    # → release/Otto-Setup-X.Y.Z-win-x64.exe
node scripts/make-delivery-zip.mjs   # → 桌面 Otto-Desktop-X.Y.Z-mac-arm64.zip（内含一键修复脚本，mac 用户首选）
```

### 6. release notes + 更新清单

写 `notes-X.Y.Z.md`（用户视角，最后固定带 mac Gatekeeper 提示段），然后：

```bash
node scripts/make-latest-json.mjs X.Y.Z notes-X.Y.Z.md   # → release/latest.json（真算 sha256，无签名包的唯一完整性防线）
```

### 7. 发布到两个仓库

```bash
# 产物仓（app 内更新只认这里）：四资产 = dmg + exe + zip + latest.json
gh release create vX.Y.Z --repo Felix201209/otto-releases --title "Otto vX.Y.Z" \
  --notes-file notes-X.Y.Z.md release/Otto-X.Y.Z-arm64.dmg \
  release/Otto-Setup-X.Y.Z-win-x64.exe release/latest.json ~/Desktop/Otto-Desktop-X.Y.Z-mac-arm64.zip

# 代码仓 tag（只放说明，链接指向产物仓）
gh release create vX.Y.Z --repo Felix201209/otto --target internal --title "Otto vX.Y.Z" --notes "…"
```

### 8. 验证更新通道（发版的验收线，不跑=没发）

```bash
curl -sL https://github.com/Felix201209/otto-releases/releases/latest/download/latest.json | grep '"version"'
```

必须返回新版本号。app 启动 15s 后静默检查这个地址，有新版 → 左下角「设置与诊断」亮红点 → 软件更新面板应用内下载（自动校验 sha256）→ 打开安装包完成替换。

### 9. 本机与通知

- 刷 Felix 桌面：`ditto release/mac-arm64/Otto.app ~/Desktop/Otto.app && codesign --force --deep -s - ~/Desktop/Otto.app`，安装包同步换新、旧版进废纸篓。
- 通知团队（按 Felix 指示）：issue 17（PM 主战场）@ 相关人，附直下链接 + mac 首开三步。

## 踩过的坑（每条都真实发生过）

| 坑 | 症状 | 规避 |
|---|---|---|
| 发版前没 `git pull` | 队友已推的功能没进发布包（v1.4.3 漏了 krx 全部工作） | 第 0 步永远先 `git fetch && git log HEAD..origin/internal` |
| merge 冲突弄丢代码 | UI 在、IPC handler 没了，按钮全哑 | 拉完队友 merge 后 grep renderer 调用的 preload 方法是否存在 |
| Windows 上改坏 symlink | `packages/server/src/feishu/vendor/*.ts` 变坏链接，electron-builder stat 直接炸 | 拉代码后 `file packages/server/src/feishu/vendor/*.ts` 应显示指向 cli 包的有效链接 |
| 图标白底 | imagegen 源图不透明，dock 图标带白框 | 图标必须过透明画布+圆角遮罩加工（scratchpad make-icon.swift 那套：1024 画布/824 内容/22.37% 圆角） |
| release 上传断流 | EOF 后留下残缺 draft | `gh release view` 核对资产数；缺的逐个 `gh release upload` 重试，齐了 `--draft=false` 转正 |
| 替换已发布资产 | 更新器 sha256 校验失败 | 同版本 clobber 资产时必须重跑 make-latest-json 并一起 clobber latest.json |
| mac「已损坏」 | 未签名包被 Gatekeeper 拦，右键打开在新系统无效 | 推荐 zip 包（内含修复脚本）；根治=Apple Developer 签名+公证（$99/年，待团队决策） |
| 本机验证撞单实例锁 | 打包产物起不来（正式版在跑） | 产物级只验框架启动+asar 版本；UI 冒烟走 dev 第二实例（CDP） |
