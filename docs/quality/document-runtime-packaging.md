# Otto 文档运行时组件契约

默认桌面安装包保持轻量，不直接包含 Python、Node.js 和 LibreOffice。企业发行版或
独立文档运行时组件从以下目录读取各平台运行时：

`packages/desktop/vendor/runtime/<platform>-<arch>/`

需要生成带完整文档能力的企业发行物时，必须具备以下布局；任一缺失，运行时组件
校验必须失败，不允许用占位文件冒充完整能力。

- macOS/Linux Python：`python/bin/python3`
- Windows Python：`python/python.exe`
- Python 模块：`python/site-packages/docx`、`jinja2`、`markdown`
- macOS/Linux Node.js：`node/bin/node`
- Windows Node.js：`node/node.exe`
- macOS LibreOffice：`libreoffice/LibreOffice.app/Contents/MacOS/soffice`
- Windows/Linux LibreOffice：`libreoffice/program/soffice[.exe]`

这些大型二进制不以占位文件冒充。构建环境必须先按平台提供经过审核的真实运行时；
`scripts/verify-document-runtime.mjs` 负责独立组件的静态完整性闸门。若发行渠道选择把
组件随安装包交付，只允许复制当前 `${platform}-${arch}` 目录，不得把 macOS 双架构和
Windows 多套大型运行时同时塞进一个安装包。

运行时解析顺序固定为：

1. `process.resourcesPath/runtime/<platform>-<arch>`（或测试/调试用
   `OTTO_RESOURCES_PATH`）；
2. 开发版/CLI 的系统 `PATH` 作为兼容回退。

内置 Python 会设置自己的 `PYTHONPATH` 和 `PYTHONNOUSERSITE=1`，避免依赖用户机器
临时安装的包而出现“这台电脑能用、另一台不能用”的差异。
