#!/usr/bin/env python3
"""
Otto PDF-Toolkit v3：AI 驱动 PDF 生成引擎

设计令牌 → 专业 PDF。AI 为每份 PDF 创造视觉语言，引擎渲染。
基于 fpdf2（纯 Python，零外部二进制依赖）。

用法：
  python create_pdf.py <input.md> <output.pdf>

输入 Markdown 的 YAML frontmatter 中指定设计令牌。
"""
from __future__ import annotations

import json, os, re, sys
from datetime import datetime
from pathlib import Path
from typing import Any

if sys.platform == 'win32':
    try: sys.stdout.reconfigure(encoding='utf-8')
    except Exception: pass

try:
    from fpdf import FPDF
    from fpdf.enums import XPos, YPos, TableCellFillMode
except ImportError:
    print("错误：需要 fpdf2。pip install fpdf2"); sys.exit(1)


# ═══════════════════════════════════════════════════════════════════════
# 设计令牌解析
# ═══════════════════════════════════════════════════════════════════════

def parse_tokens(meta: dict) -> dict:
    t: dict[str, Any] = {}
    t["design_name"] = meta.get("design_name", "")
    t["design_mood"] = meta.get("design_mood", "")
    # 纸张
    t["page_size"]   = meta.get("page_size", "A4")
    t["orientation"] = meta.get("orientation", "P")  # P=竖 L=横
    t["margin"]      = float(meta.get("margin", "25"))
    # 颜色
    t["primary"]     = meta.get("primary",     "1B3A5C")
    t["accent"]      = meta.get("accent",      "2E75B6")
    t["body_color"]  = meta.get("body_color",  "333333")
    t["muted"]       = meta.get("muted",       "888888")
    t["cover_bg"]    = meta.get("cover_bg",    t["primary"])
    t["cover_text"]  = meta.get("cover_text",  "FFFFFF")
    t["table_header_bg"] = meta.get("table_header_bg", t["primary"])
    t["table_header_text"] = meta.get("table_header_text", "FFFFFF")
    t["table_stripe"] = meta.get("table_stripe", "F5F7FA")
    t["callout_bg"]  = meta.get("callout_bg",  "F0F4F8")
    t["callout_bar"] = meta.get("callout_bar", t["accent"])
    t["hr_color"]    = meta.get("hr_color",    "CCCCCC")
    # 字体
    t["heading_font"] = meta.get("heading_font", "Helvetica")
    t["body_font"]    = meta.get("body_font",    "Helvetica")
    t["title_size"]   = int(meta.get("title_size", "24"))
    t["h1_size"]      = int(meta.get("h1_size",    "16"))
    t["h2_size"]      = int(meta.get("h2_size",    "13"))
    t["body_size"]    = int(meta.get("body_size",  "11"))
    # 封面
    t["cover"] = meta.get("cover", "false") == "true"
    t["toc"]   = meta.get("toc",   "false") == "true"
    return t


def _hex(hex_str: str) -> tuple:
    h = hex_str.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))


# ═══════════════════════════════════════════════════════════════════════
# Markdown 解析
# ═══════════════════════════════════════════════════════════════════════

def parse_frontmatter(text: str) -> tuple[dict, str]:
    meta = {}; body = text.strip()
    if body.startswith("---"):
        parts = body.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].strip().split("\n"):
                line = line.strip()
                if ":" in line and not line.startswith("#"):
                    k, _, v = line.partition(":")
                    meta[k.strip()] = v.strip().strip('"').strip("'")
            body = parts[2].strip()
    return meta, body


def parse_body(text: str) -> list[dict]:
    blocks = []; lines = text.split("\n"); i = 0
    tbl = []; in_tbl = False

    def flush():
        nonlocal tbl, in_tbl
        if tbl: blocks.append({"type":"table","raw":tbl}); tbl = []; in_tbl = False

    while i < len(lines):
        line = lines[i]
        if line.strip().startswith("|") and line.strip().endswith("|"):
            tbl.append(line); in_tbl = True; i += 1; continue
        elif in_tbl: flush(); continue
        if not line.strip(): i += 1; continue

        m = re.match(r"^(#{1,6})\s+(.+)$", line)
        if m:
            flush()
            blocks.append({"type":"heading","level":len(m.group(1)),"text":m.group(2).strip()})
            i += 1; continue

        m = re.match(r"^[-*+]\s+(.+)$", line)
        if m:
            flush(); items = []
            while i < len(lines) and re.match(r"^[-*+]\s+(.+)$", lines[i]):
                items.append(re.match(r"^[-*+]\s+(.+)$", lines[i]).group(1).strip()); i += 1
            blocks.append({"type":"bullet_list","items":items}); continue

        m = re.match(r"^\d+[.)]\s+(.+)$", line)
        if m:
            flush(); items = []
            while i < len(lines) and re.match(r"^\d+[.)]\s+(.+)$", lines[i]):
                items.append(re.match(r"^\d+[.)]\s+(.+)$", lines[i]).group(1).strip()); i += 1
            blocks.append({"type":"ordered_list","items":items}); continue

        if line.startswith("> "):
            flush(); q = []
            while i < len(lines) and lines[i].startswith("> "):
                q.append(lines[i][2:].strip()); i += 1
            blocks.append({"type":"quote","text":"\n".join(q)}); continue

        if line.strip() in ("---","***","___"):
            flush(); blocks.append({"type":"hr"}); i += 1; continue

        flush(); p = []
        while i < len(lines) and lines[i].strip() and not lines[i].startswith("#") and \
              not re.match(r"^[-*+]\s+", lines[i]) and not re.match(r"^\d+[.)]\s+", lines[i]) and \
              not lines[i].startswith("|") and not lines[i].startswith("> ") and \
              lines[i].strip() not in ("---","***","___"):
            p.append(lines[i]); i += 1
        blocks.append({"type":"paragraph","text":"\n".join(p)})
    flush()
    return blocks


def parse_table(raw: list[str]) -> tuple[list[str], list[list[str]]]:
    if len(raw) < 2: return [], []
    hdrs = [c.strip() for c in raw[0].strip("|").split("|")]
    rows = []
    for r in raw[1:]:
        if re.match(r"^[\|\-\s:]+$", r.strip()): continue
        cells = [c.strip() for c in r.strip("|").split("|")]
        if cells: rows.append(cells)
    return hdrs, rows


# ═══════════════════════════════════════════════════════════════════════
# PDF 渲染器 — 设计令牌驱动
# ═══════════════════════════════════════════════════════════════════════

class PDFRenderer:
    def __init__(self, tokens: dict, meta: dict):
        self.t = tokens; self.m = meta
        self.pdf = FPDF(orientation=tokens["orientation"], unit="mm",
                        format=tokens["page_size"])
        self.pdf.set_auto_page_break(True, tokens["margin"])
        self.margin = tokens["margin"]
        self._has_cover = False
        self._toc_entries = []
        self._page_w = self.pdf.w - 2 * self.margin
        # 字体注册
        # 添加中文字体支持（如果系统有）
        self._cn_font = None
        self._register_fonts()

    def _register_fonts(self):
        """尝试注册中文字体。"""
        cn_paths = [
            # Windows
            "C:/Windows/Fonts/msyh.ttc",
            "C:/Windows/Fonts/simsun.ttc",
            "C:/Windows/Fonts/simhei.ttf",
            "C:/Windows/Fonts/simfang.ttf",
            # macOS
            "/System/Library/Fonts/PingFang.ttc",
            "/System/Library/Fonts/STHeiti Light.ttc",
            "/Library/Fonts/Arial Unicode.ttf",
            # Linux
            "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        ]
        for p in cn_paths:
            if os.path.exists(p):
                try:
                    self.pdf.add_font("CNBody", "", p)
                    self.pdf.add_font("CNBody", "B", p)
                    self._cn_font = "CNBody"
                    return
                except Exception:
                    pass

    def _c(self, key: str) -> tuple: return _hex(self.t.get(key, "000000"))

    def _fnt(self, key: str) -> str:
        f = self.t.get(key, "Helvetica")
        if self._cn_font and any(ord(c) > 127 for c in (self.m.get("title","") + self.m.get("subtitle",""))):
            return self._cn_font
        return f

    def _is_cn(self): return self._cn_font is not None

    # ── 封面 ──

    def add_cover(self):
        if not self.t.get("cover"): return
        self._has_cover = True

        title = self.m.get("title", "")
        subtitle = self.m.get("subtitle", "")
        author = self.m.get("author", "")
        date_str = self.m.get("date", "") or datetime.now().strftime("%Y年%m月")

        self.pdf.add_page()
        w = self.pdf.w; h = self.pdf.h
        cbg = self._c("cover_bg")

        # 顶部色块
        self.pdf.set_fill_color(*cbg)
        self.pdf.rect(0, 0, w, h * 0.42, "F")

        # 底部细线
        self.pdf.set_draw_color(*self._c("accent"))
        self.pdf.set_line_width(0.6)
        self.pdf.line(self.margin, h * 0.42 + 6, w - self.margin, h * 0.42 + 6)

        # 标题（色块内）
        self.pdf.set_y(h * 0.42 + 18)
        self.pdf.set_font(self._fnt("heading_font"), "B", self.t["title_size"])
        self.pdf.set_text_color(*self._c("primary"))
        self.pdf.multi_cell(self._page_w, self.t["title_size"] * 0.55, title, align="C")

        if subtitle:
            self.pdf.ln(6)
            self.pdf.set_font(self._fnt("body_font"), "", self.t["body_size"] + 2)
            self.pdf.set_text_color(*self._c("body_color"))
            self.pdf.multi_cell(self._page_w, 7, subtitle, align="C")

        # 元信息
        self.pdf.ln(16)
        self.pdf.set_font(self._fnt("body_font"), "", self.t["body_size"])
        self.pdf.set_text_color(*self._c("muted"))
        meta_texts = []
        if author: meta_texts.append(author)
        if date_str: meta_texts.append(date_str)
        if self.m.get("department"): meta_texts.append(self.m["department"])
        self.pdf.multi_cell(self._page_w, 6, " · ".join(meta_texts), align="C")

    # ── 页眉/页脚 ──

    def header(self):
        if self._has_cover and self.pdf.page == 1: return
        self.pdf.set_font(self._fnt("body_font"), "", 8)
        self.pdf.set_text_color(*self._c("muted"))
        title = self.m.get("title", "")[:40]
        self.pdf.cell(self._page_w, 4, title, align="L")
        self.pdf.ln(4)
        self.pdf.set_draw_color(*self._c("accent"))
        self.pdf.set_line_width(0.2)
        self.pdf.line(self.margin, self.pdf.get_y(), self.pdf.w - self.margin, self.pdf.get_y())
        self.pdf.ln(4)

    def footer(self):
        if self._has_cover and self.pdf.page == 1: return
        self.pdf.set_y(-self.margin + 4)
        self.pdf.set_draw_color(*self._c("hr_color"))
        self.pdf.set_line_width(0.15)
        self.pdf.line(self.margin, self.pdf.get_y(), self.pdf.w - self.margin, self.pdf.get_y())
        self.pdf.set_font(self._fnt("body_font"), "", 8)
        self.pdf.set_text_color(*self._c("muted"))
        self.pdf.cell(self._page_w, 4, f"— {self.pdf.page_no()} —", align="C")

    # ── 正文块 ──

    def add_heading(self, text: str, level: int):
        sizes = {1: self.t["h1_size"], 2: self.t["h2_size"], 3: self.t["h2_size"] - 1}
        sz = sizes.get(level, 11)
        self.pdf.ln(6 if level > 1 else 4)
        self.pdf.set_font(self._fnt("heading_font"), "B", sz)
        color = self._c("primary") if level == 1 else self._c("body_color")
        self.pdf.set_text_color(*color)
        self.pdf.cell(self._page_w, sz * 0.55, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        # 一级标题下方细线
        if level == 1:
            self.pdf.set_draw_color(*self._c("accent"))
            self.pdf.set_line_width(0.3)
            self.pdf.line(self.margin, self.pdf.get_y() + 1, self.pdf.w - self.margin, self.pdf.get_y() + 1)
            self.pdf.ln(4)
        else:
            self.pdf.ln(2)
        # TOC 记录
        if level <= 2:
            self._toc_entries.append({"level": level, "text": text, "page": self.pdf.page})

    def add_paragraph(self, text: str):
        self.pdf.ln(2)
        self.pdf.set_font(self._fnt("body_font"), "", self.t["body_size"])
        self.pdf.set_text_color(*self._c("body_color"))
        # 处理行内标记
        parts = re.split(r"(\*\*.+?\*\*|\*.+?\*|`.+?`)", text)
        line = ""
        for tok in parts:
            if tok.startswith("**") and tok.endswith("**"):
                self.pdf.set_font(self._fnt("body_font"), "B", self.t["body_size"])
                line += tok[2:-2]
            elif tok.startswith("*") and tok.endswith("*") and not tok.startswith("**"):
                self.pdf.set_font(self._fnt("body_font"), "", self.t["body_size"])
                line += tok[1:-1]
            elif tok.startswith("`") and tok.endswith("`"):
                self.pdf.set_font("Courier", "", self.t["body_size"] - 1)
                line += tok[1:-1]
            else:
                self.pdf.set_font(self._fnt("body_font"), "", self.t["body_size"])
                line += tok
        self.pdf.multi_cell(self._page_w, self.t["body_size"] * 0.55, line)
        self.pdf.set_font(self._fnt("body_font"), "", self.t["body_size"])
        self.pdf.set_text_color(*self._c("body_color"))

    def add_quote(self, text: str):
        self.pdf.ln(4)
        # 左侧 accent bar
        bar_x = self.margin; bar_w = 3
        start_y = self.pdf.get_y()
        self.pdf.set_fill_color(*self._c("callout_bar"))
        self.pdf.set_draw_color(*self._c("callout_bar"))
        # 背景
        self.pdf.set_fill_color(*self._c("callout_bg"))
        # 先算文本高度
        style = "" if self._cn_font else "I"
        self.pdf.set_font(self._fnt("body_font"), style, self.t["body_size"] - 1)
        self.pdf.set_text_color(*self._c("body_color"))
        self.pdf.set_x(self.margin + bar_w + 4)
        self.pdf.multi_cell(self._page_w - bar_w - 4, (self.t["body_size"] - 1) * 0.5, text)
        end_y = self.pdf.get_y()
        # 画竖线和背景
        self.pdf.set_fill_color(*self._c("callout_bg"))
        self.pdf.rect(self.margin, start_y - 2, self._page_w, end_y - start_y + 4, "F")
        self.pdf.set_fill_color(*self._c("callout_bar"))
        self.pdf.rect(self.margin, start_y - 2, bar_w, end_y - start_y + 4, "F")
        # 重新输出文字
        self.pdf.set_xy(self.margin + bar_w + 6, start_y)
        self.pdf.set_font(self._fnt("body_font"), style, self.t["body_size"] - 1)
        self.pdf.set_text_color(*self._c("body_color"))
        self.pdf.multi_cell(self._page_w - bar_w - 8, (self.t["body_size"] - 1) * 0.5, text)
        self.pdf.ln(2)

    def add_bullet_list(self, items: list[str]):
        for item in items:
            self.pdf.set_font(self._fnt("body_font"), "", self.t["body_size"])
            self.pdf.set_text_color(*self._c("body_color"))
            self.pdf.cell(self._page_w, self.t["body_size"] * 0.5, f"  •  {item}",
                          new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    def add_ordered_list(self, items: list[str]):
        for idx, item in enumerate(items, 1):
            self.pdf.set_font(self._fnt("body_font"), "", self.t["body_size"])
            self.pdf.set_text_color(*self._c("body_color"))
            self.pdf.cell(self._page_w, self.t["body_size"] * 0.5, f"  {idx}. {item}",
                          new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    def add_table(self, headers: list[str], rows: list[list[str]]):
        if not headers: return
        self.pdf.ln(4)
        cols = len(headers)
        col_w = [self._page_w / cols] * cols

        # 表头
        self.pdf.set_fill_color(*self._c("table_header_bg"))
        self.pdf.set_text_color(*self._c("table_header_text"))
        self.pdf.set_font(self._fnt("heading_font"), "B", self.t["body_size"] - 1)
        for j, h in enumerate(headers):
            self.pdf.cell(col_w[j], 8, h, border=1, fill=True, align="C")
        self.pdf.ln()

        # 数据行
        for i, row in enumerate(rows):
            if i % 2 == 1:
                self.pdf.set_fill_color(*self._c("table_stripe"))
            else:
                self.pdf.set_fill_color(255, 255, 255)
            self.pdf.set_text_color(*self._c("body_color"))
            self.pdf.set_font(self._fnt("body_font"), "", self.t["body_size"] - 1)
            for j, val in enumerate(row):
                if j < cols:
                    self.pdf.cell(col_w[j], 7, val[:50], border=1, fill=True,
                                  align="C" if j == 0 else "L")
            self.pdf.ln()
        self.pdf.ln(4)

    def add_hr(self):
        self.pdf.ln(4)
        self.pdf.set_draw_color(*self._c("hr_color"))
        self.pdf.set_line_width(0.2)
        y = self.pdf.get_y()
        self.pdf.line(self.margin + 20, y, self.pdf.w - self.margin - 20, y)
        self.pdf.ln(4)

    # ── 落款 ──

    def add_signature(self):
        sign = self.m.get("signature_unit") or self.m.get("author") or ""
        date_str = self.m.get("signature_date") or self.m.get("date") or ""
        if not sign and not date_str: return
        self.pdf.ln(8)
        self.pdf.set_font(self._fnt("body_font"), "", self.t["body_size"])
        self.pdf.set_text_color(*self._c("body_color"))
        for line in [sign, date_str]:
            if line:
                self.pdf.cell(self._page_w, 7, line, align="R", new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    # ── 目录 ──

    def add_toc(self):
        if not self.t.get("toc") or not self._toc_entries: return
        self.pdf.add_page()
        self.pdf.set_font(self._fnt("heading_font"), "B", self.t["h1_size"])
        self.pdf.set_text_color(*self._c("primary"))
        self.pdf.cell(self._page_w, 10, "目  录", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.pdf.ln(4)
        self.pdf.set_draw_color(*self._c("accent"))
        self.pdf.set_line_width(0.3)
        self.pdf.line(self.margin, self.pdf.get_y(), self.pdf.w - self.margin, self.pdf.get_y())
        self.pdf.ln(6)

        for entry in self._toc_entries:
            indent = (entry["level"] - 1) * 8
            self.pdf.set_x(self.margin + indent)
            self.pdf.set_font(self._fnt("heading_font"),
                              "B" if entry["level"] == 1 else "",
                              self.t["body_size"] if entry["level"] > 1 else self.t["body_size"] + 1)
            self.pdf.set_text_color(*self._c("body_color"))
            self.pdf.cell(self._page_w - indent - 10, 7, entry["text"][:60])
            self.pdf.cell(10, 7, str(entry.get("page", "")), align="R",
                          new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.pdf.add_page()

    # ── 主流程 ──

    def build(self, blocks: list[dict]):
        self.pdf.set_title(self.m.get("title", ""))
        self.pdf.set_author(self.m.get("author", ""))

        # 封面
        self.add_cover()
        if self._has_cover:
            self.pdf.add_page()

        # 无封面时的标题
        if not self._has_cover:
            title = self.m.get("title", "")
            if title:
                self.pdf.set_font(self._fnt("heading_font"), "B", self.t["title_size"])
                self.pdf.set_text_color(*self._c("primary"))
                self.pdf.multi_cell(self._page_w, self.t["title_size"] * 0.55, title, align="C")
                self.pdf.ln(8)
            sub = self.m.get("subtitle", "")
            if sub:
                self.pdf.set_font(self._fnt("body_font"), "", self.t["body_size"] + 2)
                self.pdf.set_text_color(*self._c("muted"))
                self.pdf.multi_cell(self._page_w, 7, sub, align="C")
                self.pdf.ln(8)

        # 正文
        for block in blocks:
            t = block["type"]
            if   t == "heading":      self.add_heading(block["text"], block["level"])
            elif t == "paragraph":    self.add_paragraph(block["text"])
            elif t == "bullet_list":  self.add_bullet_list(block["items"])
            elif t == "ordered_list": self.add_ordered_list(block["items"])
            elif t == "quote":        self.add_quote(block["text"])
            elif t == "table":
                h, r = parse_table(block["raw"])
                self.add_table(h, r)
            elif t == "hr":           self.add_hr()

        self.add_signature()
        # 目录（插在正文后，因为需要页码）
        if self.t.get("toc"):
            self.add_toc()

    def save(self, path: str):
        self.pdf.output(path)


# ═══════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Otto PDF-Toolkit: AI 驱动 PDF 生成引擎")
    parser.add_argument("input", help="输入 Markdown 文件")
    parser.add_argument("output", help="输出 .pdf 文件")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"错误：找不到 {args.input}"); sys.exit(1)

    text = input_path.read_text(encoding="utf-8")
    meta, body = parse_frontmatter(text)
    tokens = parse_tokens(meta)
    if "title" not in meta: meta["title"] = input_path.stem

    blocks = parse_body(body)
    gen = PDFRenderer(tokens, meta)
    gen.build(blocks)

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    gen.save(str(out))

    dn = tokens.get("design_name","")
    dm = tokens.get("design_mood","")
    tag = ""
    if dn: tag += dn
    if dm: tag += (" · " + dm) if tag else dm
    print(f"✅ PDF 已生成：{out}")
    print(f"   视觉语言：{tag}" if tag else f"   视觉语言：自动推断")
    print(f"   大小：{out.stat().st_size / 1024:.1f} KB · {len(blocks)} 块")


if __name__ == "__main__":
    main()
