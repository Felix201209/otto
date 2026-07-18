#!/usr/bin/env python3
"""提取 PDF 文字。用法：python extract_text.py input.pdf [--pages 1-3] [--output text.txt]"""
import sys; from pathlib import Path
try: from pypdf import PdfReader
except ImportError: print("需要 pypdf。pip install pypdf"); sys.exit(1)

def main():
    import argparse
    p = argparse.ArgumentParser(description="提取 PDF 文字")
    p.add_argument("input", help="输入 PDF"); p.add_argument("--pages", help="页码范围")
    p.add_argument("--output", "-o", help="输出文本文件")
    a = p.parse_args()
    if not Path(a.input).exists(): print(f"错误：找不到 {a.input}"); sys.exit(1)
    reader = PdfReader(a.input); total = len(reader.pages)

    if a.pages:
        parts = a.pages.split("-")
        start, end = int(parts[0]) - 1, (int(parts[1]) - 1 if len(parts) > 1 else int(parts[0]) - 1)
    else:
        start, end = 0, total - 1

    lines = []
    for i in range(start, min(end + 1, total)):
        text = reader.pages[i].extract_text() or ""
        lines.append(f"\n=== 第 {i+1} 页 ===\n{text}")
    result = "\n".join(lines)

    if a.output:
        Path(a.output).write_text(result, encoding="utf-8")
        print(f"✅ 已提取到：{a.output}（{end-start+1} 页, {len(result)} 字）")
    else:
        print(result)

if __name__ == "__main__": main()
