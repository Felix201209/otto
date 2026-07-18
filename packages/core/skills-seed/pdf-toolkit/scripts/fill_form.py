#!/usr/bin/env python3
"""PDF 表单填写。用法：python fill_form.py input.pdf output.pdf --field "Name" "张三" --field "Date" "2026-07-18\""""
import sys; from pathlib import Path
try: from pypdf import PdfReader, PdfWriter
except ImportError: print("需要 pypdf。pip install pypdf"); sys.exit(1)

def main():
    import argparse
    p = argparse.ArgumentParser(description="填写 PDF 表单")
    p.add_argument("input", help="输入 PDF（含表单域）")
    p.add_argument("output", help="输出 PDF")
    p.add_argument("--field", nargs=2, action="append", metavar=("NAME","VALUE"), help="表单域名和值")
    a = p.parse_args()
    if not Path(a.input).exists(): print(f"错误：找不到 {a.input}"); sys.exit(1)

    reader = PdfReader(a.input)
    writer = PdfWriter()
    writer.append(reader)

    if a.field:
        fields = reader.get_fields() or {}
        for name, val in a.field:
            if name in fields:
                writer.update_page_form_field_values(writer.pages[0], {name: val})
                print(f"  填写：{name} = {val}")
            else:
                print(f"  ⚠️ 未找到表单域：{name}")
                print(f"  可用域：{', '.join(fields.keys())[:200]}" if fields else "  无可用表单域")
    writer.write(a.output)
    print(f"✅ 表单已填写：{a.output}")

if __name__ == "__main__": main()
