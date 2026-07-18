#!/usr/bin/env python3
"""表格数据分析。用法：python analyze.py input.xlsx [--sheet Sheet1]"""
import sys; from pathlib import Path
try: from openpyxl import load_workbook
except ImportError: print("需要 openpyxl。pip install openpyxl"); sys.exit(1)

def main():
    import argparse
    p = argparse.ArgumentParser(description="分析 Excel 数据")
    p.add_argument("input", help="输入 .xlsx"); p.add_argument("--sheet", "-s", help="工作表名")
    a = p.parse_args()
    if not Path(a.input).exists(): print(f"错误：找不到 {a.input}"); sys.exit(1)

    wb = load_workbook(a.input, data_only=True)
    ws = wb[a.sheet] if a.sheet else wb.active

    print(f"📊 工作表：{ws.title}")
    print(f"   行数：{ws.max_row}  列数：{ws.max_column}")
    print()

    # 表头
    headers = [ws.cell(1, c).value for c in range(1, ws.max_column + 1)]
    print(f"   字段：{' | '.join(str(h or '') for h in headers)}")
    print()

    # 每列统计
    for c in range(1, ws.max_column + 1):
        vals = [ws.cell(r, c).value for r in range(2, ws.max_row + 1) if ws.cell(r, c).value is not None]
        hdr = headers[c-1] or f"列{c}"
        if not vals: continue
        nums = [v for v in vals if isinstance(v, (int, float))]
        if nums and len(nums) > len(vals) * 0.5:
            print(f"   {hdr}: 计数={len(nums)}, 和={sum(nums):.1f}, 均值={sum(nums)/len(nums):.1f}, "
                  f"最小={min(nums)}, 最大={max(nums)}")
        else:
            unique = set(str(v) for v in vals)
            print(f"   {hdr}: 计数={len(vals)}, 唯一值={len(unique)}"
                  + (f", 示例：{', '.join(list(unique)[:3])}" if unique else ""))

if __name__ == "__main__": main()
