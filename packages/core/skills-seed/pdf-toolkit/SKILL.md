---
name: pdf-toolkit
version: 3
description: AI 驱动 PDF 文档处理引擎——生成、合并、拆分、提取、填表。AI 为每份 PDF 创造视觉语言，通过 YAML 设计令牌注入引擎。
---

# 📕 Otto PDF-Toolkit v3 — AI 驱动 PDF 引擎

> **核心理念：不做模板。AI 创造风格，引擎渲染。**

---

## 🔧 首次使用

```bash
pip install fpdf2 pypdf
```

---

## 🎨 设计令牌系统

AI 通过 YAML frontmatter 描述视觉语言。引擎理解以下令牌：

### 纸张
```yaml
page_size: "A4"         # A4/A3/Letter/Legal
orientation: "P"        # P=竖 L=横
margin: "25"            # 边距(mm)
```

### 色彩
```yaml
primary: "1B3A5C"       # 主色
accent: "2E75B6"        # 强调色
body_color: "333333"    # 正文色
muted: "888888"         # 弱化色
cover_bg: "1B3A5C"      # 封面顶部色块
cover_text: "FFFFFF"    # 封面文字色
table_header_bg: "1B3A5C"
table_header_text: "FFFFFF"
table_stripe: "F5F7FA"
callout_bg: "F0F4F8"
callout_bar: "2E75B6"
hr_color: "CCCCCC"
```

### 字体
```yaml
heading_font: "Helvetica"   # 标题字体
body_font: "Helvetica"      # 正文字体
title_size: "24"            # 主标题字号
h1_size: "16"
h2_size: "13"
body_size: "11"
```

### 封面/目录
```yaml
cover: "true"    # 是否封面
toc: "true"      # 是否目录
```

### 设计身份
```yaml
design_name: "深空数据"
design_mood: "冷静、专业"
```

---

## 🚀 生成 PDF

### Step 1：创造视觉语言
为这份 PDF 设计独有视觉语言，填入 YAML frontmatter。

### Step 2：撰写 Markdown 正文

```markdown
---
title: 季度总结报告
author: 市场部
design_name: "深空数据"
primary: "0A2647"
accent: "144272"
cover: "true"
---

## 一、概述
...
```

### Step 3：生成

```bash
python scripts/create_pdf.py input.md output.pdf
```

---

## 🔧 PDF 处理工具

### 合并 PDF
```bash
python scripts/merge_pdf.py output.pdf f1.pdf f2.pdf f3.pdf
```

### 拆分 PDF
```bash
python scripts/split_pdf.py input.pdf --pages 1-3,5-8
```

### 提取文字
```bash
python scripts/extract_text.py input.pdf --pages 1-5 -o text.txt
```

### 填写表单
```bash
python scripts/fill_form.py input.pdf output.pdf \
  --field "Name" "张三" --field "Date" "2026-07-18"
```
