#!/usr/bin/env python3
"""
编辑已有 .docx 文档。

工作流程：解包 → AI编辑XML → 重新打包。

用法：
  1. 解包：   python edit_docx.py unpack <input.docx> <work_dir>
  2. 重新打包： python edit_docx.py pack <work_dir> <output.docx>
  3. 一键搜索替换： python edit_docx.py replace <input.docx> <output.docx> --find "旧文本" --replace "新文本"
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


# ─── 子命令：解包 ───────────────────────────────────────────────────────

def cmd_unpack(input_docx: str, work_dir: str):
    """解包 docx 到工作目录。"""
    input_path = Path(input_docx)
    if not input_path.exists():
        print(f"错误：找不到文件 {input_docx}")
        sys.exit(1)

    out_dir = Path(work_dir)
    if out_dir.exists():
        import shutil
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    with zipfile.ZipFile(input_path, "r") as zf:
        zf.extractall(out_dir)

    # 格式化所有 XML
    for xml_file in out_dir.rglob("*.xml"):
        content = xml_file.read_bytes()
        try:
            dom = minidom.parseString(content)
            formatted = dom.toprettyxml(indent="  ", encoding="utf-8")
            xml_file.write_bytes(formatted)
        except Exception:
            pass

    file_count = sum(1 for _ in out_dir.rglob("*") if _.is_file())
    print(f"✅ 已解包：{input_path} → {out_dir}")
    print(f"   文件数：{file_count}")
    print(f"\n📝 编辑指南：")
    print(f"   正文内容：word/document.xml")
    print(f"   页眉页脚：word/header*.xml, word/footer*.xml")
    print(f"   样式定义：word/styles.xml")
    print(f"   图片替换：word/media/ 目录")
    print(f"\n   编辑完成后运行：")
    print(f"   python edit_docx.py pack {work_dir} <output.docx>")


# ─── 子命令：打包 ───────────────────────────────────────────────────────

def cmd_pack(work_dir: str, output_docx: str):
    """将工作目录重新打包为 docx。"""
    src_dir = Path(work_dir)
    if not src_dir.exists():
        print(f"错误：找不到目录 {work_dir}")
        sys.exit(1)

    out_path = Path(output_docx)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(src_dir.rglob("*")):
            if not f.is_file():
                continue
            arcname = str(f.relative_to(src_dir)).replace("\\", "/")
            zf.write(f, arcname)

    size_kb = out_path.stat().st_size / 1024
    print(f"✅ 已打包：{src_dir} → {out_path}")
    print(f"   大小：{size_kb:.1f} KB")


# ─── 子命令：搜索替换 ───────────────────────────────────────────────────

def cmd_replace(input_docx: str, output_docx: str, find_text: str, replace_text: str):
    """在 docx 中搜索替换文本。"""
    input_path = Path(input_docx)
    if not input_path.exists():
        print(f"错误：找不到文件 {input_docx}")
        sys.exit(1)

    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        import shutil
        tmp_path = Path(tmp)

        # 解包
        with zipfile.ZipFile(input_path, "r") as zf:
            zf.extractall(tmp_path)

        # 在 document.xml 中替换
        doc_xml_path = tmp_path / "word" / "document.xml"
        if doc_xml_path.exists():
            content = doc_xml_path.read_text(encoding="utf-8")
            count = content.count(find_text)
            content = content.replace(find_text, replace_text)
            doc_xml_path.write_text(content, encoding="utf-8")
            print(f"   替换了 {count} 处")

        # 重新打包
        out_path = Path(output_docx)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in sorted(tmp_path.rglob("*")):
                if not f.is_file():
                    continue
                arcname = str(f.relative_to(tmp_path)).replace("\\", "/")
                zf.write(f, arcname)

        print(f"✅ 搜索替换完成：{input_docx} → {output_docx}")
        print(f"   '{find_text}' → '{replace_text}'")


# ─── 主入口 ─────────────────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser(
        description="编辑已有 .docx 文档",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
子命令:
  unpack   - 解包 docx 为 XML 工作目录
  pack     - 将 XML 工作目录重新打包为 docx
  replace  - 搜索替换文本（不解包，直接操作 XML）
        """,
    )
    sub = parser.add_subparsers(dest="cmd", help="子命令")

    # unpack
    p_unpack = sub.add_parser("unpack", help="解包 docx")
    p_unpack.add_argument("input", help="输入 .docx")
    p_unpack.add_argument("work_dir", help="输出工作目录")

    # pack
    p_pack = sub.add_parser("pack", help="重新打包")
    p_pack.add_argument("work_dir", help="工作目录")
    p_pack.add_argument("output", help="输出 .docx")

    # replace
    p_replace = sub.add_parser("replace", help="搜索替换")
    p_replace.add_argument("input", help="输入 .docx")
    p_replace.add_argument("output", help="输出 .docx")
    p_replace.add_argument("--find", required=True, help="搜索文本")
    p_replace.add_argument("--replace", required=True, help="替换文本")

    args = parser.parse_args()

    if args.cmd == "unpack":
        cmd_unpack(args.input, args.work_dir)
    elif args.cmd == "pack":
        cmd_pack(args.work_dir, args.output)
    elif args.cmd == "replace":
        cmd_replace(args.input, args.output, args.find, args.replace)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
