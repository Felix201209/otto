#!/usr/bin/env python3
"""
LibreOffice 命令行包装器，用于文档格式转换。

用法： python soffice.py --headless --convert-to pdf <input.docx>
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

# Windows 兼容：强制 UTF-8 输出
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass


def find_soffice() -> str | None:
    """查找 LibreOffice 可执行文件。"""
    # 直接检查路径
    candidates = [
        "soffice",
        "libreoffice",
        "/usr/bin/soffice",
        "/usr/bin/libreoffice",
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        # Windows
        "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
        "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    ]
    for c in candidates:
        if shutil.which(c) or os.path.exists(c):
            return c if os.path.isabs(c) else shutil.which(c)
    return None


def main():
    import argparse
    parser = argparse.ArgumentParser(description="LibreOffice 格式转换包装器")
    parser.add_argument("--headless", action="store_true", default=True, help="无头模式")
    parser.add_argument("--convert-to", dest="convert_to", help="目标格式（pdf, docx, odt 等）")
    parser.add_argument("input", nargs="?", help="输入文件")
    parser.add_argument("--outdir", dest="outdir", default=None, help="输出目录")
    args, unknown = parser.parse_known_args()

    soffice = find_soffice()
    if not soffice:
        print("错误：未找到 LibreOffice。请安装：")
        print("  macOS:  brew install libreoffice")
        print("  Windows: winget install LibreOffice")
        print("  Linux:  sudo apt install libreoffice")
        sys.exit(1)

    cmd = [soffice, "--headless"]
    if args.convert_to:
        cmd.extend(["--convert-to", args.convert_to])
    if args.outdir:
        cmd.extend(["--outdir", args.outdir])
    if args.input:
        cmd.append(args.input)
    cmd.extend(unknown)

    print(f"执行：{' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

    if result.returncode != 0:
        print(f"⚠️ LibreOffice 返回非零退出码：{result.returncode}")
        if result.stderr:
            print(result.stderr[:500])
    else:
        print("✅ 转换完成")

    if result.stdout:
        print(result.stdout[:500])


if __name__ == "__main__":
    main()
