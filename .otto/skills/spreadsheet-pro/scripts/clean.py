#!/usr/bin/env python3
"""数据清洗。用法：python clean.py input.xlsx output.xlsx [--sheet Sheet1]"""
import sys; from pathlib import Path
try: from openpyxl import load_workbook, Workbook
except ImportError: print("需要 openpyxl。pip install openpyxl"); sys.exit(1)

def main():
    import argparse
    p = argparse.ArgumentParser(description="清洗 Excel 数据")
    p.add_argument("input", help="输入 .xlsx"); p.add_argument("output", help="输出 .xlsx")
    p.add_argument("--sheet", "-s", help="工作表名")
    a = p.parse_args()
    if not Path(a.input).exists(): print(f"错误：找不到 {a.input}"); sys.exit(1)

    wb = load_workbook(a.input, data_only=True); ws = wb[a.sheet] if a.sheet else wb.active
    out_wb = Workbook(); out_ws = out_wb.active; out_ws.title = ws.title + "_clean"

    for r in range(1, ws.max_row + 1):
        for c in range(1, ws.max_column + 1):
            val = ws.cell(r, c).value
            cell = out_ws.cell(r, c, value=val)
            if val is None:
                cell.value = ""
            elif isinstance(val, str):
                val = val.strip()
                # 统一空值
                if val.lower() in ("n/a", "null", "none", "无", "—", "-"):
                    cell.value = ""
                else:
                    cell.value = val

    out_wb.save(a.output)
    print(f"✅ 清洗完成：{a.output}（{ws.max_row} 行 × {ws.max_column} 列）")

if __name__ == "__main__": main()
