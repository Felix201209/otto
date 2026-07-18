---
name: doc-writer
version: 4
description: 视觉母题驱动 Word 排版引擎。AI 为每份文档创造独有视觉语言——母题名称、氛围、三色调色板——引擎转化为封面、章节过渡页、正文、引用、表格的多种视觉形态。
---

# 📄 Otto Doc-Writer v4 — 视觉母题驱动

> **对标 ppt-creator：AI 创造视觉语言，引擎渲染。**

---

## 🔧 首次使用
```bash
pip install python-docx
```

---

## 🎨 AI 的工作（唯一需要你做的）

在 Markdown 的 YAML frontmatter 中声明**视觉母题**——只需 3-5 行，引擎自动派生所有排版参数：

```yaml
---
title: 文档标题
author: 作者
theme: 深空数据       # 给这套视觉起名（必填）
atmosphere: 冷静、专业、前瞻  # 气氛关键词
base: "0A1628"       # 基础色（最深的色）
accent: "2D7DD2"     # 强调色
surface: "F5F7FA"    # 表面色（卡片/引用底色）
cover: "true"        # 封面（true/false）
toc: "true"          # 目录
heading_font: "Microsoft YaHei"
body_font: "Microsoft YaHei"
---
```

**只需提供 3 个颜色**（base/accent/surface），引擎自动计算正文色、弱化色、表头色、交替行色、引用块底色、分隔线色——总共 12 种颜色。

---

## 📐 视觉母题速查

| 母题 | base | accent | surface | 适合 |
|------|------|--------|---------|------|
| 深空数据 | `0A1628` | `2D7DD2` | `F0F4F8` | 科技报告、战略方案 |
| 曜石金 | `1A1A2E` | `C8963E` | `F8F6F0` | 金融报告、高端提案 |
| 政务赤诚 | `8B0000` | `C00000` | `FFF8F8` | 政府公文、制度文件 |
| 森林绿洲 | `1B3A2D` | `2E8B57` | `F2F8F4` | 环保报告、ESG |
| 深蓝商务 | `1B3A5C` | `2980B9` | `EEF2F7` | 企业汇报、年度总结 |
| 极简灰 | `2D2D2D` | `555555` | `F5F5F5` | 学术论文、法律文书 |
| 紫夜星辰 | `2D1B4E` | `8E44AD` | `F5F0FA` | 创意提案、品牌方案 |
| 暖橙信赖 | `3D2B1F` | `E67E22` | `FDF5EF` | 培训方案、人力资源 |

---

## 🚀 生成流程

### Step 1：创造视觉母题
为文档选一个母题名称和 3 个颜色。

### Step 2：撰写 Markdown
用 `##` 标记章节（引擎自动为每章生成过渡页），`|表格|` 写数据，`>` 写高亮引用。

### Step 3：生成
```bash
python scripts/create_docx.py input.md output.docx
```

---

## ✏️ 编辑已有文档
```bash
python scripts/edit_docx.py unpack input.docx work/
# 编辑 word/document.xml
python scripts/edit_docx.py pack work/ output.docx
python scripts/comment.py work/ 0 "批注内容"
python scripts/accept_changes.py input.docx output.docx
```
