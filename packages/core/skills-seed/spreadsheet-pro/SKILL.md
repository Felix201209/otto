---
name: spreadsheet-pro
version: 3
description: AI 驱动 Excel 表格引擎——生成、分析、透视、清洗。AI 通过 YAML 设计令牌创造视觉语言，引擎渲染专业 .xlsx。
---

# 📊 Otto Spreadsheet-Pro v3 — AI 驱动 Excel 引擎

> **不做模板。AI 创造表格风格，引擎执行。**

---

## 🔧 首次使用

```bash
pip install openpyxl
```

---

## 🎨 设计令牌系统

```yaml
# 色彩
primary: "1B3A5C"       # 主色（标签页/标题栏）
accent: "2E75B6"        # 强调色
body_color: "333333"    # 数据文字
header_bg: "1B3A5C"     # 表头背景
header_text: "FFFFFF"   # 表头文字
stripe_bg: "F0F4F8"     # 交替行背景
border_color: "CCCCCC"  # 边框色
title_bg: "1B3A5C"      # 标题栏背景
title_text: "FFFFFF"    # 标题栏文字
negative_color: "DC3545" # 负数/警告色
positive_color: "28A745" # 正数/成功色

# 字体
heading_font: "Microsoft YaHei"
body_font: "Microsoft YaHei"
title_size: "14"
header_size: "11"
body_size: "10.5"

# 设计身份
design_name: "深空数据"
design_mood: "冷静、专业"
```

---

## 🚀 生成 Excel

### 格式

Markdown 的 `##` 标题分割为独立工作表（sheet），`|表格|` 写入数据行。段落文字作为说明。

```markdown
---
title: Q2 销售分析报告
author: 市场部
design_name: "深空数据"
primary: "0A2647"
accent: "144272"
stripe_bg: "EBF5FB"
---

## 销售总览

本季度整体表现良好，同比增长 15%。

| 区域 | Q2 销售额 | Q1 销售额 | 环比增长 |
|------|----------|----------|---------|
| 华北 | 1,250 | 1,100 | 13.6% |
| 华东 | 2,180 | 1,980 | 10.1% |
| 华南 | 980 | 820 | 19.5% |

## 产品分类

| 产品线 | 销售额 | 占比 |
|--------|--------|------|
| A 系列 | 1,890 | 42.8% |
| B 系列 | 1,420 | 32.1% |
| C 系列 | 1,100 | 24.9% |
```

### 生成

```bash
python scripts/create_xlsx.py input.md output.xlsx
```

---

## 🔧 分析工具

### 数据分析
```bash
python scripts/analyze.py input.xlsx --sheet "销售总览"
```

### 数据透视
```bash
python scripts/pivot.py input.xlsx output.xlsx \
  --rows "区域" --vals "销售额" --agg sum
```

### 数据清洗
```bash
python scripts/clean.py input.xlsx output.xlsx
```
