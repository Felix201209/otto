#!/usr/bin/env python3
"""
Otto Data-Viz-Pro v2 — 发布会级图表引擎
支持：柱状/折线/饼图/圆环/散点/直方图/叠加/双轴/渐变/标注/暗色主题
用法：python create_chart.py config.json output.png
"""
from __future__ import annotations
import json, sys, re, math
from pathlib import Path

if sys.platform == 'win32':
    try: sys.stdout.reconfigure(encoding='utf-8')
    except: pass

try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.ticker as mticker
    from matplotlib import font_manager, colors as mcolors
    from matplotlib.patches import FancyBboxPatch, Arc, Polygon
    import numpy as np
except ImportError:
    print("pip install matplotlib numpy"); sys.exit(1)

# ══════════════════════════════════════════════════════════════════
# CJK FONT
# ══════════════════════════════════════════════════════════════════
def _setup_cjk():
    candidates = [
        'Microsoft YaHei', 'SimHei', 'Noto Sans CJK SC',
        'WenQuanYi Micro Hei', 'PingFang SC', 'Hiragino Sans GB',
        'Source Han Sans SC', 'Noto Sans SC',
    ]
    available = {f.name for f in font_manager.fontManager.ttflist}
    for name in candidates:
        if name in available:
            plt.rcParams['font.family'] = ['sans-serif']
            plt.rcParams['font.sans-serif'] = [name, 'DejaVu Sans']
            return name
    for f in font_manager.fontManager.ttflist:
        if any(k in f.name.lower() for k in ['yahei', 'simhei', 'cjk', 'noto', 'pingfang', 'hiragino', 'wenquan']):
            plt.rcParams['font.family'] = ['sans-serif']
            plt.rcParams['font.sans-serif'] = [f.name, 'DejaVu Sans']
            return f.name
    return None

_cjk = _setup_cjk()
plt.rcParams['axes.unicode_minus'] = False

# ══════════════════════════════════════════════════════════════════
# COLOR UTILITIES
# ══════════════════════════════════════════════════════════════════
def _rgb(h):
    h = h.lstrip("#"); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def _hex(r, g, b):
    return f"{max(0, min(255, int(r))):02X}{max(0, min(255, int(g))):02X}{max(0, min(255, int(b))):02X}"

def _fix(h):
    h = h.strip()
    return f"#{h}" if h and not h.startswith("#") and len(h) == 6 else h

def _lerp(a, b, t):
    ar, ag, ab = _rgb(a); br, bg, bb = _rgb(b)
    return f"#{_hex(ar + (br-ar)*t, ag + (bg-ag)*t, ab + (bb-ab)*t)}"

def _alpha(hex_color, a):
    r, g, b = _rgb(hex_color); return (r/255, g/255, b/255, a)

def _palette(base, accent, n):
    """Premium gradient palette from base→accent."""
    if n <= 1: return [accent]
    return [_lerp(base, accent, i / max(n - 1, 1)) for i in range(n)]

# ══════════════════════════════════════════════════════════════════
# PRESET THEMES
# ══════════════════════════════════════════════════════════════════
THEMES = {
    "dark": {"bg": "#0D1117", "card": "#161B22", "text": "#E6EDF3",
             "muted": "#8B949E", "grid": "#21262D", "accent": "#58A6FF"},
    "warm": {"bg": "#FFFBEB", "card": "#FFFFFF", "text": "#1C1917",
             "muted": "#78716C", "grid": "#F5F0E0", "accent": "#F59E0B"},
    "cool": {"bg": "#F0F4FF", "card": "#FFFFFF", "text": "#0F172A",
             "muted": "#64748B", "grid": "#E2E8F0", "accent": "#3B82F6"},
    "nature": {"bg": "#F0FDF4", "card": "#FFFFFF", "text": "#052E16",
               "muted": "#78716C", "grid": "#DCFCE7", "accent": "#16A34A"},
    "slate": {"bg": "#F8FAFC", "card": "#FFFFFF", "text": "#0F172A",
              "muted": "#94A3B8", "grid": "#F1F5F9", "accent": "#6366F1"},
}

# ══════════════════════════════════════════════════════════════════
# CONFIG LOADER
# ══════════════════════════════════════════════════════════════════
def load_config(path):
    raw = Path(path).read_text(encoding="utf-8")
    if raw.strip().startswith("{"):
        return json.loads(raw)
    m = re.search(r'```(?:json)?\s*\n(.*?)\n```', raw, re.DOTALL)
    if m: return json.loads(m.group(1))
    raise ValueError("Cannot parse config")

# ══════════════════════════════════════════════════════════════════
# CHART BUILDERS
# ══════════════════════════════════════════════════════════════════

def _style_ax(ax, cfg, theme):
    """Apply professional styling to axis."""
    bg = theme.get("bg", "#FFFFFF")
    ax.set_facecolor(theme.get("card", bg))
    for spine in ['top', 'right']:
        ax.spines[spine].set_visible(False)
    ax.spines['left'].set_color(theme.get("grid", "#E0E0E0"))
    ax.spines['bottom'].set_color(theme.get("grid", "#E0E0E0"))
    ax.spines['left'].set_linewidth(0.8)
    ax.spines['bottom'].set_linewidth(0.8)
    ax.tick_params(colors=theme.get("muted", "#999"), labelsize=9, pad=6)
    # Subtle horizontal gridlines
    ax.yaxis.grid(True, color=theme.get("grid", "#F0F0F0"), linewidth=0.4, alpha=0.7)
    ax.xaxis.grid(False)
    ax.set_axisbelow(True)
    # Y-axis formatting
    if cfg.get("y_format") == "currency":
        ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'¥{x:,.0f}'))
    elif cfg.get("y_format") == "percent":
        ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'{x:.0f}%'))

def _gradient_bars(ax, bars, top_color, bottom_color):
    """Apply vertical gradient to bar chart."""
    for bar in bars:
        bar.set_alpha(0.95)
        bar.set_edgecolor('none')
        # Create gradient fill
        bbox = bar.get_bbox()
        y0, y1 = bbox.y0, bbox.y1
        gradient = np.linspace(0, 1, 256).reshape(256, 1)
        gradient = np.hstack([gradient] * 4)
        for i in range(4):
            gradient[:, i] = np.linspace(
                _rgb(bottom_color)[i]/255,
                _rgb(top_color)[i]/255, 256)
        bar.set_alpha(1)
        ax.imshow(gradient, aspect='auto', extent=[bbox.x0, bbox.x1, y0, y1],
                  origin='lower', zorder=bar.get_zorder(), alpha=0.3 * bar.get_alpha())
    # Restore bar visibility
    for bar in bars: bar.set_alpha(0.88)

def _bar(ax, cfg, data, theme):
    series = data.get("series", [])
    x_labels = data.get("x_labels", data.get("labels", []))
    stacked = data.get("stacked", False)
    horizontal = data.get("horizontal", False)
    base_c = _fix(cfg.get("base", "0A1628"))
    accent_c = _fix(cfg.get("accent", theme.get("accent", "2D7DD2")))
    n_series = max(len(series), 1)
    palette = _palette(base_c, accent_c, n_series)
    n = max(len(x_labels), max((len(s.get("values", [])) for s in series), default=0))
    if n == 0: return

    x = np.arange(n)
    width = 0.7 / n_series if not stacked else 0.55

    for i, s in enumerate(series):
        vals = list(s.get("values", []))[:n]
        color = _fix(s.get("color") or palette[i])
        pos = x + (i - (n_series - 1) / 2) * width if not stacked else x

        if horizontal:
            bars = ax.barh(pos, vals, width * 0.9, color=color, alpha=0.92,
                           edgecolor='white', linewidth=0.8,
                           label=s.get("name", f"Series {i+1}"))
        else:
            bars = ax.bar(pos, vals, width * 0.9, color=color, alpha=0.92,
                          edgecolor='white', linewidth=0.8,
                          label=s.get("name", f"Series {i+1}"))

    if x_labels:
        if horizontal:
            ax.set_yticks(x)
            ax.set_yticklabels(x_labels, fontsize=9)
        else:
            ax.set_xticks(x)
            ax.set_xticklabels(x_labels, rotation=cfg.get("x_rotation", 0),
                               ha='center', fontsize=9)

    # Legend
    if n_series > 1:
        ax.legend(frameon=True, fontsize=9, loc='upper right',
                  facecolor='white', edgecolor=theme.get("grid", "#EEE"),
                  framealpha=0.95, borderpad=0.6, handlelength=1.5)

    # Value labels
    if not stacked:
        for bar in ax.patches:
            val = bar.get_width() if horizontal else bar.get_height()
            if val > 0:
                if horizontal:
                    ax.text(val + max(ax.get_xlim()) * 0.008, bar.get_y() + bar.get_height() / 2,
                            _fmt_num(val, cfg), ha='left', va='center',
                            fontsize=7, color=theme.get("muted", "#999"), fontweight='bold')
                else:
                    ax.text(bar.get_x() + bar.get_width() / 2, val + max(ax.get_ylim()) * 0.008,
                            _fmt_num(val, cfg), ha='center', va='bottom',
                            fontsize=7, color=theme.get("muted", "#999"), fontweight='bold')

def _line(ax, cfg, data, theme):
    series = data.get("series", [])
    x_labels = data.get("x_labels", data.get("labels", []))
    base_c = _fix(cfg.get("base", "0A1628"))
    accent_c = _fix(cfg.get("accent", theme.get("accent", "2D7DD2")))
    n_series = len(series)
    palette = _palette(base_c, accent_c, n_series)
    smooth = data.get("smooth", False)

    for i, s in enumerate(series):
        vals = list(s.get("values", []))
        color = _fix(s.get("color") or palette[i])
        x = list(range(len(vals)))
        if smooth and len(vals) > 3:
            x_smooth = np.linspace(min(x), max(x), len(vals) * 4)
            from scipy.interpolate import make_interp_spline
            try:
                spl = make_interp_spline(x, vals, k=min(3, len(vals)-1))
                y_smooth = spl(x_smooth)
                ax.plot(x_smooth, y_smooth, color=color, linewidth=2.5, alpha=0.3, zorder=1)
            except: pass
        ax.plot(x, vals, marker='o', linewidth=2.2, markersize=6,
                color=color, label=s.get("name", f"S{i+1}"),
                markerfacecolor='white', markeredgewidth=1.8,
                markeredgecolor=color, zorder=2)
        # Fill below
        if data.get("fill", False):
            ax.fill_between(x, vals, alpha=0.08, color=color)

    if x_labels:
        ax.set_xticks(range(len(x_labels)))
        ax.set_xticklabels(x_labels, rotation=cfg.get("x_rotation", 0), ha='center', fontsize=9)

    if n_series > 1:
        ax.legend(frameon=True, fontsize=9, loc='upper left',
                  facecolor='white', edgecolor=theme.get("grid", "#EEE"),
                  framealpha=0.95, borderpad=0.6, handlelength=1.8)

def _pie(ax, cfg, data, theme):
    labels = data.get("labels", [])
    values = data.get("values", [])
    base_c = _fix(cfg.get("base", "0A1628"))
    accent_c = _fix(cfg.get("accent", theme.get("accent", "2D7DD2")))
    palette = _palette(base_c, accent_c, len(labels))
    is_donut = cfg.get("type") == "donut" or data.get("donut")

    wedges, texts, autotexts = ax.pie(
        values, labels=labels, colors=palette,
        autopct='%1.1f%%', startangle=120,
        pctdistance=0.72 if is_donut else 0.62,
        labeldistance=1.15,
        wedgeprops=dict(width=0.45, edgecolor='white', linewidth=2) if is_donut
        else dict(edgecolor='white', linewidth=1.5),
        textprops={'fontsize': 10})
    for t in autotexts: t.set_fontsize(9); t.set_fontweight('bold'); t.set_color('#444')
    for t in texts: t.set_fontsize(10)

    if is_donut:
        # Center text for donut
        total = sum(values)
        ax.text(0, 0, f'{total:,.0f}', ha='center', va='center', fontsize=22, fontweight='bold', color=base_c)
        if data.get("center_label"):
            ax.text(0, -0.25, data["center_label"], ha='center', va='center', fontsize=9, color=theme.get("muted", "#999"))

def _scatter(ax, cfg, data, theme):
    series = data.get("series", [])
    base_c = _fix(cfg.get("base", "0A1628"))
    accent_c = _fix(cfg.get("accent", theme.get("accent", "2D7DD2")))
    palette = _palette(base_c, accent_c, len(series))
    for i, s in enumerate(series):
        color = _fix(s.get("color") or palette[i])
        ax.scatter(s.get("x", []), s.get("y", []), c=color, alpha=0.65,
                   s=50, edgecolors='white', linewidth=0.8,
                   label=s.get("name", f"S{i+1}"), zorder=3)
    if len(series) > 1:
        ax.legend(frameon=True, fontsize=9, loc='upper left',
                  facecolor='white', edgecolor=theme.get("grid", "#EEE"), framealpha=0.95)

def _histogram(ax, cfg, data, theme):
    vals = data.get("values", [])
    bins = data.get("bins", 'auto')
    accent_c = _fix(cfg.get("accent", theme.get("accent", "2D7DD2")))
    color = _fix(data.get("color") or accent_c)
    ax.hist(vals, bins=bins, color=color, alpha=0.75, edgecolor='white', linewidth=0.6)
    ax.set_ylabel("频次", fontsize=9, color=theme.get("muted", "#999"))

BUILDERS = {"line": _line, "bar": _bar, "pie": _pie, "donut": _pie,
            "scatter": _scatter, "histogram": _histogram}

# ══════════════════════════════════════════════════════════════════
# ANNOTATIONS
# ══════════════════════════════════════════════════════════════════
def _fmt_num(v, cfg):
    if abs(v) >= 1e8: return f"{v/1e8:.1f}亿"
    if abs(v) >= 1e4: return f"{v/1e4:.1f}万"
    if isinstance(v, float): return f"{v:,.1f}"
    return f"{v:,}"

def _annotate(ax, cfg, theme):
    annotations = cfg.get("annotations", [])
    for ann in annotations:
        x, y = ann.get("x", 0), ann.get("y", 0)
        text = ann.get("text", "")
        color = _fix(ann.get("color", theme.get("accent", "#58A6FF")))
        ax.annotate(text, xy=(x, y), fontsize=ann.get("size", 8),
                    color=color, fontweight='bold',
                    bbox=dict(boxstyle='round,pad=0.3', facecolor='white',
                              edgecolor=color, alpha=0.9, linewidth=0.8),
                    ha='center', va='bottom', zorder=10)

def _target_line(ax, cfg, theme):
    target = cfg.get("target_line", {})
    if "value" not in target: return
    val = target["value"]
    color = _fix(target.get("color", theme.get("accent", "#58A6FF")))
    label = target.get("label", f"目标: {val}")
    ax.axhline(y=val, color=color, linewidth=1.5, linestyle='--',
               alpha=0.7, zorder=5)
    ax.text(ax.get_xlim()[1] * 0.99, val, f"  {label}",
            ha='left', va='bottom' if val > 0 else 'top',
            fontsize=8, color=color, fontweight='bold')

# ══════════════════════════════════════════════════════════════════
# MAIN RENDER
# ══════════════════════════════════════════════════════════════════
def render(cfg):
    chart_type = cfg.get("type", "bar")
    title = cfg.get("title", "")
    subtitle = cfg.get("subtitle", "")
    xlabel = cfg.get("xlabel", "")
    ylabel = cfg.get("ylabel", "")
    source = cfg.get("source", "")
    data = cfg.get("data", {})
    figsize = tuple(cfg.get("figsize", (11, 6)))
    dpi = cfg.get("dpi", 200)
    retina = cfg.get("retina", True)
    theme_name = cfg.get("theme", "cool")
    theme = THEMES.get(theme_name, THEMES["cool"])
    base_c = _fix(cfg.get("base", "0A1628"))

    bg = theme.get("bg", "#FFFFFF")
    fig, ax = plt.subplots(figsize=figsize, dpi=dpi * (2 if retina else 1))
    fig.patch.set_facecolor(bg)
    _style_ax(ax, cfg, theme)

    builder = BUILDERS.get(chart_type)
    if not builder:
        raise ValueError(f"Unknown chart type: {chart_type}. Supported: {list(BUILDERS.keys())}")
    builder(ax, cfg, data, theme)

    # Title block — premium typography
    if title:
        # Accent bar before title
        ax.text(0, 1.08, title, transform=ax.transAxes, fontsize=18,
                fontweight='bold', color=theme.get("text", "#0F172A"), ha='left')
        # Small accent line under title
        ax.plot([0, 0.04], [1.055, 1.055], transform=ax.transAxes,
                color=_fix(cfg.get("accent", theme.get("accent", "#58A6FF"))),
                linewidth=3, solid_capstyle='round', clip_on=False)

    if subtitle:
        ax.text(0, 1.04, subtitle, transform=ax.transAxes,
                fontsize=10, color=theme.get("muted", "#94A3B8"),
                fontstyle='italic', ha='left')

    if xlabel:
        ax.set_xlabel(xlabel, fontsize=9, color=theme.get("muted", "#999"), labelpad=10)
    if ylabel:
        ax.set_ylabel(ylabel, fontsize=9, color=theme.get("muted", "#999"), labelpad=10)

    # Target line & annotations
    _target_line(ax, cfg, theme)
    _annotate(ax, cfg, theme)

    # Source line
    if source:
        fig.text(0.01, 0.01, f"来源: {source}", ha='left', va='bottom',
                 fontsize=6.5, color=theme.get("muted", "#CCC"), fontstyle='italic')

    # Branding
    fig.text(0.99, 0.01, "Otto Data-Viz-Pro", ha='right', va='bottom',
             fontsize=6, color=theme.get("muted", "#CCC"), fontstyle='italic', alpha=0.6)

    plt.tight_layout()
    return fig

def save_outputs(fig, base_path, cfg):
    png_path = Path(base_path)
    svg_path = png_path.with_suffix('.svg')
    dpi = cfg.get("dpi", 200) * (2 if cfg.get("retina", True) else 1)
    fig.savefig(str(png_path), dpi=dpi, bbox_inches='tight',
                facecolor=fig.get_facecolor(), edgecolor='none')
    fig.savefig(str(svg_path), bbox_inches='tight',
                facecolor=fig.get_facecolor(), edgecolor='none', format='svg')
    plt.close(fig)
    ks, sv = png_path.stat().st_size / 1024, svg_path.stat().st_size / 1024
    print(f"OK {png_path.name} {ks:.0f}KB (retina @2x) + {svg_path.name} {sv:.0f}KB")

# ══════════════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════════════
def main():
    import argparse
    p = argparse.ArgumentParser(description="Otto Data-Viz-Pro v2 — 发布会级图表引擎")
    p.add_argument("input"); p.add_argument("output")
    a = p.parse_args()
    cfg = load_config(a.input)
    fig = render(cfg)
    save_outputs(fig, a.output, cfg)

if __name__ == "__main__":
    main()
