#!/usr/bin/env python3
"""
验证 .docx 文件结构完整性。

用法： python validate.py <file.docx>
"""
from __future__ import annotations

import sys
import zipfile
from pathlib import Path

# Windows 兼容：强制 UTF-8 输出
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass


REQUIRED_FILES = [
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
]


def validate_docx(filepath: str) -> tuple[bool, list[str]]:
    """验证 docx 文件，返回 (是否通过, 错误消息列表)。"""
    errors: list[str] = []
    path = Path(filepath)

    if not path.exists():
        return False, [f"文件不存在：{filepath}"]

    if not path.suffix.lower() == ".docx":
        errors.append(f"文件扩展名不是 .docx：{path.suffix}")

    # 检查是否为有效 ZIP
    try:
        with zipfile.ZipFile(path, "r") as zf:
            namelist = zf.namelist()

            # 检查必要文件
            for required in REQUIRED_FILES:
                if required not in namelist:
                    errors.append(f"缺少必要文件：{required}")

            # 检查基本 XML 结构
            if "word/document.xml" in namelist:
                doc_xml = zf.read("word/document.xml")
                if b"<w:document" not in doc_xml:
                    errors.append("word/document.xml 不包含有效的 w:document 元素")
                if b"<w:body" not in doc_xml:
                    errors.append("word/document.xml 缺少 w:body")

            # 统计
            xml_count = sum(1 for n in namelist if n.endswith(".xml") or n.endswith(".rels"))
            media_count = sum(1 for n in namelist if "/media/" in n)

    except zipfile.BadZipFile:
        return False, [f"不是有效的 ZIP 文件（.docx 必须是 ZIP 归档）"]
    except Exception as e:
        return False, [f"读取失败：{e}"]

    if errors:
        return False, errors

    size_kb = path.stat().st_size / 1024
    print(f"✅ 验证通过：{filepath}")
    print(f"   大小：{size_kb:.1f} KB")
    print(f"   XML/关系文件：{xml_count}")
    print(f"   媒体文件：{media_count}")
    return True, []


def main():
    import argparse
    parser = argparse.ArgumentParser(description="验证 .docx 文件完整性")
    parser.add_argument("file", help="要验证的 .docx 文件")
    args = parser.parse_args()

    ok, errors = validate_docx(args.file)
    if not ok:
        print(f"❌ 验证失败：{args.file}")
        for e in errors:
            print(f"   {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
