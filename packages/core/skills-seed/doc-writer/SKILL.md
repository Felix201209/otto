---
name: doc-writer
version: 4
description: 撰写正式中文商务文档——报告、方案、公文、通知、总结、会议纪要。AI 写 Markdown → python-docx 引擎 → 专业 .docx。支持编辑已有文档、批注、修订痕迹处理。
---

# 📄 Otto Doc-Writer — Word 公文撰写专家

当用户要求撰写正式 Word 文档时，使用内置 `python-docx` 引擎生成专业 .docx。

---

## 🔧 首次使用（一次性）

```bash
# 安装 Python 依赖（仅需 python-docx，无其他外部依赖）
pip install -r ~/.otto-user/skills/doc-writer/requirements.txt
```

Windows 用户如果报 SSL 错误：
```bash
pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org python-docx
```

---

## 🚀 每次做文档的完整流程

### Step 1：任务摄入

确认（不确认就合理推断，不问多余问题）：
- **文档类型**：报告 / 方案 / 通知 / 总结 / 函件 / 会议纪要
- **读者与场合**：对上汇报 / 对外发布 / 内部留档
- **核心目的**：读者看完后理解/相信/决定什么？
- **约束**：篇幅、截止时间、品牌/格式要求、禁改内容

如果有现成 .docx 模板，先学习其样式和结构。

### Step 2：结构设计

给出文档大纲让用户确认（标题 + 章节 + 关键要点），确认后再写正文。

对于不同文档类型，推荐结构：
- **报告**：摘要 → 背景 → 现状分析 → 问题/机会 → 建议方案 → 实施计划 → 结论
- **方案**：背景 → 目标 → 方案设计 → 优势分析 → 实施路径 → 预算/资源 → 风险预案
- **通知/公文**：依据 → 主体内容 → 工作要求 → 落款+日期
- **会议纪要**：会议信息 → 议题 → 讨论要点 → 决议 → 待办事项
- **函件**：收件方 → 事由 → 正文 → 落款

### Step 3：撰写 Markdown 正文

按以下格式写 YAML frontmatter + Markdown 正文：

```markdown
---
title: 关于XX的实施方案
author: XX部门
date: 2026年7月18日
---

## 一、背景与目标

根据上级指示，结合我单位实际...

## 二、方案设计

### 2.1 总体架构

**核心思路**：建立一个...

### 2.2 实施步骤

1. 第一阶段：基础搭建
2. 第二阶段：功能上线
3. 第三阶段：优化迭代

## 三、资源配置

| 资源类型 | 数量 | 预算（万元） | 备注 |
|----------|------|-------------|------|
| 服务器 | 3台 | 15 | 云服务器 |
| 人力 | 5人 | 30 | 3个月 |

## 四、风险与应对

> 关键在于提前识别风险...

## 五、下一步建议

- 立即启动第一阶段
- 组建专项工作组
```

写入到本地文件：`~/.otto-user/doc-content.md`

**格式要点**：
- `##` =一级标题、`###` =二级标题
- `**粗体**` 用于强调
- `|表格|` 用于数据
- `> 引用` 用于重点突出
- YAML 里可加 `preset: report|official|letter|meeting|proposal` 指定预设

### Step 4：生成 .docx

```bash
python ~/.otto-user/skills/doc-writer/scripts/create_docx.py \
  ~/.otto-user/doc-content.md \
  ~/Desktop/<文档名>.docx \
  --preset report
```

预设选项：`official`(公文) | `report`(报告) | `letter`(信函) | `meeting`(会议纪要) | `proposal`(方案)

生成后验证：
```bash
python ~/.otto-user/skills/doc-writer/scripts/office/validate.py ~/Desktop/<文档名>.docx
```

### Step 5：交付

向用户说明：
- ✅ 文档已生成，路径 + 大小
- 📝 可在 Word/WPS 中打开编辑
- 🔄 如需调整格式/内容，随时提出

---

## ✏️ 编辑已有文档

### 工作流程

```bash
# 1. 解包
python scripts/edit_docx.py unpack input.docx work/

# 2. 编辑 word/document.xml（AI 直接操作）

# 3. 重新打包
python scripts/edit_docx.py pack work/ output.docx
```

### 快速搜索替换

```bash
python scripts/edit_docx.py replace input.docx output.docx \
  --find "旧文本" --replace "新文本"
```

---

## 💬 批注

```bash
# 添加批注
python scripts/comment.py work/ 0 "此处需要补充数据"

# 回复批注
python scripts/comment.py work/ 1 "已补充，见附录三" --parent 0
```

---

## ✅ 修订痕迹处理

```bash
# 接受所有修订（产出干净版）
python scripts/accept_changes.py input.docx output.docx
```

---

## 🔄 格式转换

```bash
# docx → PDF（需要 LibreOffice）
python scripts/office/soffice.py --headless --convert-to pdf document.docx

# 旧 .doc → .docx
python scripts/office/soffice.py --headless --convert-to docx legacy.doc
```

---

## ⚠️ 降级策略

| 场景 | 响应 |
|------|------|
| python-docx 未安装 | `⚠️ 需要：pip install -r ~/.otto-user/skills/doc-writer/requirements.txt` |
| 无 python-docx 且无法安装 | 降级走 `generate_document` 工具（`format: article, output_format: docx`） |
| 中文显示乱码 | 检查是否使用 docs/ 脚本下的相对路径，路径中有中文需引号包裹 |
| 表格复杂 | 先简化为 Markdown 表格，python-docx 原生支持 |
| 用户已有模板 | 先解包分析样式，再按模板风格生成 |

---

## 📦 交付清单

- [ ] `.docx` 文件可用 Word/WPS 打开
- [ ] 标题、章节、段落格式正确
- [ ] 表格可编辑、样式统一
- [ ] 如有落款，格式正确
- [ ] 中文无乱码
