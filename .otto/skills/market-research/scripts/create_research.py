#!/usr/bin/env python3
"""
Otto Market Research Pro v9

Usage:
  python create_research.py config.json output.html

Outputs:
  output.html, output.md, output.csv, output.sources.json
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


INDUSTRIES: dict[str, dict[str, list[str] | str]] = {
    "saas": {
        "label": "SaaS / 企业软件",
        "trends": ["AI 原生功能成为标配", "垂直 SaaS 替代通用平台", "安全合规从加分项变成准入门槛", "PLG 与销售驱动并存"],
        "metrics": ["ARR/MRR", "NDR", "CAC 回收周期", "活跃团队数", "席位扩张率"],
        "drivers": ["企业降本增效", "远程协作常态化", "AI 降低使用门槛"],
        "risks": ["头部平台免费化", "客户预算收紧", "数据安全监管趋严"],
        "candidates": ["Notion", "飞书", "钉钉", "Slack", "Monday.com"],
    },
    "ai": {
        "label": "AI / 智能体",
        "trends": ["多模态和 Agent 工作流融合", "推理成本持续下降", "企业从试点转向真实流程", "模型能力差异转向产品体验差异"],
        "metrics": ["任务完成率", "响应延迟", "每次任务成本", "企业留存", "工具调用成功率"],
        "drivers": ["模型能力提升", "开源生态成熟", "企业自动化需求增强"],
        "risks": ["模型同质化", "数据隐私顾虑", "供应商锁定", "幻觉和可控性问题"],
        "candidates": ["ChatGPT", "Claude", "Gemini", "DeepSeek", "豆包"],
    },
    "ecommerce": {
        "label": "电商 / 消费品牌",
        "trends": ["内容电商继续吞噬搜索电商", "私域复购更重要", "DTC 品牌重视用户资产", "AI 推荐和客服提效"],
        "metrics": ["GMV", "客单价", "复购率", "ROAS", "退货率"],
        "drivers": ["社交内容影响决策", "物流基础设施成熟", "下沉市场持续增长"],
        "risks": ["平台政策变化", "流量成本上升", "同质化竞争", "价格战"],
        "candidates": ["天猫", "京东", "拼多多", "抖音电商", "小红书电商"],
    },
    "fintech": {
        "label": "金融科技",
        "trends": ["嵌入式金融成为新入口", "AI 风控深化", "支付和信贷更重合规", "数据要素市场化"],
        "metrics": ["交易规模", "坏账率", "获客成本", "审批通过率", "合规事件数"],
        "drivers": ["移动支付成熟", "监管沙盒鼓励创新", "中小企业金融需求"],
        "risks": ["牌照壁垒", "隐私合规成本", "系统性风险", "监管政策变化"],
        "candidates": ["蚂蚁集团", "Stripe", "Square", "微众银行", "Plaid"],
    },
    "health": {
        "label": "医疗健康",
        "trends": ["AI 辅助诊断加速", "互联网医院常态化", "可穿戴设备连接健康管理", "药物研发 AI 化"],
        "metrics": ["问诊量", "留存率", "诊断准确率", "监管批准数", "患者满意度"],
        "drivers": ["人口老龄化", "医保控费", "AI 技术突破"],
        "risks": ["临床验证周期长", "隐私要求高", "医疗责任边界复杂"],
        "candidates": ["微医", "平安好医生", "Teladoc", "Tempus", "推想医疗"],
    },
}


MATRIX_COLUMNS = [
    ("positioning", "定位"),
    ("target", "目标用户"),
    ("features", "核心功能"),
    ("pricing", "价格"),
    ("channels", "渠道"),
    ("strengths", "优势"),
    ("weaknesses", "短板"),
    ("evidence", "证据状态"),
]


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def pick(cfg: dict[str, Any], key: str, fallback: str) -> str:
    value = cfg.get(key)
    return str(value).strip() if value is not None and str(value).strip() else fallback


def as_list(value: Any, fallback: list[str]) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [part.strip() for part in re.split(r"[，,、/\n]+", value) if part.strip()]
    return fallback


def load_config(path: str) -> dict[str, Any]:
    raw = Path(path).read_text(encoding="utf-8")
    stripped = raw.lstrip("\ufeff").strip()
    if stripped.startswith("{"):
        return json.loads(stripped)
    match = re.search(r"```(?:json)?\s*(.*?)```", raw, re.DOTALL)
    if match:
        return json.loads(match.group(1))
    raise ValueError("Cannot parse config. Provide JSON or a fenced JSON block.")


def normalize_sources(cfg: dict[str, Any]) -> list[dict[str, str]]:
    sources = cfg.get("sources")
    if not isinstance(sources, list):
        return []
    normalized = []
    for item in sources:
        if not isinstance(item, dict):
            continue
        normalized.append({
            "title": pick(item, "title", "未命名来源"),
            "url": pick(item, "url", "待补充"),
            "date": pick(item, "date", datetime.now().strftime("%Y-%m-%d")),
            "tier": pick(item, "tier", "secondary"),
        })
    return normalized


def normalize_competitors(cfg: dict[str, Any], industry: dict[str, Any]) -> list[dict[str, Any]]:
    raw = cfg.get("competitors")
    competitors = raw if isinstance(raw, list) else []
    if not competitors:
        competitors = [{"name": name, "candidate": True} for name in industry.get("candidates", [])[:5]]

    rows: list[dict[str, Any]] = []
    for item in competitors:
        if isinstance(item, str):
            item = {"name": item, "candidate": True}
        if not isinstance(item, dict):
            continue
        evidence = pick(item, "evidence", "")
        sources = item.get("sources")
        has_source = isinstance(sources, list) and len(sources) > 0
        if not evidence:
            evidence = "有来源" if has_source else ("候选待确认" if item.get("candidate") else "待核实")
        rows.append({
            "name": pick(item, "name", "待确认竞品"),
            "positioning": pick(item, "positioning", "待核实"),
            "target": pick(item, "target", "待核实"),
            "features": pick(item, "features", "待核实"),
            "pricing": pick(item, "pricing", "待核实"),
            "channels": pick(item, "channels", "待核实"),
            "strengths": pick(item, "strengths", "待核实"),
            "weaknesses": pick(item, "weaknesses", "待核实"),
            "evidence": evidence,
            "sources": sources if isinstance(sources, list) else [],
        })
    return rows[:8]


def normalize_config(cfg: dict[str, Any]) -> dict[str, Any]:
    industry_key = pick(cfg, "industry", "ai")
    industry = INDUSTRIES.get(industry_key, INDUSTRIES["ai"])
    competitors = normalize_competitors(cfg, industry)
    return {
        **cfg,
        "brand": pick(cfg, "brand", pick(cfg.get("own", {}) if isinstance(cfg.get("own"), dict) else {}, "name", "我方产品")),
        "industry": industry_key,
        "industry_label": pick(cfg, "industry_label", str(industry["label"])),
        "decision_goal": pick(cfg, "decision_goal", "找差异化切入点"),
        "target_customer": pick(cfg, "target_customer", "待确认目标客户"),
        "our_positioning": pick(cfg, "our_positioning", pick(cfg, "positioning", "待确认定位")),
        "scope": pick(cfg, "scope", "直接竞品 3-5 家"),
        "time_range": pick(cfg, "time_range", datetime.now().strftime("%Y-%m-%d")),
        "trends": as_list(cfg.get("trends"), list(industry["trends"])),
        "metrics": as_list(cfg.get("metrics") or cfg.get("key_metrics"), list(industry["metrics"])),
        "drivers": as_list(cfg.get("drivers"), list(industry["drivers"])),
        "risks": as_list(cfg.get("risks"), list(industry["risks"])),
        "competitors": competitors,
        "sources": normalize_sources(cfg),
        "base": pick(cfg, "base", "132238"),
        "accent": pick(cfg, "accent", "2563EB"),
    }


def split_field(value: str, fallback: str) -> list[str]:
    if value == "待核实":
        return [fallback]
    return as_list(value, [fallback])


def build_swot(cfg: dict[str, Any]) -> dict[str, list[str]]:
    explicit = cfg.get("swot")
    if isinstance(explicit, dict) and all(k in explicit for k in ["strengths", "weaknesses", "opportunities", "threats"]):
        return {k: as_list(explicit.get(k), [])[:5] for k in ["strengths", "weaknesses", "opportunities", "threats"]}

    our_strengths = as_list(cfg.get("strengths") or cfg.get("our_strengths"), ["更聚焦的用户场景", "更快的产品迭代", "可围绕细分需求做差异化"])
    our_weaknesses = as_list(cfg.get("weaknesses") or cfg.get("our_weaknesses"), ["品牌认知待建立", "渠道覆盖待验证", "竞品资料仍需补齐"])
    competitor_strengths: list[str] = []
    competitor_weaknesses: list[str] = []
    for item in cfg["competitors"]:
        competitor_strengths.extend(split_field(item["strengths"], f"{item['name']} 的优势待核实"))
        competitor_weaknesses.extend(split_field(item["weaknesses"], f"{item['name']} 的短板待核实"))

    return {
        "strengths": our_strengths[:4],
        "weaknesses": our_weaknesses[:4],
        "opportunities": [
            f"围绕“{cfg['decision_goal']}”做更窄切口",
            *cfg["drivers"][:2],
            *(competitor_weaknesses[:2] or ["竞品短板仍需进一步访谈验证"]),
        ][:5],
        "threats": [
            *(competitor_strengths[:2] or ["头部竞品优势仍需核实"]),
            *cfg["risks"][:3],
        ][:5],
    }


def build_gap_analysis(cfg: dict[str, Any]) -> list[dict[str, str]]:
    gaps = []
    for item in cfg["competitors"][:4]:
        weakness = item["weaknesses"] if item["weaknesses"] != "待核实" else "公开资料不足，需补充用户访谈"
        gaps.append({
            "segment": item["name"],
            "gap": weakness,
            "move": f"用“{cfg['our_positioning']}”验证是否能切入其薄弱场景",
        })
    if not gaps:
        gaps.append({"segment": "待确认市场", "gap": "竞品和用户需求不足", "move": "先补 5 个用户访谈和 3 家竞品资料"})
    return gaps


def build_recommendations(cfg: dict[str, Any], swot: dict[str, list[str]]) -> list[str]:
    return [
        f"短期：围绕“{cfg['decision_goal']}”做 1 个窄场景验证，不要一开始全面对标头部竞品。",
        f"中期：把我方“{cfg['our_positioning']}”包装成明确差异化，并用 3 个客户访谈验证购买理由。",
        f"风险防线：对所有“待核实”的价格、功能和客户案例建立证据清单，避免把推断当事实。",
        f"下一步：优先补齐 {cfg['competitors'][0]['name']}、{cfg['competitors'][1]['name'] if len(cfg['competitors']) > 1 else '第二竞品'} 的价格、渠道和用户评价。",
    ]


def build_sources_payload(cfg: dict[str, Any]) -> dict[str, Any]:
    missing = []
    for comp in cfg["competitors"]:
        for key, label in MATRIX_COLUMNS:
            if comp.get(key) == "待核实" and key != "evidence":
                missing.append({"competitor": comp["name"], "field": label, "reason": "缺少可追溯来源"})
    return {
        "sources": cfg["sources"],
        "competitor_sources": {comp["name"]: comp.get("sources", []) for comp in cfg["competitors"]},
        "missing_evidence": missing,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }


def build_report(cfg: dict[str, Any]) -> dict[str, Any]:
    swot = build_swot(cfg)
    return {
        "brief": {
            "研究对象": cfg["brand"],
            "行业": cfg["industry_label"],
            "目标客户": cfg["target_customer"],
            "我方定位": cfg["our_positioning"],
            "决策目标": cfg["decision_goal"],
            "范围": cfg["scope"],
            "时间": cfg["time_range"],
        },
        "swot": swot,
        "gaps": build_gap_analysis(cfg),
        "recommendations": build_recommendations(cfg, swot),
        "sources_payload": build_sources_payload(cfg),
    }


def render_html(cfg: dict[str, Any], report: dict[str, Any]) -> str:
    brief_rows = "".join(f"<tr><th>{esc(k)}</th><td>{esc(v)}</td></tr>" for k, v in report["brief"].items())
    trend_items = "".join(f"<li>{esc(item)}</li>" for item in cfg["trends"])
    metric_tags = "".join(f"<span>{esc(item)}</span>" for item in cfg["metrics"])
    driver_items = "".join(f"<li>{esc(item)}</li>" for item in cfg["drivers"])
    risk_items = "".join(f"<li>{esc(item)}</li>" for item in cfg["risks"])
    matrix_head = "".join(f"<th>{label}</th>" for _, label in MATRIX_COLUMNS)
    matrix_rows = ""
    for comp in cfg["competitors"]:
        cells = "".join(f"<td>{esc(comp[key])}</td>" for key, _ in MATRIX_COLUMNS)
        matrix_rows += f"<tr><th>{esc(comp['name'])}</th>{cells}</tr>"
    gap_rows = "".join(
        f"<div class='gap'><strong>{esc(item['segment'])}</strong><p>{esc(item['gap'])}</p><small>{esc(item['move'])}</small></div>"
        for item in report["gaps"]
    )

    def swot_card(title: str, items: list[str], cls: str) -> str:
        lis = "".join(f"<li>{esc(item)}</li>" for item in items)
        return f"<div class='swot {cls}'><h3>{esc(title)}</h3><ul>{lis}</ul></div>"

    swot = report["swot"]
    swot_html = (
        swot_card("Strengths 优势", swot["strengths"], "s")
        + swot_card("Weaknesses 劣势", swot["weaknesses"], "w")
        + swot_card("Opportunities 机会", swot["opportunities"], "o")
        + swot_card("Threats 威胁", swot["threats"], "t")
    )
    recs = "".join(f"<li>{esc(item)}</li>" for item in report["recommendations"])
    missing_count = len(report["sources_payload"]["missing_evidence"])
    base = cfg["base"]
    accent = cfg["accent"]
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(cfg['brand'])} 竞品分析报告</title>
<style>
*{{box-sizing:border-box}}body{{margin:0;background:#f6f8fb;color:#172033;font-family:"Microsoft YaHei",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.68}}
.wrap{{max-width:1080px;margin:0 auto;padding:40px 24px 64px}}.hero{{background:{base};color:#fff;padding:42px 40px;border-radius:12px;border-bottom:6px solid {accent}}}
.hero h1{{margin:0 0 10px;font-size:34px;letter-spacing:0}}.hero p{{margin:0;color:#d7e2ef}}section{{padding:26px 0;border-bottom:1px solid #e5e9f0}}
h2{{font-size:20px;margin:0 0 14px;color:{base}}}table{{width:100%;border-collapse:collapse;background:white;border:1px solid #e5e9f0}}th,td{{padding:10px 12px;border-bottom:1px solid #edf0f4;text-align:left;vertical-align:top;font-size:13px}}th{{background:#f9fafb;color:#475467}}
.metrics{{display:flex;flex-wrap:wrap;gap:8px}}.metrics span{{background:#e8f0ff;color:{accent};padding:6px 12px;border-radius:999px;font-size:12px;font-weight:700}}
.cols{{display:grid;grid-template-columns:1fr 1fr;gap:16px}}.box,.gap{{background:white;border:1px solid #e5e9f0;border-radius:8px;padding:16px}}.box ul{{margin:8px 0 0;padding-left:20px}}
.matrix{{overflow-x:auto}}.matrix th:first-child{{position:sticky;left:0;background:#eef2f8}}.swot-grid{{display:grid;grid-template-columns:1fr 1fr;gap:14px}}
.swot{{border-radius:8px;padding:16px;border:1px solid #e5e9f0}}.swot h3{{font-size:15px;margin:0 0 8px}}.swot ul{{margin:0;padding-left:18px}}.s{{background:#ecfdf3}}.w{{background:#fff7ed}}.o{{background:#eff6ff}}.t{{background:#fef2f2}}
.gaps{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}}.gap p{{margin:6px 0}}.gap small{{color:#667085}}.recs li{{margin-bottom:8px}}.warn{{color:#b42318;font-weight:700}}
@media(max-width:760px){{.cols,.swot-grid,.gaps{{grid-template-columns:1fr}}.hero{{padding:30px 24px}}.hero h1{{font-size:28px}}}}
</style>
</head>
<body><main class="wrap">
<div class="hero"><h1>{esc(cfg['brand'])} 竞品分析报告</h1><p>{esc(cfg['decision_goal'])} · {esc(cfg['industry_label'])} · {datetime.now().strftime('%Y-%m-%d')}</p></div>
<section><h2>研究 brief</h2><table>{brief_rows}</table></section>
<section><h2>市场概览</h2><div class="cols"><div class="box"><strong>核心趋势</strong><ul>{trend_items}</ul></div><div class="box"><strong>增长驱动</strong><ul>{driver_items}</ul></div></div><h2 style="margin-top:18px">关键指标</h2><div class="metrics">{metric_tags}</div><h2 style="margin-top:18px">主要风险</h2><div class="box"><ul>{risk_items}</ul></div></section>
<section><h2>竞品矩阵</h2><div class="matrix"><table><tr><th>竞品</th>{matrix_head}</tr>{matrix_rows}</table></div><p class="warn">待核实字段：{missing_count} 项。不要把待核实信息当事实使用。</p></section>
<section><h2>机会缺口</h2><div class="gaps">{gap_rows}</div></section>
<section><h2>SWOT</h2><div class="swot-grid">{swot_html}</div></section>
<section><h2>策略建议</h2><ol class="recs">{recs}</ol></section>
</main></body></html>"""


def render_markdown(cfg: dict[str, Any], report: dict[str, Any]) -> str:
    lines = [
        f"# {cfg['brand']} 竞品分析报告",
        "",
        f"> {cfg['decision_goal']} · {cfg['industry_label']} · {datetime.now().strftime('%Y-%m-%d')}",
        "",
        "## 研究 brief",
        "",
    ]
    for k, v in report["brief"].items():
        lines.append(f"- **{k}**：{v}")
    lines.extend(["", "## 市场概览", "", "### 核心趋势"])
    lines.extend(f"- {item}" for item in cfg["trends"])
    lines.extend(["", "### 关键指标"])
    lines.extend(f"- `{item}`" for item in cfg["metrics"])
    lines.extend(["", "### 增长驱动"])
    lines.extend(f"- {item}" for item in cfg["drivers"])
    lines.extend(["", "### 风险"])
    lines.extend(f"- {item}" for item in cfg["risks"])
    lines.extend(["", "## 竞品矩阵", ""])
    headers = ["竞品"] + [label for _, label in MATRIX_COLUMNS]
    lines.append("| " + " | ".join(headers) + " |")
    lines.append("|" + "|".join(["---"] * len(headers)) + "|")
    for comp in cfg["competitors"]:
        row = [comp["name"]] + [comp[key] for key, _ in MATRIX_COLUMNS]
        lines.append("| " + " | ".join(str(item).replace("|", "/") for item in row) + " |")
    lines.extend(["", "## 机会缺口", ""])
    for item in report["gaps"]:
        lines.append(f"- **{item['segment']}**：{item['gap']}。建议：{item['move']}")
    lines.extend(["", "## SWOT", ""])
    for title, key in [("优势 Strengths", "strengths"), ("劣势 Weaknesses", "weaknesses"), ("机会 Opportunities", "opportunities"), ("威胁 Threats", "threats")]:
        lines.extend([f"### {title}", ""])
        lines.extend(f"- {item}" for item in report["swot"][key])
        lines.append("")
    lines.extend(["## 策略建议", ""])
    lines.extend(f"{idx}. {item}" for idx, item in enumerate(report["recommendations"], 1))
    lines.extend(["", "## 待验证清单", ""])
    for item in report["sources_payload"]["missing_evidence"][:20]:
        lines.append(f"- {item['competitor']}：{item['field']}（{item['reason']}）")
    return "\n".join(lines)


def save_csv(cfg: dict[str, Any], path: Path) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle)
        writer.writerow(["竞品"] + [label for _, label in MATRIX_COLUMNS])
        for comp in cfg["competitors"]:
            writer.writerow([comp["name"]] + [comp[key] for key, _ in MATRIX_COLUMNS])


def save_all(cfg: dict[str, Any], report: dict[str, Any], output: str) -> None:
    base = Path(output)
    html_path = base.with_suffix(".html")
    md_path = base.with_suffix(".md")
    csv_path = base.with_suffix(".csv")
    sources_path = base.with_suffix(".sources.json")
    html_path.write_text(render_html(cfg, report), encoding="utf-8")
    md_path.write_text(render_markdown(cfg, report), encoding="utf-8")
    save_csv(cfg, csv_path)
    sources_path.write_text(json.dumps(report["sources_payload"], ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        "OK "
        f"{html_path.name} {html_path.stat().st_size / 1024:.0f}KB + "
        f"{md_path.name} {md_path.stat().st_size / 1024:.0f}KB + "
        f"{csv_path.name} {csv_path.stat().st_size / 1024:.0f}KB + "
        f"{sources_path.name} {sources_path.stat().st_size / 1024:.0f}KB"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Otto Market Research Pro v9")
    parser.add_argument("input")
    parser.add_argument("output")
    args = parser.parse_args()
    cfg = normalize_config(load_config(args.input))
    report = build_report(cfg)
    save_all(cfg, report, args.output)


if __name__ == "__main__":
    main()
