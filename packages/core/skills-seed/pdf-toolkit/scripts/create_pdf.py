#!/usr/bin/env python3
"""
Otto PDF-Toolkit v4 — 视觉母题驱动 PDF 生成引擎

对标 ppt-creator：AI 创造视觉母题 → 引擎将其转化为封面、章节页、
正文排版、引用块、表格的多种视觉形态。

用法：python create_pdf.py <input.md> <output.pdf>

AI 在 YAML frontmatter 声明 theme/base/accent/atmosphere，引擎渲染。
"""
from __future__ import annotations
import re, sys, json, os
from datetime import datetime
from pathlib import Path
from typing import Any

if sys.platform == 'win32':
    try: sys.stdout.reconfigure(encoding='utf-8')
    except Exception: pass

try:
    from fpdf import FPDF
except ImportError:
    print("pip install fpdf2 pypdf"); sys.exit(1)


# ═══════════════════════════════════════════════════════════════════════
# 色彩工具 + 视觉母题解析
# ═══════════════════════════════════════════════════════════════════════

def _hrgb(h): h=h.lstrip("#"); return tuple(int(h[i:i+2],16) for i in(0,2,4))
def _hex(r,g,b): return f"{max(0,min(255,int(r))):02X}{max(0,min(255,int(g))):02X}{max(0,min(255,int(b))):02X}"
def _light(h, a):
    r,g,b=_hrgb(h); return _hex(r+(255-r)*a, g+(255-g)*a, b+(255-b)*a)
def _blend(c1,c2,r):
    r1,g1,b1=_hrgb(c1); r2,g2,b2=_hrgb(c2)
    return _hex(r1*(1-r)+r2*r, g1*(1-r)+g2*r, b1*(1-r)+b2*r)

def resolve_theme(meta: dict) -> dict:
    t = {}
    t["theme_name"] = meta.get("theme", "Undefined")
    t["atmosphere"] = meta.get("atmosphere", "")
    t["base"]    = meta.get("base",    "0A1628")
    t["accent"]  = meta.get("accent",  "2D7DD2")
    t["surface"] = meta.get("surface", "F5F7FA")
    t["body"]    = _light(t["base"], 0.82) if _hrgb(t["base"])[0] < 50 else "333333"
    t["muted"]   = _light(t["base"], 0.55)
    t["cover_bg"] = t["base"]
    t["cover_text"] = "FFFFFF"
    t["table_hdr"] = t["base"]
    t["table_text"] = "FFFFFF"
    t["stripe"]   = t["surface"]
    t["callout_bg"] = _blend(t["surface"], t["accent"], 0.06)
    t["callout_bar"] = t["accent"]
    t["hr"] = _light(t["base"], 0.8)
    t["h_font"] = meta.get("heading_font", "Helvetica")
    t["b_font"] = meta.get("body_font", "Helvetica")
    t["title_sz"] = int(meta.get("title_size", "26"))
    t["h1_sz"] = int(meta.get("h1_size", "16"))
    t["h2_sz"] = int(meta.get("h2_size", "13"))
    t["body_sz"] = int(meta.get("body_size", "11"))
    t["cover"] = meta.get("cover","true")!="false"
    t["toc"]   = meta.get("toc","true")=="true"
    t["margin"] = float(meta.get("margin","25"))
    return t

def _rgb(h): return _hrgb(h)


# ═══════════════════════════════════════════════════════════════════════
# Markdown 解析
# ═══════════════════════════════════════════════════════════════════════

def parse_md(text: str) -> tuple[dict, list[dict]]:
    meta={}; body=text.strip()
    if body.startswith("---"):
        parts=body.split("---",2)
        if len(parts)>=3:
            for line in parts[1].strip().split("\n"):
                line=line.strip()
                if ":" in line and not line.startswith("#"):
                    k,_,v=line.partition(":"); meta[k.strip()]=v.strip().strip('"').strip("'")
            body=parts[2].strip()

    lines=body.split("\n"); i=0
    secs=[]; cur={"heading":"","blocks":[]}
    def save():
        if cur["blocks"]: secs.append(cur.copy())

    tbl=[]; in_t=False
    while i<len(lines):
        line=lines[i]
        if line.strip().startswith("|") and line.strip().endswith("|"):
            tbl.append(line); in_t=True; i+=1; continue
        elif in_t:
            h,rows=_ptbl(tbl)
            if h: cur["blocks"].append({"type":"table","h":h,"r":rows})
            tbl=[]; in_t=False; continue
        if not line.strip(): i+=1; continue

        m=re.match(r"^(#{2})\s+(.+)$",line)
        if m: save(); cur={"heading":m.group(2).strip(),"blocks":[]}; i+=1; continue

        m=re.match(r"^(#{3,6})\s+(.+)$",line)
        if m:
            cur["blocks"].append({"type":"subheading","level":len(m.group(1)),"text":m.group(2).strip()})
            i+=1; continue

        m=re.match(r"^[-*+]\s+(.+)$",line)
        if m:
            items=[]
            while i<len(lines) and re.match(r"^[-*+]\s+(.+)$",lines[i]):
                items.append(re.match(r"^[-*+]\s+(.+)$",lines[i]).group(1).strip()); i+=1
            cur["blocks"].append({"type":"bullet","items":items}); continue

        m=re.match(r"^\d+[.)]\s+(.+)$",line)
        if m:
            items=[]
            while i<len(lines) and re.match(r"^\d+[.)]\s+(.+)$",lines[i]):
                items.append(re.match(r"^\d+[.)]\s+(.+)$",lines[i]).group(1).strip()); i+=1
            cur["blocks"].append({"type":"ordered","items":items}); continue

        if line.startswith("> "):
            q=[]
            while i<len(lines) and lines[i].startswith("> "):
                q.append(lines[i][2:].strip()); i+=1
            cur["blocks"].append({"type":"quote","text":" ".join(q)}); continue

        if line.strip() in ("---","***","___"):
            cur["blocks"].append({"type":"hr"}); i+=1; continue

        p=[]
        while i<len(lines) and lines[i].strip() and not lines[i].startswith("#") and \
              not re.match(r"^[-*+]\s+",lines[i]) and not re.match(r"^\d+[.)]\s+",lines[i]) and \
              not lines[i].startswith("|") and not lines[i].startswith("> ") and \
              lines[i].strip() not in ("---","***","___"):
            p.append(lines[i]); i+=1
        cur["blocks"].append({"type":"para","text":"\n".join(p)})
    if tbl:
        h,rows=_ptbl(tbl)
        if h: cur["blocks"].append({"type":"table","h":h,"r":rows})
    save()
    return meta, secs

def _ptbl(raw):
    if len(raw)<2: return [],[]
    h=[c.strip() for c in raw[0].strip("|").split("|")]
    rows=[]
    for line in raw[1:]:
        if re.match(r"^[\|\-\s:]+$",line.strip()): continue
        cells=[c.strip() for c in line.strip("|").split("|")]
        if cells: rows.append(cells)
    return h, rows


# ═══════════════════════════════════════════════════════════════════════
# PDF 渲染器 v4
# ═══════════════════════════════════════════════════════════════════════

class PDFRenderer:
    def __init__(self, t: dict, meta: dict):
        self.t=t; self.m=meta
        self.pdf=FPDF(unit="mm", format="A4")
        self.pdf.set_auto_page_break(True, t["margin"])
        self.mg=t["margin"]; self._has_cover=False
        self._toc=[]; self._chap=0; self._pgw=self.pdf.w-2*self.mg
        self._cn=None
        self._fonts()

    def _fonts(self):
        paths=["C:/Windows/Fonts/msyh.ttc","C:/Windows/Fonts/simsun.ttc",
               "C:/Windows/Fonts/simhei.ttf","/System/Library/Fonts/PingFang.ttc",
               "/System/Library/Fonts/STHeiti Light.ttc",
               "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"]
        for p in paths:
            if os.path.exists(p):
                try: self.pdf.add_font("CN","",p); self.pdf.add_font("CN","B",p); self._cn="CN"; return
                except: pass

    def _c(self,k): return _rgb(self.t[k])
    def _f(self,role,bold=False):
        if role=="title":
            f=self.t["h_font"]; sz=self.t["title_sz"]
        elif role in ("h1","h2","body"):
            f=self.t["h_font"] if role in ("h1","h2") else self.t["b_font"]
            sz=self.t[role+"_sz"]
        else:
            f=self.t["b_font"]; sz=self.t["body_sz"]
        if self._cn: f=self._cn
        self.pdf.set_font(f,"B" if bold else "",sz)
        return sz

    def _header(self):
        if self._has_cover and self.pdf.page==1: return
        self.pdf.set_font(self._cn or "Helvetica","",7)
        self.pdf.set_text_color(*_rgb(self.t["muted"]))
        self.pdf.cell(self._pgw,3,self.m.get("title","")[:45],align="L")
        self.pdf.ln(3)
        self.pdf.set_draw_color(*_rgb(self.t["accent"]))
        self.pdf.set_line_width(0.2)
        self.pdf.line(self.mg,self.pdf.get_y(),self.pdf.w-self.mg,self.pdf.get_y())
        self.pdf.ln(4)

    def _footer(self):
        if self._has_cover and self.pdf.page==1: return
        self.pdf.set_y(-self.mg+4)
        self.pdf.set_draw_color(*_rgb(self.t["hr"]))
        self.pdf.set_line_width(0.15)
        self.pdf.line(self.mg,self.pdf.get_y(),self.pdf.w-self.mg,self.pdf.get_y())
        self.pdf.set_font(self._cn or "Helvetica","",7)
        self.pdf.set_text_color(*_rgb(self.t["muted"]))
        self.pdf.cell(self._pgw,4,f"— {self.pdf.page_no()} —",align="C")

    def cover(self):
        if not self.t["cover"]: return
        self._has_cover=True
        title=self.m.get("title",""); sub=self.m.get("subtitle","")
        author=self.m.get("author","")
        ds=self.m.get("date","") or datetime.now().strftime("%Y年%m月")

        self.pdf.add_page()
        w=self.pdf.w; h=self.pdf.h
        base=_rgb(self.t["cover_bg"])

        # 顶部色块
        self.pdf.set_fill_color(*base)
        self.pdf.rect(0,0,w,h*0.4,"F")

        # 装饰性线条
        self.pdf.set_draw_color(*_rgb(self.t["accent"]))
        self.pdf.set_line_width(0.6)
        self.pdf.line(self.mg,h*0.4+6,w-self.mg,h*0.4+6)

        # 标题
        self.pdf.set_y(h*0.4+18)
        sz=self._f("title",True)
        self.pdf.set_text_color(*_rgb(self.t["base"]))
        self.pdf.multi_cell(self._pgw,sz*0.55,title,align="C")

        if sub:
            self.pdf.ln(6)
            self.pdf.set_font(self._cn or "Helvetica","",self.t["body_sz"]+2)
            self.pdf.set_text_color(*_rgb(self.t["body"]))
            self.pdf.multi_cell(self._pgw,7,sub,align="C")

        self.pdf.ln(14)
        self.pdf.set_font(self._cn or "Helvetica","",self.t["body_sz"])
        self.pdf.set_text_color(*_rgb(self.t["muted"]))
        meta_items=[x for x in [author,ds,self.m.get("department")] if x]
        self.pdf.cell(self._pgw,6," · ".join(meta_items),align="C")
        self.pdf.add_page()

    def chapter_opener(self, title: str):
        """章节过渡页：大数字 + accent 线 + 标题。"""
        self._chap+=1
        self.pdf.add_page()
        self.pdf.set_fill_color(*_rgb(self.t["base"]))
        self.pdf.rect(0,0,self.pdf.w,self.pdf.h*0.18,"F")
        self.pdf.set_y(self.pdf.h*0.18+10)
        self.pdf.set_font(self._cn or "Helvetica","B",40)
        self.pdf.set_text_color(*_rgb(self.t["accent"]))
        n=str(self._chap).zfill(2)
        self.pdf.cell(self._pgw,14,n,align="L")
        self.pdf.ln(16)
        self.pdf.set_draw_color(*_rgb(self.t["accent"]))
        self.pdf.set_line_width(1.2)
        self.pdf.line(self.mg,self.pdf.get_y(),self.pdf.w-self.mg,self.pdf.get_y())
        self.pdf.ln(10)
        self._f("h1",True)
        self.pdf.set_text_color(*_rgb(self.t["base"]))
        self.pdf.multi_cell(self._pgw,10,title,align="L")
        self.pdf.add_page()

    def subheading(self, text:str, level:int):
        sz = self.t["h1_sz"] if level<=3 else self.t["h2_sz"]
        self.pdf.ln(6 if level>3 else 4)
        self._f("h1" if level<=3 else "h2", level<=3)
        self.pdf.set_text_color(*_rgb(self.t["base"] if level<=3 else self.t["body"]))
        self.pdf.cell(self._pgw,sz*0.55,text,new_x="LMARGIN",new_y="NEXT")
        if level<=3:
            self.pdf.set_draw_color(*_rgb(self.t["accent"]))
            self.pdf.set_line_width(0.3)
            self.pdf.line(self.mg,self.pdf.get_y()+1,self.pdf.w-self.mg,self.pdf.get_y()+1)
            self.pdf.ln(4)
        self._toc.append({"level":1 if level<=3 else 2,"text":text,"page":self.pdf.page})

    def para(self, text:str):
        self.pdf.ln(2)
        self._f("body")
        self.pdf.set_text_color(*_rgb(self.t["body"]))
        parts=re.split(r"(\*\*.+?\*\*|\*.+?\*|`.+?`)",text)
        line=""
        for tok in parts:
            if tok.startswith("**") and tok.endswith("**"):
                self.pdf.set_font(self._cn or "Helvetica","B",self.t["body_sz"]); line+=tok[2:-2]
            elif tok.startswith("*") and tok.endswith("*") and not tok.startswith("**"):
                self.pdf.set_font(self._cn or "Helvetica","",self.t["body_sz"]); line+=tok[1:-1]
            elif tok.startswith("`") and tok.endswith("`"):
                self.pdf.set_font("Courier","",self.t["body_sz"]-1); line+=tok[1:-1]
            else:
                self.pdf.set_font(self._cn or "Helvetica","",self.t["body_sz"]); line+=tok
        self.pdf.multi_cell(self._pgw,self.t["body_sz"]*0.55,line)

    def bullet(self, items:list):
        for item in items:
            self.pdf.set_font(self._cn or "Helvetica","",self.t["body_sz"])
            self.pdf.set_text_color(*_rgb(self.t["body"]))
            self.pdf.cell(self._pgw,self.t["body_sz"]*0.5,f"  •  {item}",new_x="LMARGIN",new_y="NEXT")

    def ordered(self, items:list):
        for idx,item in enumerate(items,1):
            self.pdf.set_font(self._cn or "Helvetica","",self.t["body_sz"])
            self.pdf.set_text_color(*_rgb(self.t["body"]))
            self.pdf.cell(self._pgw,self.t["body_sz"]*0.5,f"  {idx}. {item}",new_x="LMARGIN",new_y="NEXT")

    def quote(self, text:str):
        self.pdf.ln(4)
        sy=self.pdf.get_y(); bar_w=3
        self._f("body")
        self.pdf.set_text_color(*_rgb(self.t["body"]))
        self.pdf.set_x(self.mg+bar_w+4)
        self.pdf.multi_cell(self._pgw-bar_w-4, (self.t["body_sz"]-1)*0.5, text)
        ey=self.pdf.get_y()
        self.pdf.set_fill_color(*_rgb(self.t["callout_bg"]))
        self.pdf.rect(self.mg,sy-2,self._pgw,ey-sy+4,"F")
        self.pdf.set_fill_color(*_rgb(self.t["callout_bar"]))
        self.pdf.rect(self.mg,sy-2,bar_w,ey-sy+4,"F")
        self.pdf.set_xy(self.mg+bar_w+6,sy)
        self._f("body")
        self.pdf.set_text_color(*_rgb(self.t["body"]))
        self.pdf.multi_cell(self._pgw-bar_w-8, (self.t["body_sz"]-1)*0.5, text)
        self.pdf.ln(2)

    def table(self, hdrs:list, rows:list):
        if not hdrs: return
        self.pdf.ln(4); cols=len(hdrs)
        cw=[self._pgw/cols]*cols

        self.pdf.set_fill_color(*_rgb(self.t["table_hdr"]))
        self.pdf.set_text_color(*_rgb(self.t["table_text"]))
        self.pdf.set_font(self._cn or "Helvetica","B",self.t["body_sz"]-1)
        for j,h in enumerate(hdrs):
            self.pdf.cell(cw[j],8,h,border=1,fill=True,align="C")
        self.pdf.ln()

        for i,row in enumerate(rows):
            self.pdf.set_fill_color(*_rgb(self.t["stripe"]) if i%2==1 else (255,255,255))
            self.pdf.set_text_color(*_rgb(self.t["body"]))
            self.pdf.set_font(self._cn or "Helvetica","",self.t["body_sz"]-1)
            for j,val in enumerate(row):
                if j<cols: self.pdf.cell(cw[j],7,str(val)[:50],border=1,fill=True,align="C" if j==0 else "L")
            self.pdf.ln()
        self.pdf.ln(4)

    def toc_page(self):
        if not self.t["toc"] or not self._toc: return
        self.pdf.add_page()
        self._f("h1",True)
        self.pdf.set_text_color(*_rgb(self.t["base"]))
        self.pdf.cell(self._pgw,10,"目  录",new_x="LMARGIN",new_y="NEXT")
        self.pdf.ln(4)
        self.pdf.set_draw_color(*_rgb(self.t["accent"]))
        self.pdf.set_line_width(0.3)
        self.pdf.line(self.mg,self.pdf.get_y(),self.pdf.w-self.mg,self.pdf.get_y())
        self.pdf.ln(6)
        for e in self._toc:
            self.pdf.set_x(self.mg+(e["level"]-1)*8)
            self.pdf.set_font(self._cn or "Helvetica","B" if e["level"]==1 else "",self.t["body_sz"]+(1 if e["level"]==1 else 0))
            self.pdf.set_text_color(*_rgb(self.t["body"]))
            self.pdf.cell(self._pgw-(e["level"]-1)*8-10,7,e["text"][:60])
            self.pdf.cell(10,7,str(e.get("page","")),align="R",new_x="LMARGIN",new_y="NEXT")
        self.pdf.add_page()

    def signature(self):
        s=self.m.get("signature_unit") or self.m.get("author") or ""
        d=self.m.get("signature_date") or self.m.get("date") or ""
        if not s and not d: return
        self.pdf.ln(8)
        self._f("body"); self.pdf.set_text_color(*_rgb(self.t["body"]))
        for line in [s,d]:
            if line: self.pdf.cell(self._pgw,7,line,align="R",new_x="LMARGIN",new_y="NEXT")

    def build(self, secs:list):
        self.pdf.set_title(self.m.get("title",""))
        self.pdf.set_author(self.m.get("author",""))
        # header/footer callback
        self.pdf.header = lambda: self._header()
        self.pdf.footer = lambda: self._footer()

        self.cover()
        if not self._has_cover:
            title=self.m.get("title","")
            if title:
                self.pdf.add_page()
                self._f("title",True)
                self.pdf.set_text_color(*_rgb(self.t["base"]))
                self.pdf.multi_cell(self._pgw,self.t["title_sz"]*0.55,title,align="C")
                self.pdf.ln(8)
                self.pdf.set_draw_color(*_rgb(self.t["accent"]))
                self.pdf.set_line_width(0.5)
                self.pdf.line(self.pdf.w/2-30,self.pdf.get_y(),self.pdf.w/2+30,self.pdf.get_y())
                self.pdf.ln(12)

        self.toc_page()

        for sec in secs:
            if sec.get("heading"): self.chapter_opener(sec["heading"])
            for blk in sec.get("blocks",[]):
                t=blk["type"]
                if   t=="subheading": self.subheading(blk["text"],blk["level"])
                elif t=="para":       self.para(blk["text"])
                elif t=="bullet":     self.bullet(blk["items"])
                elif t=="ordered":    self.ordered(blk["items"])
                elif t=="quote":      self.quote(blk["text"])
                elif t=="table":      self.table(blk["h"],blk["r"])
                elif t=="hr":
                    self.pdf.ln(4)
                    self.pdf.set_draw_color(*_rgb(self.t["hr"]))
                    self.pdf.set_line_width(0.2)
                    y=self.pdf.get_y()
                    self.pdf.line(self.mg+20,y,self.pdf.w-self.mg-20,y)
                    self.pdf.ln(4)

        self.signature()
        # TOC after body for page numbers
        if self.t["toc"] and not self._toc:
            pass  # toc already rendered before

    def save(self,p): self.pdf.output(p)


# ═══════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════

def main():
    import argparse
    p=argparse.ArgumentParser(description="Otto PDF-Toolkit v4")
    p.add_argument("input"); p.add_argument("output")
    a=p.parse_args()
    ip=Path(a.input)
    if not ip.exists(): print(f"找不到 {a.input}"); sys.exit(1)
    text=ip.read_text(encoding="utf-8")
    meta,secs=parse_md(text)
    t=resolve_theme(meta)
    if "title" not in meta: meta["title"]=ip.stem
    gen=PDFRenderer(t,meta)
    gen.build(secs)
    op=Path(a.output); op.parent.mkdir(parents=True,exist_ok=True)
    gen.save(str(op))
    print(f"✅ {op}")
    print(f"   视觉母题：{t['theme_name']}"+(f" · {t['atmosphere']}" if t['atmosphere'] else ""))
    print(f"   大小：{op.stat().st_size/1024:.1f}KB · {len(secs)}章")

if __name__=="__main__": main()
