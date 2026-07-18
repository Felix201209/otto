---
name: doc-writer
version: 3
description: AI 驱动智能 Word 文档排版引擎。AI 为每份文档创造独有视觉语言，通过 YAML 设计令牌注入引擎。不做模板，每份文档都有专属设计。
---

# 📄 Otto Doc-Writer v3 — AI 驱动的智能排版引擎

> **核心理念：不做模板。每份文档都应该有自己的视觉语言。**

AI 通过 YAML frontmatter 描述设计令牌（颜色/字体/排版），引擎忠实渲染。不预设任何风格——你创造风格，引擎执行。

---

## 🔧 首次使用

```bash
pip install python-docx
```

---

## 🎨 设计令牌系统

每份文档的 YAML frontmatter 中，你必须为这份文档创造**独一无二的视觉语言**。引擎理解以下令牌：

### 色彩（10 色系统）

```yaml
# 必选——决定文档气质
primary: "1B3A5C"          # 主色（标题/封面）
accent: "2E75B6"           # 强调色（装饰线/引用条）
body_color: "333333"       # 正文颜色

# 可选——精细控制
bg_color: "F8F9FA"        # 页面底色（不写则白色）
muted: "888888"            # 弱化文字（副标题/页眉）
table_header_bg: "1B3A5C"  # 表头底色
table_header_text: "FFFFFF" # 表头文字
table_stripe: "F5F7FA"     # 表格交替行
callout_bg: "F0F4F8"       # 引用块底色
callout_bar: "2E75B6"      # 引用块左侧竖线
hr_color: "CCCCCC"         # 分隔线
cover_bg: "1B3A5C"         # 封面顶部色块
cover_text: "FFFFFF"       # 封面文字
header_line_color: "2E75B6" # 页眉装饰线（填 none 去掉）
```

### 字体

```yaml
heading_font: "Microsoft YaHei"   # 标题字体
body_font: "SimSun"               # 正文字体
title_size: "26"                  # 主标题字号(pt)
h1_size: "16"                     # 一级标题字号
h2_size: "14"                     # 二级标题字号
body_size: "12"                   # 正文字号
```

### 排版

```yaml
cover: "true"             # 是否生成封面（true/false）
toc: "true"               # 是否生成目录（true/false）
first_indent: "true"      # 首行缩进（true/false）
title_align: "center"     # 标题对齐
line_spacing: "1.5"       # 行距
page_width: "21"          # 页面宽(cm)
page_height: "29.7"       # 页面高(cm)
margin_top: "2.54"
margin_bottom: "2.54"
margin_left: "3.18"
margin_right: "3.18"
```

### 设计身份

```yaml
design_name: "深空数据"      # 给你的视觉语言起名
design_mood: "冷静、专业、信赖"  # 情绪关键词
```

---

## 🚀 完整流程

### Step 1：任务摄入

确认文档类型、读者、核心目的。不确认就合理推断。

### Step 2：**创造视觉语言**

这是最关键的一步。你必须为这份文档创造独有的视觉语言——给这套设计起一个名字，选定色彩、字体、排版参数。把选择填入 YAML frontmatter。

**色彩选择指南：**

| 文档气质 | 推荐 primary | 推荐 accent |
|----------|-------------|-------------|
| 科技/创新 | 深蓝 #1B3A5C | 电光蓝 #2E75B6 |
| 金融/信赖 | 藏青 #0D233A | 金橙 #C8963E |
| 政务/权威 | 深红 #8B0000 | 暗金 #B8860B |
| 医疗/关怀 | 深绿 #1B4D3E | 暖绿 #4CAF84 |
| 教育/温暖 | 墨绿 #2C3E2C | 橙黄 #E8943A |
| 简约/现代 | 深灰 #2D2D2D | 亮蓝 #4A90D9 |
| 奢华/高端 | 黑金 #1A1A1A | 玫瑰金 #C89B7B |
| 环保/自然 | 森林绿 #2D5016 | 叶绿 #6B8E23 |
| 创意/活泼 | 深紫 #4A235A | 热粉 #E84855 |
| 法律/严肃 | 深蓝黑 #1C2833 | 古铜 #A0522D |

**字体选择指南：**

| 风格 | 标题字体 | 正文字体 |
|------|---------|---------|
| 现代科技 | Microsoft YaHei | Microsoft YaHei |
| 传统公文 | SimHei | FangSong |
| 商务报告 | Microsoft YaHei | SimSun |
| 创意提案 | Microsoft YaHei | Microsoft YaHei |
| 学术论文 | SimHei | SimSun |

### Step 3：撰写设计驱动的 Markdown

在 YAML frontmatter 中声明你的设计令牌，然后写正文。

示例——一份科技风方案：

```markdown
---
title: 智能客服系统建设方案
author: 技术研发中心
date: 2026年7月
department: AI实验室
subtitle: 基于大语言模型的新一代客户服务解决方案

design_name: "数智深蓝"
design_mood: "科技、专业、前瞻"

primary: "0A2647"
accent: "144272"
body_color: "2C3E50"
muted: "7F8C8D"
table_header_bg: "0A2647"
table_header_text: "FFFFFF"
table_stripe: "EBF5FB"
callout_bg: "D6EAF8"
callout_bar: "144272"
hr_color: "BDC3C7"
cover_bg: "0A2647"
cover_text: "FFFFFF"
header_line_color: "144272"

heading_font: "Microsoft YaHei"
body_font: "Microsoft YaHei"
title_size: "28"
h1_size: "17"
h2_size: "14"
body_size: "11"
line_spacing: "1.6"

cover: "true"
toc: "true"
---

## 一、项目背景

...
```

### Step 4：生成 .docx

```bash
python ~/.otto-user/skills/doc-writer/scripts/create_docx.py \
  ~/.otto-user/doc-content.md \
  ~/Desktop/<文档名>.docx
```

生成后验证：
```bash
python ~/.otto-user/skills/doc-writer/scripts/office/validate.py ~/Desktop/<文档名>.docx
```

---

## ⚡ 快速通道

如果用户说"快点"或"简单点"，使用以下默认令牌（不写 YAML 也可以跑）：

```yaml
primary: "1B3A5C"
accent: "2E75B6"
body_color: "333333"
heading_font: "Microsoft YaHei"
body_font: "SimSun"
cover: "true"
toc: "true"
```

但不建议——每份值得写的文档，都值得一个专属的视觉语言。

---

## ✏️ 编辑已有文档

```bash
python scripts/edit_docx.py unpack input.docx work/
# 编辑 word/document.xml
python scripts/edit_docx.py pack work/ output.docx
```

## 💬 批注

```bash
python scripts/comment.py work/ 0 "此处需要补充数据"
```

## ✅ 修订痕迹

```bash
python scripts/accept_changes.py input.docx output.docx
```

---

## ⚠️ 降级

| 场景 | 响应 |
|------|------|
| python-docx 未安装 | `pip install python-docx` |
| 系统无指定字体 | 自动降级 SimSun/Microsoft YaHei/Arial |
| generate_document 兜底 | `format: article, output_format: docx` |
