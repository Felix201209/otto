#!/usr/bin/env python3
"""
Otto Doc-Writer 核心引擎：Markdown + YAML 前设 → 专业 .docx

用法：
  python create_docx.py <input.md> <output.docx> [--preset official|report|letter|meeting|proposal]

输入格式：Markdown 文件，可选 YAML frontmatter 声明元数据。
AI 只需写好 Markdown 正文，其余格式由本脚本 + 模板预设自动处理。

设计原则：
- 零外部二进制依赖（仅需 python-docx）
- 中文优先：中文字体、中文标点、中文排版习惯
- AI友好：输入是纯 Markdown，AI 不需要写任何 Python 代码
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

# Windows 兼容：强制 UTF-8 输出
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

try:
    from docx import Document
    from docx.shared import Cm, Inches, Pt, RGBColor, Emu
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.section import WD_ORIENT
    from docx.oxml.ns import qn, nsdecls
    from docx.oxml import parse_xml
except ImportError:
    print("错误：需要 python-docx 库。请运行： pip install python-docx")
    sys.exit(1)


# ─── 预设模板 ─────────────────────────────────────────────────────────

PRESETS = {
    "official": {
        "name": "公文（红头文件风格）",
        "page": {"width": Cm(21), "height": Cm(29.7), "margin_top": Cm(3.7), "margin_bottom": Cm(3.5),
                 "margin_left": Cm(2.8), "margin_right": Cm(2.6)},
        "fonts": {"title": "方正小标宋简体", "heading": "黑体", "body": "仿宋", "body_size": Pt(16),
                  "title_size": Pt(22), "heading_size": Pt(16)},
        "colors": {"title": "C00000", "heading": "000000", "body": "000000"},
        "title_align": "center",
        "show_header_line": True,   # 标题下方红色分隔线
    },
    "report": {
        "name": "报告（商务汇报风格）",
        "page": {"width": Cm(21), "height": Cm(29.7), "margin_top": Cm(2.54), "margin_bottom": Cm(2.54),
                 "margin_left": Cm(3.18), "margin_right": Cm(3.18)},
        "fonts": {"title": "微软雅黑", "heading": "微软雅黑", "body": "宋体", "body_size": Pt(12),
                  "title_size": Pt(18), "heading_size": Pt(14)},
        "colors": {"title": "1F3864", "heading": "2E75B6", "body": "333333"},
        "title_align": "center",
        "show_toc": True,
    },
    "letter": {
        "name": "信函（商务书信风格）",
        "page": {"width": Cm(21), "height": Cm(29.7), "margin_top": Cm(3), "margin_bottom": Cm(2.5),
                 "margin_left": Cm(3), "margin_right": Cm(3)},
        "fonts": {"title": "宋体", "heading": "宋体", "body": "宋体", "body_size": Pt(12),
                  "title_size": Pt(16), "heading_size": Pt(14)},
        "colors": {"title": "000000", "heading": "000000", "body": "000000"},
        "title_align": "left",
    },
    "meeting": {
        "name": "会议纪要",
        "page": {"width": Cm(21), "height": Cm(29.7), "margin_top": Cm(2.54), "margin_bottom": Cm(2.54),
                 "margin_left": Cm(2.54), "margin_right": Cm(2.54)},
        "fonts": {"title": "黑体", "heading": "黑体", "body": "仿宋", "body_size": Pt(12),
                  "title_size": Pt(18), "heading_size": Pt(14)},
        "colors": {"title": "000000", "heading": "333333", "body": "333333"},
        "title_align": "center",
        "show_meeting_meta": True,  # 会议时间/地点/参会人等
    },
    "proposal": {
        "name": "方案（策划方案风格）",
        "page": {"width": Cm(21), "height": Cm(29.7), "margin_top": Cm(2.54), "margin_bottom": Cm(2.54),
                 "margin_left": Cm(2.54), "margin_right": Cm(2.54)},
        "fonts": {"title": "微软雅黑", "heading": "微软雅黑", "body": "微软雅黑", "body_size": Pt(11),
                  "title_size": Pt(22), "heading_size": Pt(14)},
        "colors": {"title": "2E75B6", "heading": "2E75B6", "body": "333333"},
        "title_align": "center",
        "show_toc": True,
    },
}


# ─── Markdown 解析 ─────────────────────────────────────────────────────

def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """解析 YAML frontmatter，返回 (元数据, 正文)。"""
    meta: dict[str, Any] = {}
    body = text.strip()
    if body.startswith("---"):
        parts = body.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].strip().split("\n"):
                line = line.strip()
                if ":" in line:
                    key, _, val = line.partition(":")
                    meta[key.strip()] = val.strip().strip('"').strip("'")
            body = parts[2].strip()
    return meta, body


def parse_markdown_body(text: str) -> list[dict[str, Any]]:
    """将 Markdown 正文解析为结构化段落列表。"""
    blocks: list[dict[str, Any]] = []
    lines = text.split("\n")
    i = 0
    table_buffer: list[str] = []
    in_table = False

    while i < len(lines):
        line = lines[i]

        # 表格检测
        if line.strip().startswith("|") and line.strip().endswith("|"):
            table_buffer.append(line)
            in_table = True
            i += 1
            continue
        elif in_table:
            # 表格结束，处理缓冲的表格
            blocks.append({"type": "table", "raw": table_buffer})
            table_buffer = []
            in_table = False
            continue

        if not line.strip():
            i += 1
            continue

        # 标题
        m = re.match(r"^(#{1,6})\s+(.+)$", line)
        if m:
            level = len(m.group(1))
            blocks.append({"type": "heading", "level": level, "text": m.group(2).strip()})
            i += 1
            continue

        # 无序列表
        m = re.match(r"^[-*+]\s+(.+)$", line)
        if m:
            items = []
            while i < len(lines) and re.match(r"^[-*+]\s+(.+)$", lines[i]):
                items.append(re.match(r"^[-*+]\s+(.+)$", lines[i]).group(1).strip())
                i += 1
            blocks.append({"type": "bullet_list", "items": items})
            continue

        # 有序列表
        m = re.match(r"^\d+[.)]\s+(.+)$", line)
        if m:
            items = []
            while i < len(lines) and re.match(r"^\d+[.)]\s+(.+)$", lines[i]):
                items.append(re.match(r"^\d+[.)]\s+(.+)$", lines[i]).group(1).strip())
                i += 1
            blocks.append({"type": "ordered_list", "items": items})
            continue

        # 引用
        if line.startswith("> "):
            items = []
            while i < len(lines) and lines[i].startswith("> "):
                items.append(lines[i][2:].strip())
                i += 1
            blocks.append({"type": "quote", "text": "\n".join(items)})
            continue

        # 分割线
        if line.strip() in ("---", "***", "___"):
            blocks.append({"type": "hr"})
            i += 1
            continue

        # 普通段落
        para_lines = []
        while i < len(lines) and lines[i].strip() and not lines[i].startswith("#") and \
              not re.match(r"^[-*+]\s+", lines[i]) and not re.match(r"^\d+[.)]\s+", lines[i]) and \
              not lines[i].startswith("|") and not lines[i].startswith("> ") and \
              lines[i].strip() not in ("---", "***", "___"):
            para_lines.append(lines[i])
            i += 1
        blocks.append({"type": "paragraph", "text": "\n".join(para_lines)})

    # 处理末尾表格
    if table_buffer:
        blocks.append({"type": "table", "raw": table_buffer})

    return blocks


def parse_table(raw: list[str]) -> tuple[list[str], list[list[str]]]:
    """解析 Markdown 表格。"""
    if len(raw) < 2:
        return [], []
    headers = [c.strip() for c in raw[0].strip("|").split("|")]
    rows = []
    for line in raw[1:]:
        line = line.strip()
        if re.match(r"^[\|\-\s:]+$", line):
            continue  # 分隔行
        cells = [c.strip() for c in line.strip("|").split("|")]
        if cells:
            rows.append(cells)
    return headers, rows


# ─── 文档生成 ──────────────────────────────────────────────────────────

class DocxGenerator:
    """专业 Word 文档生成器。"""

    def __init__(self, preset: dict[str, Any], meta: dict[str, Any]):
        self.doc = Document()
        self.p = preset
        self.meta = meta
        self._setup_page()
        self._setup_styles()

    def _setup_page(self):
        """设置页面尺寸与边距。"""
        pg = self.p["page"]
        section = self.doc.sections[0]
        section.page_width = pg["width"]
        section.page_height = pg["height"]
        section.top_margin = pg["margin_top"]
        section.bottom_margin = pg["margin_bottom"]
        section.left_margin = pg["margin_left"]
        section.right_margin = pg["margin_right"]

    def _setup_styles(self):
        """设置默认字体样式。"""
        fonts = self.p["fonts"]
        style = self.doc.styles["Normal"]
        style.font.name = fonts["body"]
        style.font.size = fonts.get("body_size", Pt(12))
        style.font.color.rgb = RGBColor.from_string(self.p["colors"]["body"])
        style.element.rPr.rFonts.set(qn("w:eastAsia"), fonts["body"])
        style.paragraph_format.space_after = Pt(6)
        style.paragraph_format.line_spacing = 1.5

    def _font_color(self, role: str) -> RGBColor:
        return RGBColor.from_string(self.p["colors"].get(role, "000000"))

    def _font_name(self, role: str) -> str:
        return self.p["fonts"].get(role, self.p["fonts"]["body"])

    def _set_run_font(self, run, role: str = "body", bold: bool = False, size: Optional[Pt] = None):
        """设置 run 的字体属性。"""
        font_name = self._font_name(role)
        run.font.name = font_name
        run.font.color.rgb = self._font_color(role)
        run.font.size = size or self.p["fonts"].get("body_size", Pt(12))
        run.bold = bold
        r = run._element
        rPr = r.get_or_add_rPr()
        rFonts = rPr.find(qn("w:rFonts"))
        if rFonts is None:
            rFonts = parse_xml(f'<w:rFonts {nsdecls("w")} />')
            rPr.insert(0, rFonts)
        rFonts.set(qn("w:eastAsia"), font_name)

    def _add_horizontal_line(self, color: str = "C00000", width: int = 12):
        """添加水平分隔线。"""
        p = self.doc.add_paragraph()
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.space_after = Pt(2)
        pPr = p._element.get_or_add_pPr()
        pBdr = parse_xml(
            f'<w:pBdr {nsdecls("w")}>'
            f'<w:bottom w:val="single" w:sz="{width}" w:space="1" w:color="{color}"/>'
            f'</w:pBdr>'
        )
        pPr.append(pBdr)

    # ── 标题处理 ──

    def add_title(self, text: str):
        """添加文档主标题。"""
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER if self.p.get("title_align") == "center" else WD_ALIGN_PARAGRAPH.LEFT
        p.paragraph_format.space_before = Pt(12)
        p.paragraph_format.space_after = Pt(12)
        run = p.add_run(text)
        self._set_run_font(run, "title", bold=True, size=self.p["fonts"].get("title_size", Pt(18)))

        if self.p.get("show_header_line"):
            self._add_horizontal_line()

    def add_subtitle(self, text: str):
        """添加副标题。"""
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(18)
        run = p.add_run(text)
        self._set_run_font(run, "body", size=Pt(14))

    # ── 会议元信息 ──

    def add_meeting_meta(self):
        """添加会议元信息块。"""
        fields = {
            "会议时间": self.meta.get("meeting_time", self.meta.get("date", "")),
            "会议地点": self.meta.get("meeting_location", ""),
            "主持人": self.meta.get("host", ""),
            "记录人": self.meta.get("recorder", ""),
            "参会人员": self.meta.get("attendees", ""),
        }
        active = {k: v for k, v in fields.items() if v}
        if not active:
            return

        for label, value in active.items():
            p = self.doc.add_paragraph()
            p.paragraph_format.space_before = Pt(2)
            p.paragraph_format.space_after = Pt(2)
            run_label = p.add_run(f"{label}：")
            self._set_run_font(run_label, "heading", bold=True)
            run_value = p.add_run(value)
            self._set_run_font(run_value, "body")
        self.doc.add_paragraph()  # 空行

    # ── 正文块处理 ──

    def add_heading(self, text: str, level: int):
        """添加标题。"""
        p = self.doc.add_paragraph()
        p.paragraph_format.space_before = Pt(18 if level <= 2 else 12)
        p.paragraph_format.space_after = Pt(8)
        sizes = {1: Pt(18), 2: Pt(16), 3: Pt(14), 4: Pt(13), 5: Pt(12), 6: Pt(12)}
        run = p.add_run(text)
        self._set_run_font(run, "heading", bold=(level <= 3), size=self.p["fonts"].get("heading_size") or sizes.get(level))

        # Heading 下方细线（Level 1）
        if level == 1 and not self.p.get("show_header_line"):
            pPr = p._element.get_or_add_pPr()
            pBdr = parse_xml(
                f'<w:pBdr {nsdecls("w")}>'
                f'<w:bottom w:val="single" w:sz="4" w:space="4" w:color="2E75B6"/>'
                f'</w:pBdr>'
            )
            pPr.append(pBdr)

    def add_paragraph(self, text: str):
        """添加普通段落（首行缩进两字符）。"""
        p = self.doc.add_paragraph()
        pf = p.paragraph_format
        pf.first_line_indent = Cm(0.74)  # 约两个中文字符
        pf.space_after = Pt(6)

        # 处理行内标记 **粗体** 和 `代码`
        self._add_formatted_text(p, text)

    def add_quote(self, text: str):
        """添加引用块。"""
        p = self.doc.add_paragraph()
        pf = p.paragraph_format
        pf.left_indent = Cm(1.5)
        pf.space_before = Pt(8)
        pf.space_after = Pt(8)

        # 左侧竖线效果
        pPr = p._element.get_or_add_pPr()
        pBdr = parse_xml(
            f'<w:pBdr {nsdecls("w")}>'
            f'<w:left w:val="single" w:sz="12" w:space="8" w:color="999999"/>'
            f'</w:pBdr>'
        )
        pPr.append(pBdr)

        run = p.add_run(text)
        self._set_run_font(run, "body")
        run.italic = True

    def add_bullet_list(self, items: list[str]):
        """添加无序列表。"""
        for item in items:
            p = self.doc.add_paragraph()
            pf = p.paragraph_format
            pf.left_indent = Cm(1)
            pf.first_line_indent = Cm(-0.5)
            pf.space_after = Pt(3)
            run = p.add_run("• " + item)
            self._set_run_font(run, "body")

    def add_ordered_list(self, items: list[str]):
        """添加有序列表。"""
        for idx, item in enumerate(items, 1):
            p = self.doc.add_paragraph()
            pf = p.paragraph_format
            pf.left_indent = Cm(1)
            pf.first_line_indent = Cm(-0.5)
            pf.space_after = Pt(3)
            run = p.add_run(f"{idx}. {item}")
            self._set_run_font(run, "body")

    def add_table(self, headers: list[str], rows: list[list[str]]):
        """添加专业表格。"""
        if not headers:
            return
        cols = len(headers)
        table = self.doc.add_table(rows=1 + len(rows), cols=cols)
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        table.style = "Table Grid"

        # 表头行
        for j, h in enumerate(headers):
            cell = table.rows[0].cells[j]
            cell.text = ""
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = p.add_run(h)
            self._set_run_font(run, "heading", bold=True, size=Pt(11))

            # 表头背景色
            shading = parse_xml(
                f'<w:shd {nsdecls("w")} w:fill="2E75B6" w:val="clear"/>'
            )
            cell._element.get_or_add_tcPr().append(shading)
            run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)

        # 数据行
        for i, row in enumerate(rows):
            for j, val in enumerate(row):
                if j < cols:
                    cell = table.rows[i + 1].cells[j]
                    cell.text = ""
                    p = cell.paragraphs[0]
                    run = p.add_run(val)
                    self._set_run_font(run, "body", size=Pt(10.5))

                    # 交替行背景
                    if i % 2 == 1:
                        shading = parse_xml(
                            f'<w:shd {nsdecls("w")} w:fill="F2F7FB" w:val="clear"/>'
                        )
                        cell._element.get_or_add_tcPr().append(shading)

        self.doc.add_paragraph()  # 表后空行

    def add_hr(self):
        """添加分隔线（装饰性空行）。"""
        self.doc.add_paragraph()

    # ── 签名 / 落款 ──

    def add_signature(self):
        """添加落款。"""
        sign = self.meta.get("signature_unit", "") or self.meta.get("author", "")
        date_str = self.meta.get("signature_date", "") or self.meta.get("date", "") or datetime.now().strftime("%Y年%m月%d日")
        if not sign and not date_str:
            return

        self.doc.add_paragraph()  # 空行
        for line in [sign, date_str]:
            if line:
                p = self.doc.add_paragraph()
                p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
                p.paragraph_format.space_after = Pt(2)
                run = p.add_run(line)
                self._set_run_font(run, "body")

    # ── 行内格式化 ──

    def _add_formatted_text(self, paragraph, text: str):
        """解析行内标记并添加格式化 run。"""
        # 匹配 **粗体**、*斜体*、`代码`
        tokens = re.split(r"(\*\*.+?\*\*|\*.+?\*|`.+?`)", text)
        for tok in tokens:
            if tok.startswith("**") and tok.endswith("**"):
                run = paragraph.add_run(tok[2:-2])
                self._set_run_font(run, "body")
                run.bold = True
            elif tok.startswith("*") and tok.endswith("*") and not tok.startswith("**"):
                run = paragraph.add_run(tok[1:-1])
                self._set_run_font(run, "body")
                run.italic = True
            elif tok.startswith("`") and tok.endswith("`"):
                run = paragraph.add_run(tok[1:-1])
                self._set_run_font(run, "body")
                run.font.name = "Consolas"
            else:
                run = paragraph.add_run(tok)
                self._set_run_font(run, "body")

    # ── 页眉页脚 ──

    def add_header_footer(self):
        """添加页眉与页码。"""
        title = self.meta.get("title", "")
        section = self.doc.sections[0]

        # 页眉
        header = section.header
        header.is_linked_to_previous = False
        hp = header.paragraphs[0]
        hp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = hp.add_run(title if title else "")
        self._set_run_font(run, "body", size=Pt(9))
        run.font.color.rgb = RGBColor(0x99, 0x99, 0x99)

        # 页脚页码
        footer = section.footer
        footer.is_linked_to_previous = False
        fp = footer.paragraphs[0]
        fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = fp.add_run("— ")
        self._set_run_font(run, "body", size=Pt(9))
        run.font.color.rgb = RGBColor(0x99, 0x99, 0x99)

        # 插入页码域
        fldChar1 = parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="begin"/>')
        run1 = fp.add_run()
        run1._element.append(fldChar1)
        instrText = parse_xml(f'<w:instrText {nsdecls("w")} xml:space="preserve"> PAGE </w:instrText>')
        run2 = fp.add_run()
        run2._element.append(instrText)
        fldChar2 = parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="end"/>')
        run3 = fp.add_run()
        run3._element.append(fldChar2)

        run_end = fp.add_run(" —")
        self._set_run_font(run_end, "body", size=Pt(9))
        run_end.font.color.rgb = RGBColor(0x99, 0x99, 0x99)

    # ── 文档信息 ──

    def set_doc_properties(self):
        """设置文档属性。"""
        self.doc.core_properties.title = self.meta.get("title", "")
        self.doc.core_properties.author = self.meta.get("author", "")
        self.doc.core_properties.subject = self.meta.get("subject", "")

    # ── 主流程 ──

    def build(self, blocks: list[dict[str, Any]]):
        """根据结构化块列表构建完整文档。"""
        self.set_doc_properties()

        # 标题
        title = self.meta.get("title", "")
        if title:
            self.add_title(title)

        # 副标题
        subtitle = self.meta.get("subtitle", "")
        if subtitle:
            self.add_subtitle(subtitle)

        # 会议元信息
        if self.p.get("show_meeting_meta"):
            self.add_meeting_meta()

        # 正文块
        for block in blocks:
            btype = block["type"]

            if btype == "heading":
                self.add_heading(block["text"], block["level"])
            elif btype == "paragraph":
                self.add_paragraph(block["text"])
            elif btype == "bullet_list":
                self.add_bullet_list(block["items"])
            elif btype == "ordered_list":
                self.add_ordered_list(block["items"])
            elif btype == "quote":
                self.add_quote(block["text"])
            elif btype == "table":
                headers, rows = parse_table(block["raw"])
                self.add_table(headers, rows)
            elif btype == "hr":
                self.add_hr()

        # 落款
        self.add_signature()

        # 页眉页脚
        self.add_header_footer()

    def save(self, path: str):
        self.doc.save(path)


# ─── CLI ───────────────────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser(
        description="Otto Doc-Writer: Markdown + 预设 → 专业 .docx",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
预设: official(公文) | report(报告) | letter(信函) | meeting(会议纪要) | proposal(方案)
输入: Markdown 文件（可选 YAML frontmatter）

示例:
  python create_docx.py input.md output.docx --preset official
  python create_docx.py input.md output.docx --preset report
        """,
    )
    parser.add_argument("input", help="输入 Markdown 文件路径")
    parser.add_argument("output", help="输出 .docx 文件路径")
    parser.add_argument("--preset", "-p", default="official",
                        choices=["official", "report", "letter", "meeting", "proposal"],
                        help="文档预设模板 (默认: official)")
    args = parser.parse_args()

    # 读取输入
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"错误：找不到输入文件 {args.input}")
        sys.exit(1)

    text = input_path.read_text(encoding="utf-8")
    meta, body = parse_frontmatter(text)

    # 从 frontmatter 合并预设类型
    if "preset" in meta and not args.preset:
        args.preset = meta["preset"]
    if meta.get("author"):
        meta.setdefault("author", meta["author"])

    # 如果没有标题，从文件名推断
    if "title" not in meta:
        meta["title"] = input_path.stem

    preset = PRESETS.get(args.preset, PRESETS["official"])
    blocks = parse_markdown_body(body)

    # 生成文档
    gen = DocxGenerator(preset, meta)
    gen.build(blocks)

    # 保存
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    gen.save(str(output_path))

    size_kb = output_path.stat().st_size / 1024
    print(f"✅ 文档已生成：{output_path}")
    print(f"   预设：{preset['name']}")
    print(f"   大小：{size_kb:.1f} KB")
    print(f"   段落块：{len(blocks)} 个")


if __name__ == "__main__":
    main()
