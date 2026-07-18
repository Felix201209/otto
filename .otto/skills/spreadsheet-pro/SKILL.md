---
name: spreadsheet-pro
version: 4
description: 视觉母题驱动 Excel 引擎。AI 创造母题 → 仪表盘、数据表、摘要——3色驱动全表视觉。
---

# 📊 Otto Spreadsheet-Pro v4

> **AI 创造视觉母题，引擎渲染。**

## 🔧 安装
```bash
pip install openpyxl
```

## 🎨 视觉母题

```yaml
theme: 深空数据
base: "0A1628"
accent: "2D7DD2"
surface: "F5F7FA"
```

## 🚀 生成
`##` 分割工作表，`|表格|` 写数据。

```bash
python scripts/create_xlsx.py input.md output.xlsx
```

## 🔧 工具
```bash
python scripts/analyze.py input.xlsx
python scripts/pivot.py input.xlsx out.xlsx --rows "区域" --vals "销售额"
python scripts/clean.py input.xlsx out.xlsx
```
