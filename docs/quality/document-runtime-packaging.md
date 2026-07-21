# Otto 桌面文档运行时打包契约

发布打包从以下目录读取各平台运行时：

`packages/desktop/vendor/runtime/<platform>-<arch>/`

必须具备以下布局；任一缺失，`dist` 和带 `--build` 的交付脚本都会在 Electron
打包前失败，不允许发布缺功能的安装包。

- macOS/Linux Python：`python/bin/python3`
- Windows Python：`python/python.exe`
- Python 模块：`python/site-packages/docx`、`jinja2`、`markdown`
- macOS/Linux Node.js：`node/bin/node`
- Windows Node.js：`node/node.exe`
- macOS LibreOffice：`libreoffice/LibreOffice.app/Contents/MacOS/soffice`
- Windows/Linux LibreOffice：`libreoffice/program/soffice[.exe]`

这些大型二进制不以占位文件冒充，也不由运行时代码临时下载。构建环境必须先按平台
提供经过审核的真实运行时；`scripts/verify-document-runtime.mjs` 负责静态完整性闸门。
Electron Builder 只把当前 `${platform}-${arch}` 目录复制到安装包对应的
`resources/runtime/<platform>-<arch>`，不会把 macOS 双架构和 Windows 三套大型运行时
同时塞进一个安装包。

运行时解析顺序固定为：

1. `process.resourcesPath/runtime/<platform>-<arch>`（或测试/调试用
   `OTTO_RESOURCES_PATH`）；
2. 开发版/CLI 的系统 `PATH` 作为兼容回退。

内置 Python 会设置自己的 `PYTHONPATH` 和 `PYTHONNOUSERSITE=1`，避免依赖用户机器
临时安装的包而出现“这台电脑能用、另一台不能用”的差异。
