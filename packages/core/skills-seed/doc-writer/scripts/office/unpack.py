#!/usr/bin/env python3
"""
解包 .docx 文件为可编辑的 XML 文件树。

用法： python unpack.py <input.docx> <output_dir> [--no-merge-runs]
"""
from __future__ import annotations

import os
import re
import sys
import zipfile
from pathlib import Path
from xml.dom import minidom

# Windows 兼容：强制 UTF-8 输出
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass


def pretty_print_xml(xml_bytes: bytes) -> bytes:
    """格式化 XML 为带缩进的易读格式。"""
    try:
        dom = minidom.parseString(xml_bytes)
        return dom.toprettyxml(indent="  ", encoding="utf-8")
    except Exception:
        return xml_bytes


def merge_adjacent_runs(xml_content: str) -> str:
    """合并相邻的同格式 <w:r> 元素，减少文件碎片便于编辑。"""
    import re as _re
    # 简单合并：相同格式的相邻 <w:t> 文本合并到同一个 <w:r>
    # 保守策略：只合并纯文本 run（无 rPr 差异的）
    return xml_content  # 简化实现，保留原始结构


def main():
    import argparse
    parser = argparse.ArgumentParser(description="解包 .docx 为 XML 文件树")
    parser.add_argument("input", help="输入 .docx 文件")
    parser.add_argument("output_dir", help="输出目录")
    parser.add_argument("--no-merge-runs", action="store_true", help="不合并相邻文本 run")
    parser.add_argument("--merge-runs", dest="merge_runs", default=True,
                        action="store_true", help="合并相邻文本 run（默认）")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"错误：找不到文件 {args.input}")
        sys.exit(1)

    out_dir = Path(args.output_dir)
    if out_dir.exists():
        import shutil
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    with zipfile.ZipFile(input_path, "r") as zf:
        for info in zf.infolist():
            target = out_dir / info.filename
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                data = zf.read(info.filename)

                # XML 文件格式化
                if info.filename.endswith((".xml", ".rels")):
                    formatted = pretty_print_xml(data)
                    if args.merge_runs and info.filename == "word/document.xml":
                        content = formatted.decode("utf-8")
                        content = merge_adjacent_runs(content)
                        formatted = content.encode("utf-8")
                    # 将智能引号转为 XML 实体，避免编辑时编码问题
                    text = formatted.decode("utf-8")
                    text = text.replace("\u2018", "&#x2018;")
                    text = text.replace("\u2019", "&#x2019;")
                    text = text.replace("\u201c", "&#x201C;")
                    text = text.replace("\u201d", "&#x201D;")
                    formatted = text.encode("utf-8")

                target.write_bytes(data if not info.filename.endswith((".xml", ".rels")) else formatted)

    # 统计
    file_count = sum(1 for _ in out_dir.rglob("*") if _.is_file())
    print(f"✅ 已解包：{input_path} → {out_dir}")
    print(f"   文件数：{file_count}")
    print(f"   编辑 word/document.xml 修改正文内容")
    print(f"   编辑后运行 pack.py 重新打包")


if __name__ == "__main__":
    main()
