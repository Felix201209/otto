#!/usr/bin/env python3
"""
Otto Doc-Writer v4 — 视觉母题驱动排版引擎

对标 ppt-creator 的方案：AI 为每份文档创造独有视觉母题，
引擎将其转化为丰富的排版决策——封面、章节过渡、正文、引用、
表格、落款——每块都有独立的视觉表情，不是"所有页面一个样"。

用法：
  python create_docx.py <input.md> <output.docx>

Markdown 中用 ## 标记新章节。AI 在 YAML frontmatter 里声明
视觉母题（theme/base/accent/atmosphere/fonts），其余由引擎生成。
"""
from __future__ import annotations

import re, sys, json
from datetime import datetime
from pathlib import Path
from typing import Any

if sys.platform == 'win32':
    try: sys.stdout.reconfigure(encoding='utf-8')
    except Exception: pass

try:
    from docx import Document
    from docx.shared import Cm, Pt, RGBColor, Emu, Inches
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.oxml.ns import qn, nsdecls
    from docx.oxml import parse_xml
except ImportError:
    print("pip install python-docx"); sys.exit(1)


# ═══════════════════════════════════════════════════════════════════════
# 视觉母题系统
# ═══════════════════════════════════════════════════════════════════════

def resolve_theme(meta: dict) -> dict:
    """
    AI 在 YAML 中声明：
      theme: 母题名称
      base:   基础色（最深的底色或主色）
      accent: 强调色
      surface: 表面色（卡片/引用块底色）
      atmosphere: 气氛关键词，引擎据此微调排版
      heading_font / body_font / body_size
      cover: true/false
      toc: true/false
    """
    t: dict[str, Any] = {}

    t["theme_name"]  = meta.get("theme", "Undefined")
    t["atmosphere"]  = meta.get("atmosphere", "")

    # 色彩——3 色足够，引擎派生其余
    t["base"]    = meta.get("base",    "0A1628")
    t["accent"]  = meta.get("accent",  "2D7DD2")
    t["surface"] = meta.get("surface", "F5F7FA")

    # 自动派生
    t["base_light"]  = _lighten(t["base"], 0.15)
    t["body"]        = _readable_body(t["base"])
    t["muted"]       = _muted(t["base"])
    t["table_hdr"]   = t["base"]
    t["table_text"]  = "FFFFFF"
    t["stripe"]      = t["surface"]
    t["callout_bg"]  = _blend(t["surface"], t["accent"], 0.06)
    t["callout_bar"] = t["accent"]
    t["hr"]          = _to_hex(*_lighten_rgb(*_hex_to_rgb(t["base"]), 0.75))
    t["cover_bg"]    = t["base"]
    t["cover_text"]  = "FFFFFF"
    t["white"]       = "FFFFFF"

    # 字体
    t["h_font"] = meta.get("heading_font", "Microsoft YaHei")
    t["b_font"] = meta.get("body_font",    "Microsoft YaHei")
    t["title_sz"]  = int(meta.get("title_size", "28"))
    t["h1_sz"]     = int(meta.get("h1_size",    "17"))
    t["h2_sz"]     = int(meta.get("h2_size",    "14"))
    t["body_sz"]   = int(meta.get("body_size",  "11"))

    t["cover"]  = meta.get("cover", "true") != "false"
    t["toc"]    = meta.get("toc", "true") == "true"
    t["indent"] = meta.get("indent", "true") != "false"

    t["margin"]  = float(meta.get("margin", "2.54"))
    t["line_sp"] = float(meta.get("line_spacing", "1.6"))

    return t


# ═══════════════════════════════════════════════════════════════════════
# 色彩工具
# ═══════════════════════════════════════════════════════════════════════

def _hex_to_rgb(h: str) -> tuple:
    h = h.lstrip("#"); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def _to_hex(r, g, b) -> str:
    return f"{max(0,min(255,int(r))):02X}{max(0,min(255,int(g))):02X}{max(0,min(255,int(b))):02X}"

def _lighten_rgb(r, g, b, amt: float) -> tuple:
    return (r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt)

def _darken_rgb(r, g, b, amt: float) -> tuple:
    return (r * (1 - amt), g * (1 - amt), b * (1 - amt))

def _lighten(h: str, amt: float) -> str:
    return _to_hex(*_lighten_rgb(*_hex_to_rgb(h), amt))

def _readable_body(base_hex: str) -> str:
    """从基础色推出可读正文色。"""
    r, g, b = _hex_to_rgb(base_hex)
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    if lum < 60: return "D0D6E0"
    if lum < 128: return "2D3540"
    return "333333"

def _muted(base_hex: str) -> str:
    r, g, b = _hex_to_rgb(base_hex)
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    if lum < 60: return "6B7B94"
    return "888888"

def _blend(c1: str, c2: str, ratio: float) -> str:
    r1, g1, b1 = _hex_to_rgb(c1)
    r2, g2, b2 = _hex_to_rgb(c2)
    return _to_hex(r1*(1-ratio)+r2*ratio, g1*(1-ratio)+g2*ratio, b1*(1-ratio)+b2*ratio)


# ═══════════════════════════════════════════════════════════════════════
# Markdown 解析
# ═══════════════════════════════════════════════════════════════════════

def parse_md(text: str) -> tuple[dict, list[dict]]:
    meta = {}
    body = text.strip()
    if body.startswith("---"):
        parts = body.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].strip().split("\n"):
                line = line.strip()
                if ":" in line and not line.startswith("#"):
                    k, _, v = line.partition(":")
                    meta[k.strip()] = v.strip().strip('"').strip("'")
            body = parts[2].strip()

    lines = body.split("\n"); i = 0
    sections: list[dict] = []
    cur = {"heading": "", "blocks": []}

    def save():
        if cur["blocks"]: sections.append(cur.copy())

    tbl = []; in_t = False

    while i < len(lines):
        line = lines[i]
        if line.strip().startswith("|") and line.strip().endswith("|"):
            tbl.append(line); in_t = True; i += 1; continue
        elif in_t:
            if tbl:
                hdrs, rows = _parse_tbl(tbl)
                if hdrs: cur["blocks"].append({"type":"table","h":hdrs,"r":rows})
            tbl = []; in_t = False; continue
        if not line.strip(): i += 1; continue

        m = re.match(r"^(#{2})\s+(.+)$", line)
        if m:
            save()
            cur = {"heading": m.group(2).strip(), "blocks": []}
            i += 1; continue

        m = re.match(r"^(#{3,6})\s+(.+)$", line)
        if m:
            cur["blocks"].append({"type":"subheading","level":len(m.group(1)),"text":m.group(2).strip()})
            i += 1; continue

        m = re.match(r"^[-*+]\s+(.+)$", line)
        if m:
            items = []
            while i < len(lines) and re.match(r"^[-*+]\s+(.+)$", lines[i]):
                items.append(re.match(r"^[-*+]\s+(.+)$", lines[i]).group(1).strip()); i += 1
            cur["blocks"].append({"type":"bullet","items":items}); continue

        m = re.match(r"^\d+[.)]\s+(.+)$", line)
        if m:
            items = []
            while i < len(lines) and re.match(r"^\d+[.)]\s+(.+)$", lines[i]):
                items.append(re.match(r"^\d+[.)]\s+(.+)$", lines[i]).group(1).strip()); i += 1
            cur["blocks"].append({"type":"ordered","items":items}); continue

        if line.startswith("> "):
            q = []
            while i < len(lines) and lines[i].startswith("> "):
                q.append(lines[i][2:].strip()); i += 1
            cur["blocks"].append({"type":"quote","text":" ".join(q)}); continue

        if line.strip() in ("---","***","___"):
            cur["blocks"].append({"type":"hr"}); i += 1; continue

        p = []
        while i < len(lines) and lines[i].strip() and not lines[i].startswith("#") and \
              not re.match(r"^[-*+]\s+", lines[i]) and not re.match(r"^\d+[.)]\s+", lines[i]) and \
              not lines[i].startswith("|") and not lines[i].startswith("> ") and \
              lines[i].strip() not in ("---","***","___"):
            p.append(lines[i]); i += 1
        cur["blocks"].append({"type":"para","text":"\n".join(p)})
    if tbl:
        hdrs, rows = _parse_tbl(tbl)
        if hdrs: cur["blocks"].append({"type":"table","h":hdrs,"r":rows})
    save()

    return meta, sections


def _parse_tbl(raw):
    if len(raw) < 2: return [], []
    h = [c.strip() for c in raw[0].strip("|").split("|")]
    rows = []
    for line in raw[1:]:
        if re.match(r"^[\|\-\s:]+$", line.strip()): continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if cells: rows.append(cells)
    return h, rows


# ═══════════════════════════════════════════════════════════════════════
# 文档渲染引擎 v4
# ═══════════════════════════════════════════════════════════════════════

class DocxRenderer:
    def __init__(self, t: dict, meta: dict):
        self.t = t; self.m = meta
        self.doc = Document()
        self._sec = self.doc.sections[0]
        self._has_cover = False
        self._chap = 0
        self._setup_page(self._sec)
        self._setup_styles()

    # ── helpers ──
    def _c(self, k): return RGBColor.from_string(self.t[k])
    def _hex(self, k): return self.t[k]
    def _mw(self): return Cm(self.t["margin"])
    def _cw(self): return Cm(21 - 2 * self.t["margin"])

    def _setup_page(self, sec):
        m = self._mw()
        sec.page_width = Cm(21); sec.page_height = Cm(29.7)
        sec.top_margin = m; sec.bottom_margin = m
        sec.left_margin = m; sec.right_margin = m

    def _setup_styles(self):
        bf = self.t["b_font"]; bs = Pt(self.t["body_sz"])
        hf = self.t["h_font"]
        body_c = self._c("body")

        ns = self.doc.styles["Normal"]
        ns.font.name = bf; ns.font.size = bs; ns.font.color.rgb = body_c
        ns.paragraph_format.space_after = Pt(4)
        ns.paragraph_format.line_spacing = self.t["line_sp"]
        self._ea(ns, bf)

        for lvl in range(1, 4):
            s = self.doc.styles[f"Heading {lvl}"]
            sizes = {1: Pt(self.t["h1_sz"]), 2: Pt(self.t["h2_sz"]),
                     3: Pt(self.t["h2_sz"] - 1)}
            s.font.name = hf; s.font.size = sizes[lvl]; s.font.bold = True
            s.font.color.rgb = self._c("base") if lvl == 1 else body_c
            self._ea(s, hf)
            s.paragraph_format.space_before = Pt(28 if lvl == 1 else 20 if lvl == 2 else 14)
            s.paragraph_format.space_after = Pt(8)
            s.paragraph_format.keep_with_next = True
            if lvl == 1:
                # accent 下划线
                pPr = s.element.get_or_add_pPr()
                pPr.append(parse_xml(
                    f'<w:pBdr {nsdecls("w")}>'
                    f'<w:bottom w:val="single" w:sz="6" w:space="6" w:color="{self._hex("accent")}"/>'
                    f'</w:pBdr>'))

    def _ea(self, style, font):
        rPr = style.element.get_or_add_rPr()
        rf = rPr.find(qn("w:rFonts"))
        if rf is None:
            rf = parse_xml(f'<w:rFonts {nsdecls("w")} />'); rPr.insert(0, rf)
        rf.set(qn("w:eastAsia"), font)

    def _run(self, r, *, name=None, sz=None, color=None, bold=False, italic=False):
        fn = name or self.t["b_font"]; ss = sz or Pt(self.t["body_sz"])
        cc = color or self._c("body")
        r.font.name = fn; r.font.size = ss; r.font.color.rgb = cc
        r.bold = bold; r.italic = italic
        rPr = r._element.get_or_add_rPr()
        rf = rPr.find(qn("w:rFonts"))
        if rf is None:
            rf = parse_xml(f'<w:rFonts {nsdecls("w")} />'); rPr.insert(0, rf)
        rf.set(qn("w:eastAsia"), fn)

    # ── 封面 ────────────────────────────────────────────────────────

    def cover(self):
        if not self.t["cover"]: return
        self._has_cover = True
        sec = self._sec
        sec.top_margin = Cm(4); sec.bottom_margin = Cm(3)

        title = self.m.get("title", "")
        sub = self.m.get("subtitle", "")
        author = self.m.get("author", "")
        date_str = self.m.get("date", "") or datetime.now().strftime("%Y年%m月")
        base = self._hex("base"); accent = self._hex("accent")

        # 顶部色块（占页面 ~40%）
        for _ in range(4):
            p = self.doc.add_paragraph()
            p.paragraph_format.space_before = Pt(0)
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = Pt(8)
            shd = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{base}" w:val="clear"/>')
            p._element.get_or_add_pPr().append(shd)

        # 留白
        for _ in range(3): self.doc.add_paragraph()

        # 大标题
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(14)
        r = p.add_run(title)
        self._run(r, name=self.t["h_font"], sz=Pt(self.t["title_sz"]),
                  color=self._c("base"), bold=True)

        # 装饰线
        pl = self.doc.add_paragraph()
        pl.alignment = WD_ALIGN_PARAGRAPH.CENTER
        pl.paragraph_format.space_before = Pt(16)
        pl.paragraph_format.space_after = Pt(16)
        pl._element.get_or_add_pPr().append(parse_xml(
            f'<w:pBdr {nsdecls("w")}>'
            f'<w:bottom w:val="single" w:sz="12" w:space="1" w:color="{accent}"/>'
            f'</w:pBdr>'))

        # 副标题
        if sub:
            ps = self.doc.add_paragraph()
            ps.alignment = WD_ALIGN_PARAGRAPH.CENTER
            ps.paragraph_format.space_after = Pt(6)
            self._run(ps.add_run(sub), sz=Pt(self.t["body_sz"] + 3),
                      color=self._c("body"))

        # 元信息
        for mt in [x for x in [author, date_str, self.m.get("department")] if x]:
            pm = self.doc.add_paragraph()
            pm.alignment = WD_ALIGN_PARAGRAPH.CENTER
            pm.paragraph_format.space_after = Pt(3)
            self._run(pm.add_run(mt), sz=Pt(self.t["body_sz"] - 1),
                      color=self._c("muted"))

        # 分节
        new = self.doc.add_section()
        self._setup_page(new)

    def _body_sec(self):
        if self._has_cover and len(self.doc.sections) > 1:
            return self.doc.sections[1]
        return self._sec

    # ── TOC ─────────────────────────────────────────────────────────

    def toc(self):
        if not self.t["toc"]: return
        p = self.doc.add_paragraph()
        p.paragraph_format.space_after = Pt(12)
        self._run(p.add_run("目  录"), name=self.t["h_font"],
                  sz=Pt(self.t["h1_sz"]), color=self._c("base"), bold=True)
        pl = self.doc.add_paragraph()
        pl._element.get_or_add_pPr().append(parse_xml(
            f'<w:pBdr {nsdecls("w")}>'
            f'<w:bottom w:val="single" w:sz="6" w:space="4" w:color="{self._hex("accent")}"/>'
            f'</w:pBdr>'))
        ptoc = self.doc.add_paragraph()
        r = ptoc.add_run()
        r._element.append(parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="begin"/>'))
        r2 = ptoc.add_run()
        r2._element.append(parse_xml(
            f'<w:instrText {nsdecls("w")} xml:space="preserve">'
            f' TOC \\o "1-2" \\h \\z \\u </w:instrText>'))
        r3 = ptoc.add_run()
        r3._element.append(parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="separate"/>'))
        r4 = ptoc.add_run("（Word 中右键 → 更新域 即可生成目录）")
        self._run(r4, sz=Pt(9), color=RGBColor.from_string("AAAAAA"), italic=True)
        r5 = ptoc.add_run()
        r5._element.append(parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="end"/>'))
        self.doc.add_page_break()

    # ── 章节过渡页 ──────────────────────────────────────────────────

    def chapter_opener(self, title: str):
        """章节过渡页：大号数字 + accent 色块 + 标题。"""
        self._chap += 1
        # 留白
        for _ in range(4): self.doc.add_paragraph()

        # 大号章节号
        pn = self.doc.add_paragraph()
        pn.alignment = WD_ALIGN_PARAGRAPH.LEFT
        pn.paragraph_format.space_after = Pt(4)
        self._run(pn.add_run(f"0{self._chap}" if self._chap < 10 else str(self._chap)),
                  name=self.t["h_font"], sz=Pt(48), color=self._c("accent"), bold=True)

        # 章节标题
        self.doc.add_paragraph(text=title, style="Heading 1")

        # accent 底部色块分隔
        pb = self.doc.add_paragraph()
        pb.paragraph_format.space_before = Pt(8)
        pb.paragraph_format.space_after = Pt(2)
        pb._element.get_or_add_pPr().append(parse_xml(
            f'<w:pBdr {nsdecls("w")}>'
            f'<w:bottom w:val="single" w:sz="18" w:space="1" w:color="{self._hex("accent")}"/>'
            f'</w:pBdr>'))

        self.doc.add_page_break()

    # ── 正文 ────────────────────────────────────────────────────────

    def heading(self, text: str, level: int):
        self.doc.add_paragraph(text, style=f"Heading {min(level,3)}")

    def para(self, text: str):
        p = self.doc.add_paragraph()
        if self.t["indent"]: p.paragraph_format.first_line_indent = Cm(0.74)
        p.paragraph_format.space_after = Pt(6)
        self._fmt_text(p, text)

    def bullet(self, items: list[str]):
        for item in items:
            p = self.doc.add_paragraph()
            pf = p.paragraph_format
            pf.left_indent = Cm(1); pf.first_line_indent = Cm(-0.5)
            pf.space_after = Pt(3)
            self._run(p.add_run("•  " + item))

    def ordered(self, items: list[str]):
        for idx, item in enumerate(items, 1):
            p = self.doc.add_paragraph()
            pf = p.paragraph_format
            pf.left_indent = Cm(1); pf.first_line_indent = Cm(-0.5)
            pf.space_after = Pt(3)
            self._run(p.add_run(f"{idx}.  {item}"))

    def quote(self, text: str):
        p = self.doc.add_paragraph()
        pf = p.paragraph_format
        pf.left_indent = Cm(1.2); pf.right_indent = Cm(0.8)
        pf.space_before = Pt(14); pf.space_after = Pt(14)
        pPr = p._element.get_or_add_pPr()
        pPr.append(parse_xml(
            f'<w:pBdr {nsdecls("w")}>'
            f'<w:left w:val="single" w:sz="24" w:space="10" w:color="{self._hex("callout_bar")}"/>'
            f'</w:pBdr>'))
        pPr.append(parse_xml(
            f'<w:shd {nsdecls("w")} w:fill="{self._hex("callout_bg")}" w:val="clear"/>'))
        self._run(p.add_run(text), sz=Pt(self.t["body_sz"] - 0.5),
                  color=RGBColor.from_string("555555"), italic=True)

    def table(self, hdrs: list[str], rows: list[list[str]]):
        if not hdrs: return
        self.doc.add_paragraph()
        cols = len(hdrs)
        tbl = self.doc.add_table(rows=1 + len(rows), cols=cols)
        tbl.alignment = WD_TABLE_ALIGNMENT.CENTER; tbl.autofit = True

        # 边框
        tblPr = tbl._tbl.tblPr
        if tblPr is None: tblPr = parse_xml(f'<w:tblPr {nsdecls("w")} />')
        for old in tblPr.findall(qn("w:tblBorders")): tblPr.remove(old)
        tblPr.append(parse_xml(
            f'<w:tblBorders {nsdecls("w")}>'
            f'<w:top w:val="single" w:sz="4" w:space="0" w:color="DDDDDD"/>'
            f'<w:left w:val="single" w:sz="4" w:space="0" w:color="DDDDDD"/>'
            f'<w:bottom w:val="single" w:sz="4" w:space="0" w:color="DDDDDD"/>'
            f'<w:right w:val="single" w:sz="4" w:space="0" w:color="DDDDDD"/>'
            f'<w:insideH w:val="single" w:sz="4" w:space="0" w:color="EEEEEE"/>'
            f'<w:insideV w:val="single" w:sz="4" w:space="0" w:color="EEEEEE"/>'
            f'</w:tblBorders>'))

        # 表头
        for j, h in enumerate(hdrs):
            cell = tbl.rows[0].cells[j]; cell.text = ""
            cp = cell.paragraphs[0]; cp.alignment = WD_ALIGN_PARAGRAPH.CENTER
            cp.paragraph_format.space_before = Pt(5)
            cp.paragraph_format.space_after = Pt(5)
            cell._element.get_or_add_tcPr().append(parse_xml(
                f'<w:tcMar {nsdecls("w")}>'
                f'<w:top w:w="50" w:type="dxa"/><w:bottom w:w="50" w:type="dxa"/>'
                f'<w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/>'
                f'</w:tcMar>'))
            cell._element.get_or_add_tcPr().append(parse_xml(
                f'<w:shd {nsdecls("w")} w:fill="{self._hex("table_hdr")}" w:val="clear"/>'))
            self._run(cp.add_run(h), name=self.t["h_font"], sz=Pt(self.t["body_sz"] - 0.5),
                      color=RGBColor.from_string(self._hex("table_text")), bold=True)

        for i, row in enumerate(rows):
            for j, val in enumerate(row):
                if j >= cols: continue
                cell = tbl.rows[i+1].cells[j]; cell.text = ""
                cp = cell.paragraphs[0]
                cp.paragraph_format.space_before = Pt(4)
                cp.paragraph_format.space_after = Pt(4)
                cell._element.get_or_add_tcPr().append(parse_xml(
                    f'<w:tcMar {nsdecls("w")}>'
                    f'<w:top w:w="40" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/>'
                    f'<w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/>'
                    f'</w:tcMar>'))
                if i % 2 == 1:
                    cell._element.get_or_add_tcPr().append(parse_xml(
                        f'<w:shd {nsdecls("w")} w:fill="{self._hex("stripe")}" w:val="clear"/>'))
                self._run(cp.add_run(val), sz=Pt(self.t["body_sz"] - 0.5))
        self.doc.add_paragraph()

    # ── 落款 / 页眉页脚 ─────────────────────────────────────────────

    def signature(self):
        sign = self.m.get("signature_unit") or self.m.get("author") or ""
        ds = self.m.get("signature_date") or self.m.get("date") or ""
        if not sign and not ds: return
        self.doc.add_paragraph()
        for line in [sign, ds]:
            if line:
                p = self.doc.add_paragraph()
                p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
                p.paragraph_format.space_after = Pt(3)
                self._run(p.add_run(line))

    def hf(self):
        title = self.m.get("title", "")
        sec = self._body_sec()

        hdr = sec.header; hdr.is_linked_to_previous = False
        hp = hdr.paragraphs[0]
        hp.paragraph_format.space_after = Pt(4)
        self._run(hp.add_run(title or ""), sz=Pt(8), color=self._c("muted"))
        hp._element.get_or_add_pPr().append(parse_xml(
            f'<w:pBdr {nsdecls("w")}>'
            f'<w:bottom w:val="single" w:sz="4" w:space="2" w:color="{self._hex("accent")}"/>'
            f'</w:pBdr>'))

        ftr = sec.footer; ftr.is_linked_to_previous = False
        fp = ftr.paragraphs[0]; fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        fp.paragraph_format.space_before = Pt(8)
        fp._element.get_or_add_pPr().append(parse_xml(
            f'<w:pBdr {nsdecls("w")}>'
            f'<w:top w:val="single" w:sz="4" w:space="4" w:color="E0E0E0"/>'
            f'</w:pBdr>'))
        self._run(fp.add_run("— "), sz=Pt(8), color=RGBColor.from_string("CCCCCC"))
        for tag, text in [("begin", None), (None, " PAGE "), ("end", None)]:
            rr = fp.add_run()
            rr._element.append(parse_xml(
                f'<w:fldChar {nsdecls("w")} w:fldCharType="{tag}"/>' if tag else
                f'<w:instrText {nsdecls("w")} xml:space="preserve">{text}</w:instrText>'))
        self._run(fp.add_run(" —"), sz=Pt(8), color=RGBColor.from_string("CCCCCC"))

        if self._has_cover:
            cs = self._sec; cs.different_first_page_header_footer = True
            cs.header.paragraphs[0].clear()
            cs.footer.paragraphs[0].clear()

    # ── 行内格式 ────────────────────────────────────────────────────

    def _fmt_text(self, p, text):
        tokens = re.split(r"(\*\*.+?\*\*|\*.+?\*|`.+?`)", text)
        for tok in tokens:
            if tok.startswith("**") and tok.endswith("**"):
                self._run(p.add_run(tok[2:-2]), bold=True)
            elif tok.startswith("*") and tok.endswith("*") and not tok.startswith("**"):
                self._run(p.add_run(tok[1:-1]), italic=True)
            elif tok.startswith("`") and tok.endswith("`"):
                self._run(p.add_run(tok[1:-1]), name="Consolas",
                          sz=Pt(self.t["body_sz"] - 1), color=RGBColor(0xC7, 0x25, 0x4E))
            elif tok:
                self._run(p.add_run(tok))

    # ── 主流程 ──────────────────────────────────────────────────────

    def build(self, sections: list[dict]):
        self.doc.core_properties.title = self.m.get("title", "")
        self.doc.core_properties.author = self.m.get("author", "")

        self.cover()
        if not self._has_cover:
            title = self.m.get("title", "")
            if title:
                p = self.doc.add_paragraph()
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                p.paragraph_format.space_after = Pt(12)
                self._run(p.add_run(title), name=self.t["h_font"],
                          sz=Pt(self.t["title_sz"]), color=self._c("base"), bold=True)
                pl = self.doc.add_paragraph()
                pl.alignment = WD_ALIGN_PARAGRAPH.CENTER
                pl.paragraph_format.space_after = Pt(16)
                pl._element.get_or_add_pPr().append(parse_xml(
                    f'<w:pBdr {nsdecls("w")}>'
                    f'<w:bottom w:val="single" w:sz="8" w:space="6" w:color="{self._hex("accent")}"/>'
                    f'</w:pBdr>'))

        self.toc()

        for sec in sections:
            if sec.get("heading"):
                self.chapter_opener(sec["heading"])

            for blk in sec.get("blocks", []):
                t = blk["type"]
                if   t == "subheading": self.heading(blk["text"], blk["level"])
                elif t == "para":       self.para(blk["text"])
                elif t == "bullet":     self.bullet(blk["items"])
                elif t == "ordered":    self.ordered(blk["items"])
                elif t == "quote":      self.quote(blk["text"])
                elif t == "table":      self.table(blk["h"], blk["r"])
                elif t == "hr":         self.doc.add_paragraph()

        self.signature()
        self.hf()

    def save(self, path): self.doc.save(path)


# ═══════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════

def main():
    import argparse
    p = argparse.ArgumentParser(description="Otto Doc-Writer v4: 视觉母题驱动排版引擎")
    p.add_argument("input"); p.add_argument("output")
    a = p.parse_args()
    ip = Path(a.input)
    if not ip.exists(): print(f"找不到 {a.input}"); sys.exit(1)
    text = ip.read_text(encoding="utf-8")
    meta, secs = parse_md(text)
    t = resolve_theme(meta)
    if "title" not in meta: meta["title"] = ip.stem
    gen = DocxRenderer(t, meta)
    gen.build(secs)
    op = Path(a.output); op.parent.mkdir(parents=True, exist_ok=True)
    gen.save(str(op))
    print(f"✅ {op}")
    print(f"   视觉母题：{t['theme_name']}" + (f" · {t['atmosphere']}" if t['atmosphere'] else ""))
    print(f"   大小：{op.stat().st_size/1024:.1f}KB · {len(secs)}章")

if __name__ == "__main__":
    main()
