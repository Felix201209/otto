#!/usr/bin/env python3
"""拆分 PDF。用法：python split_pdf.py input.pdf --pages 1-3,4-5 --output-dir out/"""
import sys; from pathlib import Path
try: from pypdf import PdfReader, PdfWriter
except ImportError: print("需要 pypdf。pip install pypdf"); sys.exit(1)

def main():
    import argparse
    p = argparse.ArgumentParser(description="拆分 PDF")
    p.add_argument("input", help="输入 PDF"); p.add_argument("--pages", help="页码范围，如 1-3,4-5")
    p.add_argument("--output-dir", default=".", help="输出目录")
    a = p.parse_args()
    if not Path(a.input).exists(): print(f"错误：找不到 {a.input}"); sys.exit(1)
    reader = PdfReader(a.input); total = len(reader.pages)
    out_dir = Path(a.output_dir); out_dir.mkdir(parents=True, exist_ok=True)

    if a.pages:
        ranges = [r.strip() for r in a.pages.split(",")]
        for rng in ranges:
            parts = rng.split("-")
            start = int(parts[0]) - 1; end = int(parts[1]) - 1 if len(parts) > 1 else start
            writer = PdfWriter()
            for i in range(start, min(end + 1, total)):
                writer.add_page(reader.pages[i])
            fname = out_dir / f"pages_{start+1}-{end+1}.pdf"
            writer.write(str(fname))
            print(f"  {fname}")
    else:
        for i in range(total):
            writer = PdfWriter(); writer.add_page(reader.pages[i])
            fname = out_dir / f"page_{i+1}.pdf"
            writer.write(str(fname))
    print(f"✅ 拆分完成：共 {total} 页")

if __name__ == "__main__": main()
