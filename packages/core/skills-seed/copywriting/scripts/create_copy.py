#!/usr/bin/env python3
"""
Otto Copywriting Pro v9

Usage:
  macOS/Linux: python3 create_copy.py config.json output.html
  Windows:     py -3 create_copy.py config.json output.html

Outputs:
  output.html, output.md, output.txt
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
import textwrap
from datetime import datetime
from pathlib import Path
from typing import Any

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


TONE_PRESETS: dict[str, dict[str, str]] = {
    "professional": {
        "label": "专业可信",
        "style": "克制、清晰、重证据，适合 B2B、SaaS、金融和企业服务。",
        "opening": "对团队来说，真正的效率问题往往不是单点工具，而是信息和行动没有连起来。",
    },
    "warm": {
        "label": "温暖亲切",
        "style": "像一个懂用户处境的人在说话，有温度但不煽情。",
        "opening": "很多时候，用户需要的不是更多选择，而是一个终于能省心的答案。",
    },
    "bold": {
        "label": "大胆高冲击",
        "style": "短句、有节奏、有态度，适合发布、活动和新品亮相。",
        "opening": "别再把时间耗在旧办法里。现在，该换一种更快的方式。",
    },
    "premium": {
        "label": "高级克制",
        "style": "留白、少解释、不堆形容词，用准确表达制造质感。",
        "opening": "好的体验，不需要反复解释。用户会在第一次使用时感受到差别。",
    },
    "playful": {
        "label": "年轻有梗",
        "style": "口语、轻快、有网感，但不油腻、不硬玩梗。",
        "opening": "有些麻烦不是你不努力，是工具真的不太会配合你。",
    },
}


INDUSTRY_PRESETS: dict[str, dict[str, list[str]]] = {
    "saas": {
        "pains": ["工具切换太多", "信息分散难追踪", "流程靠人盯容易漏"],
        "benefits": ["把分散工作收进一个入口", "让任务、资料和结论可追踪", "减少重复沟通和手工整理"],
        "ctas": ["预约 15 分钟演示", "获取团队试用方案"],
    },
    "ecommerce": {
        "pains": ["选择太多难判断", "担心品质和售后", "优惠信息不透明"],
        "benefits": ["清楚呈现核心卖点", "降低购买决策成本", "强化品质和服务信任"],
        "ctas": ["立即查看商品", "领取专属优惠"],
    },
    "finance": {
        "pains": ["信息不对称", "流程复杂门槛高", "风险和费用看不清"],
        "benefits": ["把方案讲清楚", "让申请路径更透明", "强调合规、风险提示和可追溯"],
        "ctas": ["在线测算", "咨询专业顾问"],
    },
    "education": {
        "pains": ["学了用不上", "时间安排困难", "缺少持续反馈"],
        "benefits": ["围绕真实场景学习", "降低开始成本", "让进步路径更可见"],
        "ctas": ["免费试听", "领取课程大纲"],
    },
    "health": {
        "pains": ["预约不方便", "信息理解成本高", "难判断方案是否适合自己"],
        "benefits": ["把服务流程讲明白", "降低咨询压力", "强调专业边界和隐私保护"],
        "ctas": ["预约咨询", "了解服务流程"],
    },
    "entertainment": {
        "pains": ["内容同质化", "新鲜感不足", "参与感弱"],
        "benefits": ["突出独特体验", "制造参与理由", "强化社群和情绪价值"],
        "ctas": ["立即体验", "加入活动"],
    },
}


CHANNEL_LABELS = {
    "landing": "官网或落地页",
    "social": "社媒种草",
    "wechat": "公众号或长图文",
    "email": "邮件或私域",
    "ads": "广告投放",
    "package": "整套品牌物料包",
}


HEX_COLOR_PATTERN = re.compile(r"^#[0-9A-Fa-f]{6}$")


def as_list(value: Any, fallback: list[str]) -> list[str]:
    if isinstance(value, list):
        items = [str(item).strip() for item in value if str(item).strip()]
        return items or list(fallback)
    if isinstance(value, str) and value.strip():
        items = [part.strip() for part in re.split(r"[，,、\n]+", value) if part.strip()]
        return items or list(fallback)
    return list(fallback)


def pick(cfg: dict[str, Any], key: str, fallback: str) -> str:
    value = cfg.get(key)
    return str(value).strip() if value is not None and str(value).strip() else fallback


def normalize_hex_color(cfg: dict[str, Any], key: str, fallback: str) -> str:
    value = fallback if key not in cfg else str(cfg[key]).strip()
    if not HEX_COLOR_PATTERN.fullmatch(value):
        raise ValueError(f"{key} must use #RRGGBB")
    return value.upper()


def normalize_proofs(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    proofs: list[dict[str, str]] = []
    for item in value:
        if isinstance(item, dict):
            number = pick(item, "number", "")
            label = pick(item, "label", "")
        else:
            number = ""
            label = str(item).strip() if item is not None else ""
        if number or label:
            proofs.append({"number": number, "label": label})
    return proofs


def load_config(path: str) -> dict[str, Any]:
    raw = Path(path).read_text(encoding="utf-8")
    stripped = raw.lstrip("\ufeff").strip()
    if stripped.startswith("{"):
        return json.loads(stripped)
    match = re.search(r"```(?:json)?\s*(.*?)```", raw, re.DOTALL)
    if match:
        return json.loads(match.group(1))
    raise ValueError("Cannot parse config. Provide JSON or a fenced JSON block.")


def normalize_config(cfg: dict[str, Any]) -> dict[str, Any]:
    industry = pick(cfg, "industry", "saas")
    preset = INDUSTRY_PRESETS.get(industry, INDUSTRY_PRESETS["saas"])
    tone = pick(cfg, "tone", "professional")
    if tone not in TONE_PRESETS:
        tone = "professional"
    channel = pick(cfg, "channel", pick(cfg, "use_case", "package"))
    if channel not in CHANNEL_LABELS:
        channel = "package"
    return {
        **cfg,
        "brand": pick(cfg, "brand", "待确认品牌"),
        "category": pick(cfg, "category", "待确认品类"),
        "audience": pick(cfg, "audience", pick(cfg, "target_audience", "待确认目标人群")),
        "value_prop": pick(cfg, "value_prop", "待确认价值主张"),
        "differentiator": pick(cfg, "differentiator", "待确认差异化"),
        "goal": pick(cfg, "goal", pick(cfg, "conversion_goal", "预约咨询")),
        "tone": tone,
        "industry": industry,
        "channel": channel,
        "base": normalize_hex_color(cfg, "base", "#122033"),
        "accent": normalize_hex_color(cfg, "accent", "#1E7A5F"),
        "pain_points": as_list(cfg.get("pain_points"), preset["pains"]),
        "benefits": as_list(cfg.get("benefits") or cfg.get("value_angles"), preset["benefits"]),
        "ctas": as_list(cfg.get("ctas"), preset["ctas"]),
        "proofs": normalize_proofs(cfg.get("proofs")),
        "forbidden_claims": as_list(cfg.get("forbidden_claims"), []),
    }


def build_core_message(cfg: dict[str, Any]) -> str:
    return (
        f"为{cfg['audience']}提供{cfg['category']}，"
        f"用{cfg['differentiator']}解决{cfg['pain_points'][0]}，"
        f"最终推动用户{cfg['goal']}。"
    )


def build_slogans(cfg: dict[str, Any]) -> list[dict[str, str]]:
    brand = cfg["brand"]
    category = cfg["category"]
    value = cfg["value_prop"]
    benefit = cfg["benefits"][0]
    pain = cfg["pain_points"][0]
    return [
        {"angle": "理性价值", "copy": f"{brand}，让{category}更清楚、更可控"},
        {"angle": "痛点转化", "copy": f"别再被{pain}拖住，用{brand}把工作推进下去"},
        {"angle": "利益承诺", "copy": f"{value}，从今天开始少走弯路"},
        {"angle": "行动召唤", "copy": f"下一次{benefit}，从{brand}开始"},
    ]


def build_landing(cfg: dict[str, Any]) -> dict[str, Any]:
    cta = cfg["ctas"][0]
    secondary = cfg["ctas"][1] if len(cfg["ctas"]) > 1 else "先了解方案"
    return {
        "headline": pick(cfg, "headline", f"把{cfg['pain_points'][0]}变成可推进的下一步"),
        "subheadline": pick(cfg, "subheadline", cfg["value_prop"]),
        "opening": TONE_PRESETS[cfg["tone"]]["opening"],
        "pains": cfg["pain_points"][:3],
        "benefits": cfg["benefits"][:4],
        "proofs": cfg["proofs"],
        "cta": cta,
        "secondary_cta": secondary,
    }


def build_social(cfg: dict[str, Any]) -> dict[str, str]:
    brand = cfg["brand"]
    value = cfg["value_prop"]
    pain = cfg["pain_points"][0]
    benefit = cfg["benefits"][0]
    cta = cfg["ctas"][0]
    return {
        "小红书/朋友圈": (
            f"最近发现，很多人不是不想把事做好，而是一直被「{pain}」消耗。\n\n"
            f"{brand}想解决的就是这件事：{value}。\n\n"
            f"它真正有用的地方，不是多一个功能，而是帮你{benefit}。\n\n"
            f"适合正在找更省心方案的人。{cta}。"
        ),
        "公众号/长图文开头": (
            f"如果一个团队每天都在处理{pain}，效率问题就不只是个人习惯，而是系统问题。\n\n"
            f"{brand}的核心价值，是把分散的信息、动作和结果重新连起来。{value}。"
        ),
        "广告短句": f"{brand}：{value}。现在{cta}。",
    }


def build_email(cfg: dict[str, Any]) -> dict[str, Any]:
    brand = cfg["brand"]
    value = cfg["value_prop"]
    pain = cfg["pain_points"][0]
    cta = cfg["ctas"][0]
    return {
        "subject": pick(cfg, "email_subject", f"{brand}：一个更轻的办法，解决{pain}"),
        "preheader": pick(cfg, "email_preheader", value),
        "body": [
            "你好，",
            "",
            f"如果你最近也在处理{pain}，可能已经感受到：问题不只是事情多，而是每一步都需要重复确认、整理和跟进。",
            "",
            f"{brand}希望把这件事变简单。{value}",
            "",
            f"你可以先从一个小场景开始试用，看看它是否真的能帮你{cfg['benefits'][0]}。",
            "",
            f"行动入口：{cta}",
        ],
    }


def build_compliance_notes(cfg: dict[str, Any]) -> list[str]:
    notes = [
        "未提供证据的数据、客户案例、认证和效果承诺均保留为待确认。",
        "发布前检查是否出现绝对化表述，例如“第一”“100%”“必然提升”。",
        "CTA 已尽量具体，如需投放，请替换为真实链接或活动入口。",
        "语气已按所选风格控制，仍建议结合品牌禁用词做最后校对。",
    ]
    if cfg["forbidden_claims"]:
        notes.append("用户禁用声明：" + "；".join(cfg["forbidden_claims"]))
    return notes


def build_package(cfg: dict[str, Any]) -> dict[str, Any]:
    return {
        "brief": {
            "brand": cfg["brand"],
            "category": cfg["category"],
            "audience": cfg["audience"],
            "value_prop": cfg["value_prop"],
            "differentiator": cfg["differentiator"],
            "channel": CHANNEL_LABELS[cfg["channel"]],
            "goal": cfg["goal"],
            "tone": TONE_PRESETS[cfg["tone"]]["label"],
        },
        "core_message": build_core_message(cfg),
        "slogans": build_slogans(cfg),
        "landing": build_landing(cfg),
        "social": build_social(cfg),
        "email": build_email(cfg),
        "notes": build_compliance_notes(cfg),
    }


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def proof_text(proof: dict[str, str]) -> str:
    number = proof["number"]
    label = proof["label"]
    if number and label:
        return f"{number}：{label}"
    return number or label


def render_html(cfg: dict[str, Any], package: dict[str, Any]) -> str:
    base = cfg["base"]
    accent = cfg["accent"]
    brief_rows = "\n".join(
        f"<tr><th>{esc(k)}</th><td>{esc(v)}</td></tr>"
        for k, v in package["brief"].items()
    )
    slogans = "\n".join(
        f"<li><strong>{esc(item['angle'])}</strong><span>{esc(item['copy'])}</span></li>"
        for item in package["slogans"]
    )
    pains = "\n".join(f"<li>{esc(item)}</li>" for item in package["landing"]["pains"])
    benefits = "\n".join(f"<li>{esc(item)}</li>" for item in package["landing"]["benefits"])
    proofs = package["landing"]["proofs"]
    proof_items = "\n".join(
        f"<li>{esc(proof_text(item))}</li>"
        for item in proofs
    ) or "<li>待确认（发布前请补充可核验的证据或背书）</li>"
    social = "\n".join(
        f"<details><summary>{esc(name)}</summary><pre>{esc(copy)}</pre></details>"
        for name, copy in package["social"].items()
    )
    email_body = "\n".join(package["email"]["body"])
    notes = "\n".join(f"<li>{esc(item)}</li>" for item in package["notes"])
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(cfg['brand'])} 品牌营销文案</title>
<style>
*{{box-sizing:border-box}}body{{margin:0;background:#f7f8fa;color:#172033;font-family:"Microsoft YaHei",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.7}}
.wrap{{max-width:880px;margin:0 auto;padding:40px 24px 64px}}
.hero{{background:{base};color:#fff;padding:44px 40px;border-radius:12px;border-bottom:6px solid {accent}}}
.hero h1{{margin:0 0 12px;font-size:34px;line-height:1.18;letter-spacing:0}}
.hero p{{margin:0;color:#dbe7ef;font-size:16px}}.meta{{margin-top:18px;color:#b9c7d3;font-size:12px}}
section{{padding:28px 0;border-bottom:1px solid #e5e9ef}}h2{{font-size:20px;margin:0 0 14px;color:{base}}}
table{{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e9ef}}th,td{{padding:10px 12px;border-bottom:1px solid #edf0f4;text-align:left;vertical-align:top}}th{{width:150px;color:#667085;background:#fbfcfd}}
.core{{font-size:18px;background:#fff;border-left:4px solid {accent};padding:18px 20px;border-radius:8px}}
.slogans{{list-style:none;padding:0;margin:0;display:grid;gap:10px}}.slogans li{{background:#fff;border:1px solid #e5e9ef;border-radius:8px;padding:14px 16px}}
.slogans strong{{display:block;color:{accent};font-size:13px;margin-bottom:4px}}.slogans span{{font-size:16px;font-weight:700}}
.cols{{display:grid;grid-template-columns:1fr 1fr;gap:16px}}.box{{background:#fff;border:1px solid #e5e9ef;border-radius:8px;padding:18px}}
.box ul{{margin:8px 0 0;padding-left:20px}}details{{background:#fff;border:1px solid #e5e9ef;border-radius:8px;padding:14px 16px;margin:10px 0}}
summary{{font-weight:700;cursor:pointer}}pre{{white-space:pre-wrap;font-family:inherit;background:#f3f5f7;border-radius:8px;padding:14px;margin:12px 0 0}}
.cta{{display:inline-block;background:{accent};color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;margin-right:8px}}
.secondary{{color:{accent};font-weight:700}}@media(max-width:720px){{.hero{{padding:32px 24px}}.hero h1{{font-size:28px}}.cols{{grid-template-columns:1fr}}}}
</style>
</head>
<body><main class="wrap">
<div class="hero">
  <h1>{esc(package['landing']['headline'])}</h1>
  <p>{esc(package['landing']['subheadline'])}</p>
  <div class="meta">Otto Copywriting Pro · {esc(TONE_PRESETS[cfg['tone']]['label'])} · {generated_at}</div>
</div>
<section><h2>品牌 brief</h2><table>{brief_rows}</table></section>
<section><h2>核心信息</h2><div class="core">{esc(package['core_message'])}</div></section>
<section><h2>Slogan 备选</h2><ul class="slogans">{slogans}</ul></section>
<section><h2>落地页文案</h2><p>{esc(package['landing']['opening'])}</p><div class="cols"><div class="box"><strong>痛点</strong><ul>{pains}</ul></div><div class="box"><strong>价值</strong><ul>{benefits}</ul></div></div><div class="box"><strong>证据与背书</strong><ul>{proof_items}</ul></div><p><a class="cta" href="#">{esc(package['landing']['cta'])}</a><span class="secondary">{esc(package['landing']['secondary_cta'])}</span></p></section>
<section><h2>渠道文案</h2>{social}</section>
<section><h2>营销邮件</h2><div class="box"><strong>主题：</strong>{esc(package['email']['subject'])}<br><strong>预览：</strong>{esc(package['email']['preheader'])}<pre>{esc(email_body)}</pre></div></section>
<section><h2>发布前自检</h2><ul>{notes}</ul></section>
</main></body></html>"""


def render_markdown(cfg: dict[str, Any], package: dict[str, Any]) -> str:
    lines: list[str] = [
        f"# {cfg['brand']} 品牌营销文案",
        "",
        f"> 调性：{package['brief']['tone']}  ",
        f"> 生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "",
        "## 品牌 brief",
        "",
    ]
    for key, value in package["brief"].items():
        lines.append(f"- **{key}**：{value}")
    lines.extend(["", "## 核心信息", "", package["core_message"], "", "## Slogan 备选", ""])
    for item in package["slogans"]:
        lines.append(f"- **{item['angle']}**：{item['copy']}")
    landing = package["landing"]
    lines.extend([
        "",
        "## 落地页文案",
        "",
        f"### {landing['headline']}",
        landing["subheadline"],
        "",
        landing["opening"],
        "",
        "### 痛点",
    ])
    lines.extend(f"- {item}" for item in landing["pains"])
    lines.append("")
    lines.append("### 价值")
    lines.extend(f"- {item}" for item in landing["benefits"])
    lines.extend(["", "### 证据与背书"])
    if landing["proofs"]:
        lines.extend(f"- {proof_text(item)}" for item in landing["proofs"])
    else:
        lines.append("- 待确认（发布前请补充可核验的证据或背书）")
    lines.extend(["", f"**主 CTA**：{landing['cta']}", f"**低压力 CTA**：{landing['secondary_cta']}"])
    lines.extend(["", "## 渠道文案", ""])
    for name, copy in package["social"].items():
        lines.extend([f"### {name}", "", "```text", copy, "```", ""])
    email_data = package["email"]
    lines.extend([
        "## 营销邮件",
        "",
        f"**主题**：{email_data['subject']}",
        f"**预览**：{email_data['preheader']}",
        "",
        "```text",
        "\n".join(email_data["body"]),
        "```",
        "",
        "## 发布前自检",
        "",
    ])
    lines.extend(f"- {item}" for item in package["notes"])
    return "\n".join(lines)


def render_text(package: dict[str, Any]) -> str:
    md = render_markdown(
        {
            "brand": package["brief"]["brand"],
            "tone": "professional",
        },
        package,
    )
    return re.sub(r"[*#>`]", "", md)


def save_all(cfg: dict[str, Any], package: dict[str, Any], output: str) -> None:
    base = Path(output)
    html_path = base.with_suffix(".html")
    md_path = base.with_suffix(".md")
    txt_path = base.with_suffix(".txt")
    html_path.parent.mkdir(parents=True, exist_ok=True)
    html_path.write_text(render_html(cfg, package), encoding="utf-8")
    md_path.write_text(render_markdown(cfg, package), encoding="utf-8")
    txt_path.write_text(render_text(package), encoding="utf-8")
    print(
        "OK "
        f"{html_path.name} {html_path.stat().st_size / 1024:.0f}KB + "
        f"{md_path.name} {md_path.stat().st_size / 1024:.0f}KB + "
        f"{txt_path.name} {txt_path.stat().st_size / 1024:.0f}KB"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Otto Copywriting Pro v9")
    parser.add_argument("input")
    parser.add_argument("output")
    args = parser.parse_args()
    try:
        cfg = normalize_config(load_config(args.input))
        package = build_package(cfg)
        save_all(cfg, package, args.output)
    except (OSError, ValueError) as error:
        parser.exit(2, f"error: {error}\n")


if __name__ == "__main__":
    main()
