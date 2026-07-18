---
name: pdf-toolkit
version: 4
description: 视觉母题驱动 PDF 引擎。AI 创造母题 → 封面、章节页、正文——3色驱动全文档。
---

# 📕 Otto PDF-Toolkit v4

> **AI 创造视觉母题，引擎渲染。**

## 🔧 安装
```bash
pip install fpdf2 pypdf
```

## 🎨 视觉母题（AI 只需声明 3 色）

```yaml
theme: 深空数据
atmosphere: 冷静、专业
base: "0A1628"
accent: "2D7DD2"
surface: "F5F7FA"
cover: "true"
toc: "true"
```

## 🚀 生成
```bash
python scripts/create_pdf.py input.md output.pdf
```

## 🔧 工具
```bash
python scripts/merge_pdf.py out.pdf f1.pdf f2.pdf
python scripts/split_pdf.py in.pdf --pages 1-3,5-8
python scripts/extract_text.py in.pdf -o text.txt
python scripts/fill_form.py in.pdf out.pdf --field "Name" "张三"
```
