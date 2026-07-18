#!/usr/bin/env python3
"""Otto Spreadsheet-Pro v5 — 零空白紧凑专业表格。python create_xlsx.py in.md out.xlsx"""
from __future__ import annotations
import re, sys
from datetime import datetime
from pathlib import Path

if sys.platform == 'win32':
    try: sys.stdout.reconfigure(encoding='utf-8')
    except: pass

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
except ImportError:
    print("pip install openpyxl"); sys.exit(1)


def _rgb(h): h = h.lstrip("#"); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
def _hex(r, g, b): return f"{max(0, min(255, int(r))):02X}{max(0, min(255, int(g))):02X}{max(0, min(255, int(b))):02X}"
def _light(h, a):
    r, g, b = _rgb(h); return _hex(r + (255 - r) * a, g + (255 - g) * a, b + (255 - b) * a)

def resolve_theme(meta: dict) -> dict:
    base = meta.get("base", "0A1628"); accent = meta.get("accent", "2D7DD2"); surface = meta.get("surface", "F0F4F8")
    return {
        "theme": meta.get("theme", ""), "atmo": meta.get("atmosphere", ""),
        "base": base, "accent": accent, "surface": surface,
        "body": _light(base, 0.85) if _rgb(base)[0] < 60 else "333333",
        "muted": _light(base, 0.55),
        "hdr_bg": base, "hdr_text": "FFFFFF", "stripe": surface,
        "border": "D0D5DD", "neg": "DC3545", "pos": "28A745",
        "h_font": meta.get("heading_font", "Microsoft YaHei"),
        "b_font": meta.get("body_font", "Microsoft YaHei"),
        "t_sz": int(float(meta.get("title_size", "12"))),
        "hd_sz": int(float(meta.get("header_size", "10.5"))),
        "b_sz": int(float(meta.get("body_size", "10"))),
    }


def parse_md(text: str) -> tuple[dict, list[dict]]:
    meta = {}; body = text.strip()
    if body.startswith("---"):
        parts = body.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].strip().split("\n"):
                if ":" in line and not line.startswith("#"):
                    k, _, v = line.partition(":"); meta[k.strip()] = v.strip().strip('"').strip("'")
            body = parts[2].strip()

    lines = body.split("\n"); i = 0
    sheets = []; cur = {"name": "Sheet1", "blocks": [], "rows": []}
    def save():
        if cur["blocks"] or cur["rows"]: sheets.append(cur.copy())

    tbl = []; in_t = False
    while i < len(lines):
        line = lines[i]
        if line.strip().startswith("|") and line.strip().endswith("|"):
            tbl.append(line); in_t = True; i += 1; continue
        elif in_t:
            h, r = _ptbl(tbl)
            if h: cur["rows"] = [h] + r
            tbl = []; in_t = False; continue
        if not line.strip(): i += 1; continue

        m = re.match(r"^(#{1,2})\s+(.+)$", line)
        if m: save(); cur = {"name": m.group(2).strip()[:31], "blocks": [], "rows": []}; i += 1; continue

        cur["blocks"].append({"type": "text", "text": line.strip()})
        i += 1
    if tbl:
        h, r = _ptbl(tbl)
        if h: cur["rows"] = [h] + r
    save()
    return meta, sheets

def _ptbl(raw):
    if len(raw) < 2: return [], []
    h = [c.strip() for c in raw[0].strip("|").split("|")]
    rows = []
    for line in raw[1:]:
        if re.match(r"^[\|\-\s:]+$", line.strip()): continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if cells: rows.append(cells)
    return h, rows


class Renderer:
    def __init__(self, t: dict, meta: dict):
        self.t = t; self.m = meta; self.wb = Workbook(); self._first = True
        self._f = None; self._hf = None; self._hf_fill = None; self._bf = None
        self._sf = None; self._border = None; self._center = None; self._left = None
        self._pos_f = None; self._neg_f = None; self._title_f = None; self._title_fill = None
        self._styles()

    def _hex(self, k): return self.t[k]

    def _styles(self):
        self._hf = Font(name=self.t["h_font"], size=self.t["hd_sz"], bold=True, color=self._hex("hdr_text"))
        self._hf_fill = PatternFill(start_color=self._hex("hdr_bg"), end_color=self._hex("hdr_bg"), fill_type="solid")
        self._bf = Font(name=self.t["b_font"], size=self.t["b_sz"], color=self._hex("body"))
        self._sf = PatternFill(start_color=self._hex("stripe"), end_color=self._hex("stripe"), fill_type="solid")
        self._title_f = Font(name=self.t["h_font"], size=self.t["t_sz"], bold=True, color=self._hex("hdr_text"))
        self._title_fill = PatternFill(start_color=self._hex("base"), end_color=self._hex("base"), fill_type="solid")
        self._border = Border(
            left=Side(style="thin", color=self._hex("border")),
            right=Side(style="thin", color=self._hex("border")),
            top=Side(style="thin", color=self._hex("border")),
            bottom=Side(style="thin", color=self._hex("border")))
        self._center = Alignment(horizontal="center", vertical="center", wrap_text=True)
        self._left = Alignment(horizontal="left", vertical="center", wrap_text=True)
        self._pos_f = Font(name=self.t["b_font"], size=self.t["b_sz"], color=self._hex("pos"))
        self._neg_f = Font(name=self.t["b_font"], size=self.t["b_sz"], color=self._hex("neg"))

    def _sheet(self, name: str):
        if self._first:
            ws = self.wb.active; ws.title = name; self._first = False
        else:
            ws = self.wb.create_sheet(title=name)
        ws.sheet_properties.tabColor = self._hex("accent")
        return ws

    def _col_width(self, ws, rows, cols):
        """CJK 感知列宽：中文字符约等于2个Latin字符宽度。"""
        for j in range(cols):
            max_w = 0
            for row in rows:
                if j < len(row):
                    val = str(row[j])
                    # CJK 字符宽度约 = len(val) * 2 + 0.1 per Latin
                    w = sum(2.1 if ord(c) > 127 else 1.1 for c in val)
                    max_w = max(max_w, w)
            ws.column_dimensions[get_column_letter(j + 1)].width = min(max_w + 3, 45)

    def build(self, sheets: list):
        title = self.m.get("title", "")

        for si, sheet in enumerate(sheets):
            ws = self._sheet(sheet["name"])

            # 标题栏（仅第一页）
            if title and si == 0:
                ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=10)
                c = ws.cell(1, 1, value=title)
                c.font = self._title_f; c.fill = self._title_fill; c.alignment = self._center
                ws.row_dimensions[1].height = 26
                sr = 2
            else:
                sr = 1

            r = sr
            rows = sheet.get("rows", [])
            if not rows: continue

            # 文本说明（简洁，不空行）
            for blk in sheet.get("blocks", []):
                c = ws.cell(r, 1, value=blk["text"][:80])
                c.font = Font(name=self.t["b_font"], size=self.t["b_sz"] - 1, color=self._hex("muted"), italic=True)
                r += 1

            # 表头
            for j, h in enumerate(rows[0]):
                c = ws.cell(r, j + 1, value=h)
                c.font = self._hf; c.fill = self._hf_fill
                c.alignment = self._center; c.border = self._border
            ws.row_dimensions[r].height = 20; r += 1

            # 数据
            for i, row in enumerate(rows[1:]):
                for j, val in enumerate(row):
                    c = ws.cell(r + i, j + 1, value=val)
                    c.font = self._bf; c.border = self._border; c.alignment = self._left
                    # 数值着色
                    if val and isinstance(val, str) and re.match(r"^[\-\+]?[\d,.]+%?$", val.strip()):
                        c.alignment = self._center
                        v = val.strip()
                        if v.startswith("-"): c.font = self._neg_f
                        elif v.startswith("+") or (v.endswith("%") and re.match(r"^\d+", v) and int(re.match(r"^\d+", v).group()) > 0):
                            c.font = self._pos_f
                    if i % 2 == 1: c.fill = self._sf
                ws.row_dimensions[r + i].height = 18

            self._col_width(ws, rows, len(rows[0]))
            if rows: ws.freeze_panes = ws.cell(sr, 1)

    def save(self, p): self.wb.save(p)


def main():
    import argparse
    p = argparse.ArgumentParser(description="Otto Spreadsheet-Pro v5")
    p.add_argument("input"); p.add_argument("output")
    a = p.parse_args()
    ip = Path(a.input)
    if not ip.exists(): print(f"找不到 {a.input}"); sys.exit(1)
    meta, sheets = parse_md(ip.read_text(encoding="utf-8"))
    t = resolve_theme(meta)
    if "title" not in meta: meta["title"] = ip.stem
    gen = Renderer(t, meta); gen.build(sheets)
    op = Path(a.output); op.parent.mkdir(parents=True, exist_ok=True)
    gen.save(str(op))
    print(f"✅ {op.name}  {op.stat().st_size/1024:.0f}KB  {len(sheets)}sheets")

if __name__ == "__main__": main()
