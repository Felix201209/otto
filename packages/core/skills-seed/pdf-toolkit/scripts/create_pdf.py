#!/usr/bin/env python3
"""Otto PDF-Toolkit v10 — 白底专业排版。python create_pdf.py in.md out.pdf"""
from __future__ import annotations
import re, sys, os
from datetime import datetime
from pathlib import Path

if sys.platform == 'win32':
    try: sys.stdout.reconfigure(encoding='utf-8')
    except: pass

try: from fpdf import FPDF
except ImportError: print("pip install fpdf2"); sys.exit(1)

def _rgb(h): h=h.lstrip("#"); return tuple(int(h[i:i+2],16) for i in(0,2,4))
def _hex(r,g,b): return f"{max(0,min(255,int(r))):02X}{max(0,min(255,int(g))):02X}{max(0,min(255,int(b))):02X}"
def _body(base): r,g,b=_rgb(base); lum=0.299*r+0.587*g+0.114*b; return _hex(r*0.35,g*0.35,b*0.35) if lum<80 else "2D2D2D"
def _muted(base): r,g,b=_rgb(base); lum=0.299*r+0.587*g+0.114*b; return _hex(r*0.40+90,g*0.40+90,b*0.40+90) if lum<80 else "777777"
def _blend(c1,c2,r): r1,g1,b1=_rgb(c1); r2,g2,b2=_rgb(c2); return _hex(r1*(1-r)+r2*r,g1*(1-r)+g2*r,b1*(1-r)+b2*r)
def _dark(h,a): r,g,b=_rgb(h); return _hex(r*(1-a),g*(1-a),b*(1-a))

def resolve(meta):
    base=meta.get("base","0A1628"); accent=meta.get("accent","2D7DD2"); surface=meta.get("surface","F0F4F8")
    return {"theme":meta.get("theme",""),"atmo":meta.get("atmosphere",""),
        "base":base,"accent":accent,"surface":surface,
        "body":_body(base),"muted":_muted(base),
        "light_tint":_blend(base,accent,0.08),"callout_bar":accent,
        "hr":_dark(_blend(base,accent,0.5),0.5),
        "hdr_bg":"F0F2F5","hdr_text":base,"stripe":surface,
        "h_font":meta.get("heading_font","Helvetica"),"b_font":meta.get("body_font","Helvetica"),
        "t_sz":int(meta.get("title_size","24")),"h1_sz":int(meta.get("h1_size","16")),
        "h2_sz":int(meta.get("h2_size","12")),"b_sz":int(meta.get("body_size","10")),
        "cover":meta.get("cover","true")!="false","toc":meta.get("toc","false")=="true",
        "margin":float(meta.get("margin","25"))}

LAYOUT_RE=re.compile(r'<!--\s*layout:\s*(\w[\w-]*)\s*-->')

def parse(text):
    meta={}; body=text.strip()
    if body.startswith("---"):
        parts=body.split("---",2)
        if len(parts)>=3:
            for line in parts[1].strip().split("\n"):
                if ":" in line and not line[0]=="#": k,_,v=line.partition(":"); meta[k.strip()]=v.strip().strip('"').strip("'")
            body=parts[2].strip()
    lines=body.split("\n"); i=0
    secs=[]; cur={"heading":"","layout":"narrative","blocks":[]}
    def save():
        if cur["blocks"]: secs.append(cur.copy())
    tbl=[]; in_t=False
    while i<len(lines):
        line=lines[i]
        if line.strip().startswith("|") and line.strip().endswith("|"):
            tbl.append(line); in_t=True; i+=1; continue
        elif in_t:
            h,r=_tbl(tbl)
            if h: cur["blocks"].append({"t":"table","h":h,"r":r})
            tbl=[]; in_t=False; continue
        if not line.strip(): i+=1; continue
        m=re.match(r"^(##)\s+(.+)$",line)
        if m:
            save(); txt=m.group(2).strip(); lm=LAYOUT_RE.search(txt)
            layout="narrative"
            if lm: layout=lm.group(1); txt=txt[:lm.start()].strip()
            cur={"heading":txt,"layout":layout,"blocks":[]}; i+=1; continue
        m=re.match(r"^(#{3,6})\s+(.+)$",line)
        if m: cur["blocks"].append({"t":"sub","lvl":len(m.group(1)),"text":m.group(2).strip()}); i+=1; continue
        m=re.match(r"^[-*+]\s+(.+)$",line)
        if m:
            items=[]
            while i<len(lines) and re.match(r"^[-*+]\s+(.+)$",lines[i]):
                items.append(re.match(r"^[-*+]\s+(.+)$",lines[i]).group(1).strip()); i+=1
            cur["blocks"].append({"t":"bullet","items":items}); continue
        m=re.match(r"^\d+[.)]\s+(.+)$",line)
        if m:
            items=[]
            while i<len(lines) and re.match(r"^\d+[.)]\s+(.+)$",lines[i]):
                items.append(re.match(r"^\d+[.)]\s+(.+)$",lines[i]).group(1).strip()); i+=1
            cur["blocks"].append({"t":"ordered","items":items}); continue
        if line.startswith("> "):
            q=[]
            while i<len(lines) and lines[i].startswith("> "):
                q.append(lines[i][2:].strip()); i+=1
            cur["blocks"].append({"t":"quote","text":" ".join(q)}); continue
        if line.strip() in ("---","***","___"):
            cur["blocks"].append({"t":"hr"}); i+=1; continue
        p=[]
        while i<len(lines) and lines[i].strip() and not lines[i].startswith("#") and \
              not re.match(r"^[-*+]\s+",lines[i]) and not re.match(r"^\d+[.)]\s+",lines[i]) and \
              not lines[i].startswith("|") and not lines[i].startswith("> ") and \
              lines[i].strip() not in ("---","***","___"):
            p.append(lines[i]); i+=1
        cur["blocks"].append({"t":"para","text":"\n".join(p)})
    if tbl: h,r=_tbl(tbl)
    if h: cur["blocks"].append({"t":"table","h":h,"r":r})
    save()
    return meta,secs

def _tbl(raw):
    if len(raw)<2: return [],[]
    h=[c.strip() for c in raw[0].strip("|").split("|")]
    rows=[]
    for line in raw[1:]:
        if re.match(r"^[\|\-\s:]+$",line.strip()): continue
        cells=[c.strip() for c in line.strip("|").split("|")]
        if cells: rows.append(cells)
    return h,rows

class R:
    def __init__(self,t,meta):
        self.t=t; self.m=meta
        self.pdf=FPDF(unit="mm",format="A4")
        self.pdf.set_auto_page_break(True,t["margin"])
        self.mg=t["margin"]; self.pw=self.pdf.w-2*self.mg
        self._hc=False; self._toc=[]; self._cn=None
        self._rf()

    def _rf(self):
        for p in["C:/Windows/Fonts/msyh.ttc","C:/Windows/Fonts/simsun.ttc",
                  "C:/Windows/Fonts/simhei.ttf","/System/Library/Fonts/PingFang.ttc",
                  "/System/Library/Fonts/STHeiti Light.ttc",
                  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"]:
            if os.path.exists(p):
                try: self.pdf.add_font("CN","",p); self.pdf.add_font("CN","B",p); self._cn="CN"; return
                except: pass

    def _c(self,k): return _rgb(self.t[k])
    def _f(self,bold=False,sz=None):
        self.pdf.set_font(self._cn or "Helvetica","B" if bold else "",sz or self.t["b_sz"])

    def _hdr(self):
        if self._hc and self.pdf.page==1: return
        self.pdf.set_font(self._cn or "Helvetica","",7); self.pdf.set_text_color(*_rgb(self.t["muted"]))
        self.pdf.cell(self.pw,3,self.m.get("title","")[:50],align="L"); self.pdf.ln(3)
        self.pdf.set_draw_color(*_rgb(self.t["accent"])); self.pdf.set_line_width(0.15)
        self.pdf.line(self.mg,self.pdf.get_y(),self.pdf.w-self.mg,self.pdf.get_y()); self.pdf.ln(2)

    def _ftr(self):
        if self._hc and self.pdf.page==1: return
        self.pdf.set_y(-self.mg+5)
        self.pdf.set_draw_color(*_rgb(self.t["hr"])); self.pdf.set_line_width(0.12)
        self.pdf.line(self.mg,self.pdf.get_y(),self.pdf.w-self.mg,self.pdf.get_y())
        self.pdf.set_font(self._cn or "Helvetica","",7); self.pdf.set_text_color(*_rgb(self.t["muted"]))
        self.pdf.cell(self.pw,3,f"— {self.pdf.page_no()} —",align="C")

    # ── 封面（白底 + accent 双装饰线，对齐 docx v10） ──────────
    def cover(self):
        if not self.t["cover"]: return
        self._hc=True
        title=self.m.get("title",""); sub=self.m.get("subtitle","")
        author=self.m.get("author",""); ds=self.m.get("date","") or datetime.now().strftime("%Y年%m月")
        accent=self.t["accent"]

        self.pdf.add_page()

        # 顶部留白
        self.pdf.ln(30)

        # 大标题
        self._f(True,self.t["t_sz"]); self.pdf.set_text_color(*_rgb(self.t["base"]))
        self.pdf.multi_cell(self.pw,self.t["t_sz"]*0.55,title,align="C")

        # accent 双装饰线（上粗下细）
        self.pdf.ln(4)
        for sz in[0.6,0.25]:
            y=self.pdf.get_y()
            self.pdf.set_draw_color(*_rgb(accent)); self.pdf.set_line_width(sz)
            self.pdf.line(self.pdf.w/2-30,y,self.pdf.w/2+30,y)
            self.pdf.ln(4)

        # 副标题
        if sub:
            self.pdf.ln(4); self._f(False,self.t["b_sz"]+2); self.pdf.set_text_color(*_rgb(self.t["body"]))
            self.pdf.multi_cell(self.pw,7,sub,align="C")

        # 元信息
        self.pdf.ln(10); self._f(False,self.t["b_sz"]); self.pdf.set_text_color(*_rgb(self.t["muted"]))
        mi=[x for x in[author,ds,self.m.get("department")] if x]
        self.pdf.cell(self.pw,6," · ".join(mi),align="C")

    # ── 章节（accent 细竖线 + 标题，简洁专业） ──────────────
    def chapter(self,title,layout):
        self.pdf.ln(5)
        bar_w=2; pad=5
        self.pdf.set_fill_color(*_rgb(self.t["accent"]))
        self.pdf.rect(self.mg,self.pdf.get_y()-1,bar_w,self.t["h1_sz"]+2,"F")
        self.pdf.set_x(self.mg+bar_w+pad)
        self._f(True,self.t["h1_sz"]); self.pdf.set_text_color(*_rgb(self.t["base"]))
        self.pdf.cell(self.pw-bar_w-pad,self.t["h1_sz"]*0.55,title,new_x="LMARGIN",new_y="NEXT")
        self.pdf.ln(2)
        self._toc.append({"level":1,"text":title,"page":self.pdf.page})

    def sub(self,text,lvl):
        self.pdf.ln(2)
        sz=self.t["h1_sz"] if lvl==3 else self.t["h2_sz"]; bold=lvl<=3
        self._f(bold,sz); self.pdf.set_text_color(*_rgb(self.t["base"] if lvl==3 else self.t["body"]))
        self.pdf.cell(self.pw,sz*0.55,text,new_x="LMARGIN",new_y="NEXT"); self.pdf.ln(1)
        if lvl<=3: self._toc.append({"level":2,"text":text,"page":self.pdf.page})

    def para(self,text):
        self._f(False); self.pdf.set_text_color(*_rgb(self.t["body"]))
        for tok in re.split(r"(\*\*.+?\*\*|\*.+?\*|`.+?`)",text):
            if tok.startswith("**") and tok.endswith("**"): self._f(True); self.pdf.set_text_color(*_rgb(self.t["body"])); self.pdf.write(self.t["b_sz"]*0.55,tok[2:-2])
            elif tok.startswith("*") and tok.endswith("*") and not tok.startswith("**"): self._f(False); self.pdf.set_text_color(*_rgb(self.t["body"])); self.pdf.write(self.t["b_sz"]*0.55,tok[1:-1])
            elif tok.startswith("`") and tok.endswith("`"): self.pdf.set_font("Courier","",self.t["b_sz"]-1); self.pdf.set_text_color(*_rgb(self.t["accent"])); self.pdf.write(self.t["b_sz"]*0.55,tok[1:-1])
            elif tok: self._f(False); self.pdf.set_text_color(*_rgb(self.t["body"])); self.pdf.write(self.t["b_sz"]*0.55,tok)
        self.pdf.ln(3)

    def bullet(self,items):
        for item in items:
            self._f(False); self.pdf.set_text_color(*_rgb(self.t["body"]))
            self.pdf.cell(self.pw,self.t["b_sz"]*0.5,f"  •  {item}",new_x="LMARGIN",new_y="NEXT")

    def ordered(self,items):
        for idx,item in enumerate(items,1):
            self._f(False); self.pdf.set_text_color(*_rgb(self.t["body"]))
            self.pdf.cell(self.pw,self.t["b_sz"]*0.5,f"  {idx}. {item}",new_x="LMARGIN",new_y="NEXT")

    def quote(self,text):
        self.pdf.ln(2); bar_w=2; pad=4; sy=self.pdf.get_y()
        self.pdf.set_x(self.mg+bar_w+pad); self._f(False,self.t["b_sz"]-1); self.pdf.set_text_color(*_rgb(self.t["body"]))
        self.pdf.multi_cell(self.pw-bar_w-pad,(self.t["b_sz"]-1)*0.5,text)
        h=self.pdf.get_y()-sy+3
        self.pdf.set_fill_color(*_rgb(self.t["light_tint"])); self.pdf.rect(self.mg,sy-2,self.pw,h,"F")
        self.pdf.set_fill_color(*_rgb(self.t["callout_bar"])); self.pdf.rect(self.mg,sy-2,bar_w,h,"F")
        self.pdf.set_xy(self.mg+bar_w+pad,sy); self._f(False,self.t["b_sz"]-1); self.pdf.set_text_color(*_rgb(self.t["body"]))
        self.pdf.multi_cell(self.pw-bar_w-pad,(self.t["b_sz"]-1)*0.5,text); self.pdf.ln(1)

    def table(self,hdrs,rows):
        if not hdrs: return
        self.pdf.ln(2); cols=len(hdrs); cw=self.pw/cols
        # 表头：浅灰底 + 深色文字
        self.pdf.set_fill_color(*_rgb(self.t["hdr_bg"]))
        self.pdf.set_text_color(*_rgb(self.t["hdr_text"]))
        self._f(True,self.t["b_sz"]-1)
        for j,h in enumerate(hdrs): self.pdf.cell(cw,7,h,border=1,fill=True,align="C")
        self.pdf.ln()
        for i,row in enumerate(rows):
            if i%2==1: self.pdf.set_fill_color(*_rgb(self.t["stripe"]))
            else: self.pdf.set_fill_color(255,255,255)
            self.pdf.set_text_color(*_rgb(self.t["body"])); self._f(False,self.t["b_sz"]-1)
            for j,val in enumerate(row):
                if j<cols: self.pdf.cell(cw,6,str(val)[:45],border=1,fill=True,align="C" if j==0 else "L")
            self.pdf.ln()
        self.pdf.ln(2)

    def toc_page(self):
        if not self.t["toc"] or not self._toc: return
        self.pdf.add_page(); self._f(True,self.t["h1_sz"]); self.pdf.set_text_color(*_rgb(self.t["base"]))
        self.pdf.cell(self.pw,10,"目  录",new_x="LMARGIN",new_y="NEXT"); self.pdf.ln(3)
        self.pdf.set_draw_color(*_rgb(self.t["accent"])); self.pdf.set_line_width(0.25)
        self.pdf.line(self.mg,self.pdf.get_y(),self.pdf.w-self.mg,self.pdf.get_y()); self.pdf.ln(5)
        for e in self._toc:
            self.pdf.set_x(self.mg+(e["level"]-1)*8)
            self._f(e["level"]==1,self.t["b_sz"]+(1 if e["level"]==1 else 0))
            self.pdf.set_text_color(*_rgb(self.t["body"]))
            self.pdf.cell(self.pw-(e["level"]-1)*8-10,7,e["text"][:60])
            self.pdf.cell(10,7,str(e.get("page","")),align="R",new_x="LMARGIN",new_y="NEXT")

    def sig(self):
        s=self.m.get("signature_unit") or self.m.get("author") or ""
        d=self.m.get("signature_date") or self.m.get("date") or ""
        if not s and not d: return
        self.pdf.ln(6); self._f(False); self.pdf.set_text_color(*_rgb(self.t["body"]))
        for line in[s,d]:
            if line: self.pdf.cell(self.pw,7,line,align="R",new_x="LMARGIN",new_y="NEXT")

    def build(self,secs):
        self.pdf.set_title(self.m.get("title","")); self.pdf.set_author(self.m.get("author",""))
        self.pdf.header=lambda:self._hdr(); self.pdf.footer=lambda:self._ftr()
        self.cover()
        if not self._hc:
            title=self.m.get("title","")
            if title:
                self.pdf.add_page()
                self.pdf.ln(10)
                self._f(True,self.t["t_sz"]); self.pdf.set_text_color(*_rgb(self.t["base"]))
                self.pdf.multi_cell(self.pw,self.t["t_sz"]*0.55,title,align="C")
                self.pdf.ln(3)
                for sz in[0.5,0.2]:
                    y=self.pdf.get_y(); self.pdf.set_draw_color(*_rgb(self.t["accent"])); self.pdf.set_line_width(sz)
                    self.pdf.line(self.pdf.w/2-25,y,self.pdf.w/2+25,y); self.pdf.ln(3)
                self.pdf.ln(4)

        for sec in secs:
            if sec.get("heading"): self.chapter(sec["heading"],sec.get("layout","narrative"))
            for blk in sec.get("blocks",[]):
                t=blk["t"]
                if t=="sub": self.sub(blk["text"],blk["lvl"])
                elif t=="para": self.para(blk["text"])
                elif t=="bullet": self.bullet(blk["items"])
                elif t=="ordered": self.ordered(blk["items"])
                elif t=="quote": self.quote(blk["text"])
                elif t=="table": self.table(blk["h"],blk["r"])
                elif t=="hr":
                    self.pdf.ln(1); self.pdf.set_draw_color(*_rgb(self.t["hr"])); self.pdf.set_line_width(0.12)
                    y=self.pdf.get_y(); self.pdf.line(self.mg+20,y,self.pdf.w-self.mg-20,y); self.pdf.ln(1)
            if sec.get("layout")=="closing": self.sig()
        self.sig(); self.toc_page()

    def save(self,p): self.pdf.output(p)

def main():
    import argparse
    p=argparse.ArgumentParser(description="Otto PDF-Toolkit v10")
    p.add_argument("input"); p.add_argument("output")
    a=p.parse_args()
    ip=Path(a.input)
    if not ip.exists(): print(f"not found: {a.input}"); sys.exit(1)
    meta,secs=parse(ip.read_text(encoding="utf-8"))
    t=resolve(meta)
    if "title" not in meta: meta["title"]=ip.stem
    g=R(t,meta); g.build(secs)
    op=Path(a.output); op.parent.mkdir(parents=True,exist_ok=True)
    g.save(str(op))
    print(f"OK {op.name} {op.stat().st_size/1024:.0f}KB {len(secs)}sections")

if __name__=="__main__": main()
