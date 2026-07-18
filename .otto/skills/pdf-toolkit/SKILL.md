---
name: pdf-toolkit
version: 6
description: 视觉感知 PDF 引擎。AI 定义任务→创造母题→逐节选布局→多态渲染→自检迭代。对标 ppt-creator 智能模式。
---

# 📕 Otto PDF-Toolkit v6 — 视觉感知排版

> **对标 ppt-creator：AI 定义传播任务→创造母题→逐节选布局→多态渲染→自检。**

---

## 不可妥协

- 交付真实 PDF，不是纯文本、不是截图、不是中间产物
- 每份 PDF 创造独有视觉母题（3色+母题名称）
- 生成后用 PDF 阅读器打开检查，不达标迭代
- 引擎：`create_pdf.py`（fpdf2）

---

## 工作流（和 ppt-creator 一样的 5 步）

### Step 1：定义传播任务
一句话：读者看完这份 PDF 应该理解/相信/决定什么？

### Step 2：创造视觉母题

```yaml
theme: "深空数据"      # 母题名称
base: "0A1628"        # 基础色
accent: "2D7DD2"      # 强调色
surface: "F0F4F8"     # 表面色
cover: "true"
toc: "true"
```

母题同上（8 选 1）。

### Step 3：逐节设计布局

用 `##` 分节。每节声明 `<!-- layout: xxx -->`：

| 布局 | 效果 | 适合 |
|------|------|------|
| `narrative` | 通栏正文 | 背景、分析 |
| `two-column` | 左右双栏（用 **粗体标题** 分组） | 对比 |
| `data` | 通栏+突出表格 | 数据报告 |
| `highlight` | 大字引用块 | 核心结论 |
| `closing` | 通栏+右对齐签名 | 结尾 |

### Step 4：生成

```bash
python scripts/create_pdf.py input.md output.pdf
```

### Step 5：打开检查 + 迭代

- [ ] 封面母题色统一
- [ ] 每节布局正确
- [ ] 中文无乱码
- [ ] 页码正确
- [ ] 无多余空白页

不达标调整布局或母题，最多迭代 2 次。

---

## 合并/拆分/提取

```bash
python scripts/merge_pdf.py out.pdf f1.pdf f2.pdf
python scripts/split_pdf.py in.pdf --pages 1-3,5-8
python scripts/extract_text.py in.pdf -o text.txt
python scripts/fill_form.py in.pdf out.pdf --field "Name" "张三"
```
