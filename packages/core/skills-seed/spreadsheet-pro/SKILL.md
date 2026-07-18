---
name: spreadsheet-pro
version: 6
description: 视觉感知 Excel 引擎。AI 定义分析目标→创造母题→为每表选布局→多态渲染（含图表+条件格式）→自检迭代。
---

# 📊 Otto Spreadsheet-Pro v6 — 视觉感知表格

> **对标 ppt-creator：AI 定义分析目标→选择母题→逐表选布局→渲染+图表→自检。**

---

## 不可妥协

- 交付真实 .xlsx，不是 CSV、不是截图
- 数据必须校核：先分析后落表，不确定标待确认
- 每表选一个布局，不允许全表同布局
- 引擎：`create_xlsx.py`（openpyxl）

---

## 工作流

### Step 1：定义分析目标
这份表格要回答什么问题？给谁看？做出什么决策？

### Step 2：创造视觉母题

```yaml
theme: "深空数据"
base: "0A1628"
accent: "2D7DD2"
surface: "F0F4F8"
```

### Step 3：逐表设计布局

用 `##` 分割工作表。每表声明 `<!-- layout: xxx -->`：

| 布局 | 效果 | 适合 |
|------|------|------|
| `table` | 标准数据表+交替行条纹 | 数据列表 |
| `dashboard` | 大号KPI卡片风格 | 核心指标 |
| `chart` | 数据表+自动柱状图 | 趋势对比 |
| `comparison` | 正负色+条件格式 | 财务/同比 |

```markdown
## 销售总览 <!-- layout: dashboard -->

| 指标 | Q2 | Q1 | 环比 |
|------|-----|-----|------|
| 总收入 | 58.6亿 | 52.2亿 | +12.3% |
| 净利润 | 8.2亿 | 7.1亿 | +15.5% |

## 区域对比 <!-- layout: chart -->

| 区域 | Q2销售额 | Q1销售额 |
|------|---------|---------|
| 华北 | 1,250 | 1,100 |
| 华东 | 2,180 | 1,980 |
| 华南 | 980 | 820 |
```

### Step 4：生成

```bash
python scripts/create_xlsx.py input.md output.xlsx
```

引擎自动：多表渲染+交替行条纹+正负色+CJK列宽+冻结表头+dashboard和chart布局自动生成图表。

### Step 5：自检迭代

- [ ] 每个 sheet 的布局类型正确
- [ ] 数据数字可核验
- [ ] 图表已生成
- [ ] 列宽自适应正确
- [ ] 无多余空行/空列

---

## 分析工具

```bash
python scripts/analyze.py input.xlsx
python scripts/pivot.py input.xlsx out.xlsx --rows "区域" --vals "销售额"
python scripts/clean.py input.xlsx out.xlsx
```
