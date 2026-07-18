#!/usr/bin/env python3
"""合并多个 PDF 文件。用法：python merge_pdf.py output.pdf input1.pdf input2.pdf ..."""
import sys; from pathlib import Path
try: from pypdf import PdfMerger
except ImportError: print("需要 pypdf。pip install pypdf"); sys.exit(1)

def main():
    import argparse
    p = argparse.ArgumentParser(description="合并多个 PDF")
    p.add_argument("output", help="输出 PDF"); p.add_argument("inputs", nargs="+", help="输入 PDF 列表")
    a = p.parse_args()
    for f in a.inputs:
        if not Path(f).exists(): print(f"错误：找不到 {f}"); sys.exit(1)
    m = PdfMerger()
    for f in a.inputs: m.append(f)
    m.write(a.output); m.close()
    print(f"✅ 合并完成：{a.output}（{len(a.inputs)} 个文件）")

if __name__ == "__main__": main()
