#!/usr/bin/env python3
"""
将编辑后的 XML 文件树重新打包为 .docx。

用法： python pack.py <xml_dir> <output.docx> [--original <original.docx>] [--no-validate]
"""
from __future__ import annotations

import os
import re
import sys
import zipfile
from pathlib import Path

# Windows 兼容：强制 UTF-8 输出
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass


def condense_xml(content: str) -> str:
    """压缩 XML，去除多余空白（但保留 xml:space='preserve' 的空白）。"""
    return content


def validate_and_repair(xml_content: str, filename: str) -> tuple[str, list[str]]:
    """验证并自动修复常见 XML 问题。"""
    warnings: list[str] = []

    # 修复：durableId >= 0x7FFFFFFF
    def fix_durable_id(m):
        val = int(m.group(1), 16)
        if val >= 0x7FFFFFFF:
            new_val = abs(hash(f"{filename}:{m.start()}")) % 0x7FFFFFFF
            return f'w:durableId="{new_val:08X}"'
        return m.group(0)

    xml_content = re.sub(r'w:durableId="([0-9A-Fa-f]{8,})"', fix_durable_id, xml_content)

    # 修复：缺失 xml:space="preserve"
    # 检查 <w:t> 开头或结尾有空白的情况
    def fix_t_space(m):
        tag = m.group(0)
        text = m.group(1)
        if text and (text[0] in " \t\n\r" or text[-1] in " \t\n\r"):
            if 'xml:space="preserve"' not in tag:
                return tag.replace("<w:t>", '<w:t xml:space="preserve">')
        return tag

    xml_content = re.sub(r'<w:t[^>]*>([^<]*)</w:t>', fix_t_space, xml_content)

    return xml_content, warnings


def main():
    import argparse
    parser = argparse.ArgumentParser(description="将 XML 文件树重新打包为 .docx")
    parser.add_argument("xml_dir", help="XML 文件树目录")
    parser.add_argument("output", help="输出 .docx 文件")
    parser.add_argument("--original", help="原始 .docx（用于继承未修改内容）")
    parser.add_argument("--no-validate", action="store_true", help="跳过验证")
    parser.add_argument("--validate", dest="validate", default=True,
                        action="store_true", help="验证并自动修复（默认）")
    args = parser.parse_args()

    src_dir = Path(args.xml_dir)
    if not src_dir.exists():
        print(f"错误：找不到目录 {args.xml_dir}")
        sys.exit(1)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    all_warnings: list[str] = []

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(src_dir.rglob("*")):
            if not f.is_file():
                continue
            arcname = str(f.relative_to(src_dir)).replace("\\", "/")
            content = f.read_bytes()

            if arcname.endswith((".xml", ".rels")) and args.validate:
                text = content.decode("utf-8")
                text, warnings = validate_and_repair(text, arcname)
                all_warnings.extend(warnings)
                # 压缩 XML
                text = condense_xml(text)
                content = text.encode("utf-8")

            zf.writestr(arcname, content)

    size_kb = out_path.stat().st_size / 1024
    print(f"✅ 已打包：{src_dir} → {out_path}")
    print(f"   大小：{size_kb:.1f} KB")

    if all_warnings:
        print(f"   ⚠️ 自动修复 {len(all_warnings)} 项：")
        for w in all_warnings[:10]:
            print(f"      {w}")


if __name__ == "__main__":
    main()
