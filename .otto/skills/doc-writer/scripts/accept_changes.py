#!/usr/bin/env python3
"""
接受 .docx 文档中的所有修订痕迹（Tracked Changes），产出干净文档。

需要 LibreOffice（Windows 下可选）。

用法： python accept_changes.py <input.docx> <output.docx>
"""
from __future__ import annotations

import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path

# Windows 兼容：强制 UTF-8 输出
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass


def accept_changes_via_xml(input_docx: str, output_docx: str) -> bool:
    """
    直接操作 XML 删除所有修订标记。
    处理：
    - <w:ins> 内容保留，移除 <w:ins> 标签
    - <w:del> 内容移除
    - <w:commentRangeStart/End> 移除注释范围
    - <w:commentReference> 移除注释引用
    """
    input_path = Path(input_docx)
    if not input_path.exists():
        print(f"错误：找不到文件 {input_docx}")
        return False

    # 读入整个 ZIP
    with zipfile.ZipFile(input_path, "r") as zf:
        files = {name: zf.read(name) for name in zf.namelist()}

    modified = False

    for name in list(files.keys()):
        if not name.endswith(".xml"):
            continue

        content = files[name].decode("utf-8", errors="replace")

        # 移除 <w:del>...</w:del> 连同内容
        content = re.sub(r"<w:del[^>]*>.*?</w:del>", "", content, flags=re.DOTALL)

        # 移除 <w:ins> 和 </w:ins> 标签但保留内容
        content = re.sub(r"<w:ins[^>]*>", "", content)
        content = content.replace("</w:ins>", "")

        # 移除批注标记
        content = re.sub(r"<w:commentRangeStart[^/]*/>", "", content)
        content = re.sub(r"<w:commentRangeEnd[^/]*/>", "", content)

        # 移除批注引用（保留 run 文本）
        content = re.sub(
            r"<w:r>\s*<w:rPr>\s*<w:rStyle[^/]*/>\s*</w:rPr>\s*<w:commentReference[^/]*/>\s*</w:r>",
            "", content, flags=re.DOTALL
        )

        # 移除 <w:delText> 标签
        content = re.sub(r"<w:delText[^>]*>", "", content)
        content = content.replace("</w:delText>", "")

        # 移除移动标记
        content = re.sub(r"<w:moveFrom[^>]*>.*?</w:moveFrom>", "", content, flags=re.DOTALL)
        content = re.sub(r"<w:moveTo[^>]*>", "", content)
        content = content.replace("</w:moveTo>", "")

        if content != files[name].decode("utf-8", errors="replace"):
            modified = True
            files[name] = content.encode("utf-8")

    if not modified:
        print("ℹ️ 未检测到修订痕迹，输出原文件。")
        import shutil
        shutil.copy2(input_docx, output_docx)
        return True

    # 重新打包
    out_path = Path(output_docx)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)

    size_kb = out_path.stat().st_size / 1024
    print(f"✅ 已接受所有修订：{input_docx} → {output_docx}")
    print(f"   大小：{size_kb:.1f} KB")
    return True


def accept_changes_via_libreoffice(input_docx: str, output_docx: str) -> bool:
    """通过 LibreOffice 宏接受修订（兼容性更好但需要 LibreOffice）。"""
    import subprocess
    import shutil

    # 查找 LibreOffice
    soffice = None
    for c in ["soffice", "libreoffice",
              "C:\\Program Files\\LibreOffice\\program\\soffice.exe"]:
        if shutil.which(c) or os.path.exists(c):
            soffice = c if os.path.isabs(c) else shutil.which(c)
            break

    if not soffice:
        return False

    # LibreOffice 宏方式接受修订
    macro = (
        "import uno; "
        "doc = XSCRIPTCONTEXT.getDocument(); "
        "doc.setPropertyValue('RedlineMode', True); "
        "changes = doc.getRedlines(); "
        "while changes.getCount() > 0: "
        "  doc.acceptRedline(0); "
        "  changes = doc.getRedlines(); "
    )

    with tempfile.NamedTemporaryFile(suffix=".py", delete=False, mode="w") as f:
        f.write(macro)
        macro_path = f.name

    try:
        result = subprocess.run(
            [soffice, "--headless", "--infilter=MS Word 2007 XML",
             f"--macro:{macro_path}", "-o", output_docx, input_docx],
            capture_output=True, text=True, timeout=60
        )
        return result.returncode == 0
    finally:
        os.unlink(macro_path)


def main():
    import argparse
    parser = argparse.ArgumentParser(description="接受 .docx 中的所有修订痕迹")
    parser.add_argument("input", help="输入 .docx")
    parser.add_argument("output", help="输出 .docx（干净版）")
    args = parser.parse_args()

    # 优先用 XML 方式（无外部依赖）
    ok = accept_changes_via_xml(args.input, args.output)
    if ok:
        sys.exit(0)

    # 降级尝试 LibreOffice
    print("XML 方式失败，尝试 LibreOffice...")
    ok = accept_changes_via_libreoffice(args.input, args.output)
    if ok:
        print("✅ 已通过 LibreOffice 接受修订")
        sys.exit(0)

    print("❌ 无法接受修订。请安装 LibreOffice 后重试。")
    sys.exit(1)


if __name__ == "__main__":
    main()
